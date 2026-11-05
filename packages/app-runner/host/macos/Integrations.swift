import AppKit

/// Host side of the Wayland integrations: clipboard both ways, Finder drops and guest URL opens.
/// The compositor applies the guest-side policy (user-activation gates, export roots); this side re-validates
/// everything it receives and never trusts guest paths or URLs.
enum Integrations {
    static let limit = 8 * 1024 * 1024
    static let maxEntries = 100
    static let environment = ProcessInfo.processInfo.environment
    // Selftests use a private named pasteboard and never read or overwrite the user's clipboard.
    static let pasteboard: NSPasteboard = {
        if environment["VSPOD_WINDOW_SELFTEST"] == "1" {
            return NSPasteboard(name: NSPasteboard.Name(environment["VSPOD_PASTEBOARD"] ?? "org.vspod.window-capture.selftest"))
        }
        return .general
    }()
    static var transfers = 0

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func validateImage(_ data: Data) throws {
        guard data.count <= limit,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
              let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
              width > 0, height > 0, width <= 8192, height <= 8192,
              width * height <= 16_777_216 else { throw Failure(message: "Invalid or oversized image (8 MiB / 16 megapixel limit)") }
    }

    /// Reads the pasteboard into a compositor `clipboard` command (files, then images, then text).
    static func clipboardCommand(_ board: NSPasteboard, allowFiles: Bool) throws -> [String: Any] {
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            guard allowFiles else { throw Failure(message: "File transfer disabled by host policy") }
            return ["action": "clipboard", "kind": "files", "entries": try entries(urls)]
        }
        if let png = board.data(forType: .png) {
            try validateImage(png)
            return ["action": "clipboard", "kind": "image", "data": png.base64EncodedString()]
        }
        if let tiff = board.data(forType: .tiff) {
            try validateImage(tiff)
            guard let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
                throw Failure(message: "Image conversion failed")
            }
            try validateImage(png)
            return ["action": "clipboard", "kind": "image", "data": png.base64EncodedString()]
        }
        if let text = board.string(forType: .string) {
            guard text.utf8.count <= limit else { throw Failure(message: "Text exceeds 8 MiB") }
            return ["action": "clipboard", "kind": "text", "text": text]
        }
        throw Failure(message: "Clipboard has no supported text, image or files")
    }

    /// Host files for the guest: directories before their contents, no symlinks or special files.
    static func entries(_ urls: [URL]) throws -> [[String: Any]] {
        var result = [[String: Any]]()
        var total = 0
        var names = Set<String>()
        func append(_ url: URL, _ relative: String) throws {
            guard result.count < maxEntries else { throw Failure(message: "More than \(maxEntries) files") }
            let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey, .fileSizeKey])
            if values.isSymbolicLink == true { throw Failure(message: "Symlinks are not transferred") }
            if values.isDirectory == true {
                result.append(["path": relative, "kind": "directory"])
                let children = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)
                    .sorted { $0.lastPathComponent < $1.lastPathComponent }
                for child in children { try append(child, relative + "/" + child.lastPathComponent) }
            } else if values.isRegularFile == true {
                total += values.fileSize ?? 0
                guard total <= limit else { throw Failure(message: "Files exceed 8 MiB") }
                let data = try Data(contentsOf: url)
                total += data.count - (values.fileSize ?? 0)
                guard total <= limit else { throw Failure(message: "Files exceed 8 MiB") }
                result.append(["path": relative, "kind": "file", "data": data.base64EncodedString()])
            } else { throw Failure(message: "Special files are not transferred") }
        }
        guard !urls.isEmpty, urls.count <= maxEntries, urls.allSatisfy(\.isFileURL) else { throw Failure(message: "Invalid file selection") }
        for url in urls {
            let name = url.standardizedFileURL.lastPathComponent
            guard safeName(name), names.insert(name).inserted else { throw Failure(message: "Invalid or duplicate file name") }
            try append(url.standardizedFileURL, name)
        }
        return result
    }

    static func safeName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.contains("/") && !name.contains("\0") && name.utf8.count <= 255
    }

    /// Writes a guest clipboard message to the pasteboard; guest files land in a fresh private directory.
    static func receiveClipboard(_ header: [String: Any], _ payload: Data, root: String) throws -> String {
        let board = pasteboard
        switch header["kind"] as? String {
        case "text":
            guard payload.count <= limit, let text = String(data: payload, encoding: .utf8) else { throw Failure(message: "Invalid guest text") }
            board.clearContents()
            guard board.setString(text, forType: .string) else { throw Failure(message: "Pasteboard write failed") }
            return "text bytes=\(payload.count)"
        case "image":
            try validateImage(payload)
            board.clearContents()
            guard board.setData(payload, forType: .png) else { throw Failure(message: "Pasteboard write failed") }
            return "image bytes=\(payload.count)"
        case "files":
            guard payload.count <= limit, let entries = header["entries"] as? [[String: Any]],
                  !entries.isEmpty, entries.count <= maxEntries else { throw Failure(message: "Invalid guest file list") }
            transfers += 1
            let base = URL(fileURLWithPath: root).appendingPathComponent("transfers/\(transfers)", isDirectory: true)
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var offset = 0
            var top = [URL]()
            for entry in entries {
                guard let path = entry["path"] as? String, path.utf8.count <= 1024 else { throw Failure(message: "Invalid guest path") }
                let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
                guard parts.allSatisfy(safeName) else { throw Failure(message: "Unsafe guest path") }
                let url = parts.reduce(base) { $0.appendingPathComponent($1) }
                switch entry["kind"] as? String {
                case "directory":
                    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                case "file":
                    guard let bytes = entry["bytes"] as? Int, bytes >= 0, offset + bytes <= payload.count else {
                        throw Failure(message: "Guest file exceeds payload")
                    }
                    try payload.subdata(in: offset..<offset + bytes).write(to: url, options: .withoutOverwriting)
                    offset += bytes
                default: throw Failure(message: "Invalid guest entry kind")
                }
                if parts.count == 1 { top.append(url) }
            }
            guard offset == payload.count else { throw Failure(message: "Guest payload has trailing data") }
            board.clearContents()
            guard board.writeObjects(top.map { $0 as NSURL }) else { throw Failure(message: "Pasteboard write failed") }
            return "files entries=\(entries.count) bytes=\(payload.count)"
        default: throw Failure(message: "Unsupported guest clipboard kind")
        }
    }

    /// Guest URLs open in the macOS browser only as plain http(s) links to non-loopback hosts: container ports
    /// are not forwarded, so a loopback URL would reach a host service instead of the guest.
    static func openableURL(_ text: String) -> URL? {
        guard text.utf8.count <= 2048, !text.contains(where: { $0.isWhitespace || $0.isNewline }),
              let components = URLComponents(string: text), let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme), components.user == nil, components.password == nil,
              let host = components.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
              !host.isEmpty, let url = components.url else { return nil }
        let loopback = host == "localhost" || host.hasSuffix(".localhost") || host.hasPrefix("127.")
            || host == "::1" || host == "0.0.0.0" || host == "::" || host.hasPrefix("0:0:0:0:0:0:0:")
        return loopback ? nil : url
    }

    /// Selftest helpers: fill or dump the private pasteboard.
    static func writeTestPasteboard(_ request: [String: Any]) throws {
        let board = pasteboard
        board.clearContents()
        switch request["kind"] as? String {
        case "text":
            guard let text = request["text"] as? String, board.setString(text, forType: .string) else { throw Failure(message: "Invalid test text") }
        case "image":
            guard let encoded = request["data"] as? String, let data = Data(base64Encoded: encoded),
                  board.setData(data, forType: .png) else { throw Failure(message: "Invalid test image") }
        case "files":
            guard let paths = request["paths"] as? [String], board.writeObjects(paths.map { NSURL(fileURLWithPath: $0) }) else {
                throw Failure(message: "Invalid test files")
            }
        default: throw Failure(message: "Invalid test pasteboard kind")
        }
    }

    static func dumpTestPasteboard() -> [String: Any] {
        let board = pasteboard
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return ["kind": "files", "paths": urls.map(\.path)]
        }
        if let png = board.data(forType: .png) { return ["kind": "image", "data": png.base64EncodedString()] }
        if let text = board.string(forType: .string) { return ["kind": "text", "text": text] }
        return ["kind": "empty"]
    }
}
