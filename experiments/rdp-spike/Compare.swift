import AppKit

func pixels(_ path: String) throws -> (Int, Int, [UInt8]) {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let bitmap = NSBitmapImageRep(data: data), let image = bitmap.cgImage else {
        throw NSError(domain: "Cannot decode image: \(path)", code: 1)
    }
    let width = image.width
    let height = image.height
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    try bytes.withUnsafeMutableBytes { buffer in
        guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                                      bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw NSError(domain: "Cannot create comparison bitmap", code: 2)
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return (width, height, bytes)
}

do {
    guard CommandLine.arguments.count == 3 else {
        throw NSError(domain: "Usage: compare native.png server.png", code: 3)
    }
    let (width, height, native) = try pixels(CommandLine.arguments[1])
    let (otherWidth, otherHeight, server) = try pixels(CommandLine.arguments[2])
    guard width == otherWidth, height == otherHeight else {
        throw NSError(domain: "Native and server dimensions differ", code: 4)
    }
    var different = 0
    for pixel in 0..<(width * height) {
        if (0..<3).contains(where: { abs(Int(native[pixel * 4 + $0]) - Int(server[pixel * 4 + $0])) > 3 }) {
            different += 1
        }
    }
    let fraction = Double(different) / Double(width * height)
    print("RDP pixel comparison: \(different)/\(width * height) differ >3/255 (\(fraction * 100)%)")
    guard fraction <= 0.005 else {
        throw NSError(domain: "RDP image differs from server by more than 0.5%", code: 5)
    }
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
