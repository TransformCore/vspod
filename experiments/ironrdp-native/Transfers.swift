import AppKit
import ImageIO

final class TransferBridge {
    let queue = DispatchQueue(label: "org.vspod.iron-transfers")
    let environment = ProcessInfo.processInfo.environment
    let limit = 8 * 1024 * 1024
    var process: Process?
    var stopped = false
    let lock = NSLock()

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        stopped = true
        if let process, process.isRunning { process.terminate() }
    }

    func call(_ request: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        queue.async {
            let result = Result { () throws -> [String: Any] in
                guard let node = self.environment["VSPOD_TRANSFER_NODE"],
                      let script = self.environment["VSPOD_TRANSFER_SCRIPT"],
                      let container = self.environment["VSPOD_TRANSFER_CONTAINER"],
                      let root = self.environment["VSPOD_TRANSFER_ROOT"] else {
                    throw self.error("Transfer session is not configured")
                }
                let data = try JSONSerialization.data(withJSONObject: request)
                guard data.count <= 24 * 1024 * 1024 else { throw self.error("Transfer exceeds wire limit") }
                let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
                process.executableURL = URL(fileURLWithPath: node)
                process.arguments = [script, container, root]
                process.standardInput = input
                process.standardOutput = output
                process.standardError = errors
                self.lock.lock()
                if self.stopped { self.lock.unlock(); throw self.error("Transfer session closed") }
                do { try process.run() }
                catch { self.lock.unlock(); throw error }
                self.process = process
                self.lock.unlock()
                let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
                defer {
                    timeout.cancel()
                    if process.isRunning { process.terminate() }
                    self.lock.lock()
                    self.process = nil
                    self.lock.unlock()
                }
                try input.fileHandleForWriting.write(contentsOf: data)
                try input.fileHandleForWriting.close()
                var response = Data()
                while let chunk = try output.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
                    response.append(chunk)
                    if response.count > 24 * 1024 * 1024 {
                        process.terminate()
                        throw self.error("Transfer response exceeds limit")
                    }
                }
                process.waitUntilExit()
                let stderr = errors.fileHandleForReading.readDataToEndOfFile()
                guard process.terminationStatus == 0 else {
                    throw self.error(String(data: stderr, encoding: .utf8) ?? "Transfer process failed")
                }
                guard let value = try JSONSerialization.jsonObject(with: response) as? [String: Any] else {
                    throw self.error("Invalid transfer response")
                }
                return value
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func error(_ message: String) -> NSError { NSError(domain: "VSPod transfer", code: 1,
        userInfo: [NSLocalizedDescriptionKey: message]) }

    func validateImage(_ data: Data) throws {
        guard data.count <= limit,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
              let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
              width > 0, height > 0, width <= 8192, height <= 8192,
              width * height <= 16_777_216 else { throw error("Invalid or oversized image (8 MiB / 16 megapixel limit)") }
    }

    func read(_ board: NSPasteboard) throws -> [String: Any] {
        if let urls = board.readObjects(forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            guard urls.count <= 100, urls.allSatisfy(\.isFileURL) else { throw error("Invalid file selection") }
            return ["kind": "files", "paths": urls.map(\.path)]
        }
        if let original = board.data(forType: .png) {
            try validateImage(original)
            return ["kind": "image", "data": original.base64EncodedString()]
        }
        if let original = board.data(forType: .tiff) {
            try validateImage(original)
            guard let bitmap = NSBitmapImageRep(data: original),
                  let data = bitmap.representation(using: .png, properties: [:]) else { throw error("Image conversion failed") }
            try validateImage(data)
            return ["kind": "image", "data": data.base64EncodedString()]
        }
        if let text = board.string(forType: .string) {
            guard text.utf8.count <= limit else { throw error("Text exceeds 8 MiB") }
            return ["kind": "text", "data": text]
        }
        throw error("Clipboard has no supported text, image or files")
    }

    func write(_ value: [String: Any], to board: NSPasteboard) throws {
        switch value["kind"] as? String {
        case "text":
            guard let text = value["data"] as? String, text.utf8.count <= limit else { throw error("Invalid guest text") }
            board.clearContents()
            guard board.setString(text, forType: .string) else { throw error("Host clipboard write failed") }
        case "image":
            guard let encoded = value["data"] as? String, let data = Data(base64Encoded: encoded),
                  data.count <= limit else { throw error("Invalid guest image") }
            try validateImage(data)
            board.clearContents()
            guard board.setData(data, forType: .png) else { throw error("Host image clipboard write failed") }
        case "files":
            guard let paths = value["paths"] as? [String], !paths.isEmpty, paths.count <= 100,
                  let root = environment["VSPOD_TRANSFER_ROOT"],
                  paths.allSatisfy({ $0.hasPrefix(root + "/") && !$0.contains("/../") }) else {
                throw error("Invalid guest file export")
            }
            board.clearContents()
            guard board.writeObjects(paths.map { NSURL(fileURLWithPath: $0) }) else { throw error("Host file clipboard write failed") }
        default: throw error("Unsupported guest clipboard response")
        }
    }
}
