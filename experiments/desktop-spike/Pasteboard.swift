import AppKit

struct Request: Decodable {
    let board: String
    let action: String
    let kind: String?
    let data: String?
    let paths: [String]?
}

func fail(_ message: String) throws -> Never {
    throw NSError(domain: message, code: 1)
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 24 * 1024 * 1024 else { try fail("Pasteboard request exceeds limit") }
    let request = try JSONDecoder().decode(Request.self, from: input)
    guard request.board.range(of: "^org\\.vspod\\.clipboard-spike\\.[a-f0-9-]+$", options: .regularExpression) != nil else {
        try fail("Only isolated test pasteboards are allowed")
    }
    let board = NSPasteboard(name: NSPasteboard.Name(request.board))
    var result: [String: Any] = [:]
    switch request.action {
    case "write":
        switch request.kind {
        case "text":
            guard let text = request.data else { try fail("Missing text") }
            board.clearContents()
            guard board.setString(text, forType: .string) else { try fail("Text write failed") }
        case "image", "image-tiff":
            guard let encoded = request.data, let data = Data(base64Encoded: encoded),
                  data.count <= 8 * 1024 * 1024, NSBitmapImageRep(data: data) != nil else {
                try fail("Invalid or oversized image")
            }
            board.clearContents()
            if request.kind == "image-tiff" {
                guard let bitmap = NSBitmapImageRep(data: data),
                      let tiff = bitmap.tiffRepresentation,
                      board.setData(tiff, forType: .tiff) else { try fail("TIFF write failed") }
            } else {
                guard board.setData(data, forType: .png) else { try fail("Image write failed") }
            }
        case "files":
            guard let paths = request.paths, !paths.isEmpty, paths.count <= 100,
                  paths.allSatisfy({ $0.hasPrefix("/") }) else { try fail("Invalid file URLs") }
            board.clearContents()
            guard board.writeObjects(paths.map { NSURL(fileURLWithPath: $0) }) else { try fail("File URL write failed") }
        default: try fail("Unsupported pasteboard format")
        }
        result = ["written": true]
    case "read":
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            result = ["kind": "files", "paths": urls.map(\.path)]
        } else if let png = board.data(forType: .png) ?? board.data(forType: .tiff).flatMap({
            NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:])
        }) {
            guard png.count <= 8 * 1024 * 1024 else { try fail("Image exceeds limit") }
            result = ["kind": "image", "data": png.base64EncodedString()]
        } else if let text = board.string(forType: .string) {
            guard text.utf8.count <= 8 * 1024 * 1024 else { try fail("Text exceeds limit") }
            result = ["kind": "text", "data": text]
        } else { try fail("No supported clipboard content") }
    case "fixture":
        let size = request.kind == "large" ? 512 : 2
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                           isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: size * 4, bitsPerPixel: 32) else {
            try fail("Image fixture allocation failed")
        }
        bitmap.setColor(.red, atX: 0, y: 0)
        bitmap.setColor(.green, atX: 1, y: 0)
        bitmap.setColor(.blue, atX: 0, y: 1)
        bitmap.setColor(.clear, atX: 1, y: 1)
        if size > 2, let pixels = bitmap.bitmapData {
            var value: UInt32 = 42
            for index in 0..<(size * size * 4) {
                value = value &* 1664525 &+ 1013904223
                pixels[index] = index % 4 == 3 ? 255 : UInt8(truncatingIfNeeded: value >> 24)
            }
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else { try fail("PNG encoding failed") }
        result = ["kind": "image", "data": png.base64EncodedString()]
    case "inspect":
        guard let encoded = request.data, let data = Data(base64Encoded: encoded),
              let bitmap = NSBitmapImageRep(data: data),
              bitmap.pixelsWide == 2, bitmap.pixelsHigh == 2 else { try fail("Expected 2x2 image fixture") }
        var pixels: [Int] = []
        for y in 0..<2 {
            for x in 0..<2 {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else {
                    try fail("Image color conversion failed")
                }
                pixels.append(contentsOf: [color.redComponent, color.greenComponent, color.blueComponent, color.alphaComponent].map { Int(($0 * 255).rounded()) })
            }
        }
        result = ["pixels": pixels]
    case "clear":
        board.releaseGlobally()
        result = ["cleared": true]
    default: try fail("Unsupported pasteboard operation")
    }
    let output = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(output)
} catch {
    fputs("Clipboard test helper failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
