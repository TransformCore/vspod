import AppKit

extension NativeView {
    func runTransferSelftest() {
        Task { @MainActor in
            do {
                try await transferAcceptance()
                log("IRON_TRANSFERS_PASS")
                window?.performClose(nil)
            } catch { fail("Transfer acceptance: \(error.localizedDescription)") }
        }
    }

    @MainActor
    func transferAcceptance() async throws {
        guard let window, let fixture = ProcessInfo.processInfo.environment["VSPOD_IRON_TRANSFER_FIXTURE"],
              ProcessInfo.processInfo.environment["VSPOD_IRON_TEST_BOARD"] != nil else {
            throw transfers.error("Missing isolated transfer fixtures")
        }
        let board = clipboard
        defer { board.releaseGlobally() }
        func pause(_ seconds: Double = 1) async throws {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
        func key(_ code: UInt16, _ flags: NSEvent.ModifierFlags = []) {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "",
                charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)!
            keyDown(with: event)
            keyUp(with: event)
            modifiers([])
        }
        func completed(_ body: () -> Void) async throws {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                transferCompletion = { continuation.resume(with: $0) }
                body()
            }
        }
        func putText(_ text: String) throws {
            board.clearContents()
            guard board.setString(text, forType: .string) else { throw transfers.error("Fixture pasteboard write") }
        }
        func open(_ path: String) async throws {
            key(35, .command)
            try await pause()
            try putText(path)
            try await completed { key(9, .command) }
            try await pause()
            key(36)
            try await pause(1)
        }
        func copy() async throws { try await completed { key(8, .command) } }
        func paste() async throws { try await completed { key(9, .command) } }
        try await pause(2)
        let point = NSPoint(x: 450, y: bounds.height - 130)
        let click = NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
            clickCount: 1, pressure: 1)!
        mouseDown(with: click); mouseUp(with: click)
        try await pause()
        let text = "Clipboard café 日本語 😀\n\tcolumns\n\nlast line\n"
        key(0, .command)
        try await pause()
        try putText(text)
        try await paste()
        try await pause(2)
        key(1, .command)
        try await pause()
        key(0, .command)
        try await pause()
        try await copy()
        guard board.string(forType: .string) == text else {
            throw transfers.error("Unicode editor roundtrip changed bytes")
        }
        log("IRON_TRANSFER_TEXT_PASS")

        let longText = String(repeating: "Large 日本語\tcolumn\n\n", count: 5000)
        try putText(longText)
        try await paste()
        try await pause(3)
        key(0, .command)
        try await pause()
        try await copy()
        guard board.string(forType: .string) == longText else {
            throw transfers.error("Large editor clipboard truncated")
        }
        log("IRON_TRANSFER_LARGE_TEXT_PASS")
        key(0, .command)
        try await pause()
        try putText(text)
        try await paste()
        try await pause(2)
        key(1, .command)

        try await open("/tmp/workspace/clipboard.md")
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bitmapFormat: .alphaNonpremultiplied,
            bytesPerRow: 8, bitsPerPixel: 32),
              let bitmapBytes = bitmap.bitmapData else { throw transfers.error("Image fixture") }
        let rgba: [UInt8] = [255,0,0,255, 0,255,0,255, 0,0,255,255, 0,0,0,0]
        _ = rgba.withUnsafeBytes { bytes in memcpy(bitmapBytes, bytes.baseAddress!, rgba.count) }
        guard let tagged = bitmap.retagging(with: .sRGB),
              let png = tagged.representation(using: .png, properties: [:]),
              let tiff = tagged.tiffRepresentation,
              let expectedBitmap = NSBitmapImageRep(data: png) else { throw transfers.error("Image fixture encoding") }
        try png.write(to: URL(fileURLWithPath: fixture + "/fixture.png"))
        board.clearContents()
        guard board.setData(tiff, forType: .tiff) else { throw transfers.error("TIFF fixture write") }
        try await pause(2)
        try await paste()
        try await pause(2)
        key(1, .command)
        log("IRON_TRANSFER_MARKDOWN_IMAGE_PASTED")

        // Paste a known PNG file into Explorer, then use its real image preview for outbound copy.
        key(14, [.command, .shift])
        try await pause()
        board.clearContents()
        guard board.writeObjects([NSURL(fileURLWithPath: fixture + "/fixture.png")]) else { throw transfers.error("File fixture write") }
        try await paste()
        try await pause(1)
        try await open("/tmp/workspace/fixture.png")
        try await pause(2)
        mouseDown(with: click); mouseUp(with: click)
        try await pause()
        try await copy()
        guard let copiedPNG = board.data(forType: .png), let copiedBitmap = NSBitmapImageRep(data: copiedPNG),
              copiedBitmap.pixelsWide == 2, copiedBitmap.pixelsHigh == 2 else { throw transfers.error("Guest image copy failed") }
        for y in 0..<2 {
            for x in 0..<2 {
                guard let actual = copiedBitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB),
                      let expected = expectedBitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else {
                    throw transfers.error("Image fixture color conversion failed")
                }
                for difference in [actual.redComponent - expected.redComponent,
                    actual.greenComponent - expected.greenComponent,
                    actual.blueComponent - expected.blueComponent,
                    actual.alphaComponent - expected.alphaComponent] {
                    guard abs(difference) < 1.0 / 255 else { throw transfers.error("Guest image copy pixels changed") }
                }
            }
        }
        log("IRON_TRANSFER_IMAGE_ROUNDTRIP_PASS")

        key(14, [.command, .shift])
        try await pause()
        board.clearContents()
        let hostPaths = [fixture + "/single.txt", fixture + "/folder"]
        guard board.writeObjects(hostPaths.map { NSURL(fileURLWithPath: $0) }) else { throw transfers.error("File fixtures write") }
        try await paste()
        try await pause()
        key(36)
        try await pause(2)
        let fileClick = NSEvent.mouseEvent(with: .leftMouseDown,
            location: NSPoint(x: 120, y: bounds.height - 240), modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 1, clickCount: 1, pressure: 1)!
        mouseDown(with: fileClick); mouseUp(with: fileClick)
        try await pause()
        try await copy()
        let copied = try transfers.read(board)
        guard copied["kind"] as? String == "files", let copiedPaths = copied["paths"] as? [String],
              copiedPaths.count == 1, let exported = copiedPaths.first, exported.hasSuffix("/single.txt"),
              try String(contentsOfFile: exported, encoding: .utf8) == "host file bytes\n" else {
            throw transfers.error("Explorer-to-host file copy failed")
        }
        log("IRON_TRANSFER_FILE_ROUNDTRIP_PASS")

        key(14, [.command, .shift])
        try await pause()
        board.clearContents()
        guard board.writeObjects([NSURL(fileURLWithPath: fixture + "/drop.txt"),
                                  NSURL(fileURLWithPath: fixture + "/drop-folder")]) else {
            throw transfers.error("Drop fixtures write")
        }
        let dropPoint = NSPoint(x: 150, y: bounds.height - 130)
        guard !dropFiles(board, at: dropPoint, operation: .move),
              !dropFiles(board, at: NSPoint(x: -1, y: -1), operation: .copy) else {
            throw transfers.error("Unsafe native drop accepted")
        }
        try await completed {
            guard dropFiles(board, at: dropPoint, operation: .copy) else { fail("Native Explorer drop rejected") }
        }
        try await pause()

        key(50, .command)
        try await pause(2)
        try putText("touch /tmp/clipboard-executed; printf 'first\\tcolumn\\n\\nlast line\\n'\n# clipboard second line")
        try await completed { key(9, [.command, .shift]) }
        try await pause()
        log("IRON_TRANSFER_TERMINAL_PENDING")
        for attempt in 0..<100 {
            if FileManager.default.fileExists(atPath: fixture + "/terminal-paste-checked") { break }
            if attempt == 99 { throw transfers.error("Terminal safety assertion was not acknowledged") }
            try await pause(0.1)
        }
        key(36)
        try await pause()
        key(36)
        try await pause()
        key(35, [.command, .shift])
        try await pause()
        try putText("Terminal: Select All")
        try await paste()
        try await pause()
        key(36)
        try await pause()
        try await completed { key(8, [.command, .shift]) }
        guard let terminalText = board.string(forType: .string),
              terminalText.range(of: "first\\s+column", options: .regularExpression) != nil,
              terminalText.contains("\n\n"), terminalText.contains("last line") else {
            throw transfers.error("Multiline terminal output changed")
        }
        log("IRON_TRANSFER_TERMINAL_PASS")
        key(50, .command)
        try await pause()

        try putText("host clipboard remains private")
        try await pause()
        guard board.string(forType: .string) == "host clipboard remains private" else {
            throw transfers.error("Clipboard mirrored without an explicit action")
        }
        board.clearContents()
        let unsupported = NSPasteboard.PasteboardType("org.vspod.unsupported")
        guard board.setString("preserve on failure", forType: unsupported) else {
            throw transfers.error("Unsupported fixture write")
        }
        var rejected = false
        do { try await paste() } catch { rejected = true }
        guard rejected, board.string(forType: unsupported) == "preserve on failure" else {
            throw transfers.error("Unsupported clipboard was accepted or changed on failure")
        }

        try await open("/tmp/workspace/rdp.txt")
        board.clearContents()
        guard board.writeObjects([NSURL(fileURLWithPath: fixture + "/drop.txt")]) else {
            throw transfers.error("Editor drop fixture write")
        }
        try await completed {
            guard dropFiles(board, at: NSPoint(x: 550, y: bounds.height - 200), operation: .copy) else {
                fail("Native editor drop rejected")
            }
        }
        log("IRON_TRANSFER_DROP_PASS")
    }
}
