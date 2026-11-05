import AppKit

let interactive = ProcessInfo.processInfo.environment["VSPOD_RDP_INTERACTIVE"] != nil

func sendInput(_ command: String) {
    FileHandle.standardOutput.write(Data((command + "\n").utf8))
}

@main
struct DesktopHost {
    static func main() { runHost() }
}

func runHost() {
guard CommandLine.arguments.count == 4 else {
    fatalError("Usage: host frame.ppm snapshot.png seconds")
}
let frame = CommandLine.arguments[1]
let snapshot = CommandLine.arguments[2]
let duration = Double(CommandLine.arguments[3])!
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
                      styleMask: [.titled, .closable, .resizable],
                      backing: .buffered, defer: false)
window.title = interactive ? "VSPod RDP playground - disposable workspace" : "VSPod - native RDP spike"
window.isReleasedWhenClosed = false
window.contentMinSize = NSSize(width: 400, height: 300)
let imageView = InputView()
imageView.sendInput = sendInput
imageView.imageScaling = .scaleAxesIndependently
window.contentView = imageView
if interactive {
    window.delegate = imageView
    window.acceptsMouseMovedEvents = true
}
window.center()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
if interactive { window.makeFirstResponder(imageView) }
var latest: CGImage?
var lastModified: Date?
Timer.scheduledTimer(withTimeInterval: interactive ? 1.0 / 60 : 0.1, repeats: true) { _ in
    guard FileManager.default.fileExists(atPath: frame) else { return }
    do {
        let modified = try FileManager.default.attributesOfItem(atPath: frame)[.modificationDate] as? Date
        if modified == lastModified { return }
        lastModified = modified
        let data = try Data(contentsOf: URL(fileURLWithPath: frame))
        var offset = data.startIndex
        var lines: [String] = []
        for _ in 0..<3 {
            guard let end = data[offset...].firstIndex(of: 10),
                  let line = String(data: data[offset..<end], encoding: .ascii) else {
                throw NSError(domain: "Invalid PPM header", code: 1)
            }
            lines.append(line)
            offset = end + 1
        }
        let dimensions = lines[1].split(separator: " ").compactMap { Int($0) }
        guard lines[0] == "P6", lines[2] == "255", dimensions.count == 2,
              dimensions[0] > 0, dimensions[0] <= 4096,
              dimensions[1] > 0, dimensions[1] <= 4096,
              data.count - offset == dimensions[0] * dimensions[1] * 3,
              let provider = CGDataProvider(data: data[offset...] as CFData),
              let image = CGImage(width: dimensions[0], height: dimensions[1],
                                  bitsPerComponent: 8, bitsPerPixel: 24,
                                  bytesPerRow: dimensions[0] * 3,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGBitmapInfo(rawValue: 0),
                                  provider: provider, decode: nil,
                                  shouldInterpolate: false, intent: .defaultIntent) else {
            throw NSError(domain: "Invalid PPM frame", code: 2)
        }
        latest = image
        imageView.remoteWidth = image.width
        imageView.remoteHeight = image.height
        let size = NSSize(width: image.width, height: image.height)
        if !interactive && window.contentView!.bounds.size != size { window.setContentSize(size) }
        imageView.image = NSImage(cgImage: image, size: size)
    } catch {
        fputs("RDP viewer: \(error)\n", stderr)
        exit(1)
    }
}
if !interactive {
Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { _ in
    guard let image = latest,
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        exit(1)
    }
    do {
        try png.write(to: URL(fileURLWithPath: snapshot), options: .atomic)
        exit(0)
    } catch {
        fputs("RDP snapshot: \(error)\n", stderr)
        exit(1)
    }
}
}
if interactive && ProcessInfo.processInfo.environment["VSPOD_RDP_SELFTEST"] != nil {
    func key(_ code: UInt16, _ characters: String, _ flags: NSEvent.ModifierFlags = []) {
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                                    timestamp: 0, windowNumber: window.windowNumber,
                                    context: nil, characters: characters,
                                    charactersIgnoringModifiers: characters,
                                    isARepeat: false, keyCode: code)!
        imageView.keyDown(with: event)
        imageView.keyUp(with: event)
        imageView.modifiers([])
    }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { _ in
        let location = NSPoint(x: 450, y: window.contentView!.bounds.height - 130)
        let click = NSEvent.mouseEvent(with: .leftMouseDown, location: location, modifierFlags: [],
                                      timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                      eventNumber: 1, clickCount: 1, pressure: 1)!
        imageView.mouseDown(with: click)
        imageView.mouseUp(with: click)
    }
    Timer.scheduledTimer(withTimeInterval: 5.5, repeats: false) { _ in
        key(0, "a", .command)
    }
    Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { _ in
        func type(_ text: String) {
            let letters: [Character: UInt16] = [
                "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
                "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
                "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
                "j": 38, "k": 40, "n": 45, "m": 46, " ": 49
            ]
            for character in text {
                let lower = Character(String(character).lowercased())
                key(letters[lower]!, String(character), character.isUppercase ? .shift : [])
            }
        }
        type("Native RDP input verified")
        key(36, "\r")
        type("Second line")
    }
    Timer.scheduledTimer(withTimeInterval: 7.5, repeats: false) { _ in
        key(1, "s", .command)
    }
    Timer.scheduledTimer(withTimeInterval: 8.5, repeats: false) { _ in
        window.setContentSize(NSSize(width: 1000, height: 680))
    }
    Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in
        window.performClose(nil)
    }
}
app.run()
}
