import AppKit
import MetalKit

func log(_ message: String) {
    print(message)
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    fputs("IronRDP native: \(message)\n", stderr)
    exit(1)
}

final class WakeGate {
    private let lock = NSLock()
    private var pending = false
    func schedule(_ body: @escaping () -> Void) {
        lock.lock()
        if pending { lock.unlock(); return }
        pending = true
        lock.unlock()
        DispatchQueue.main.async {
            self.lock.lock()
            self.pending = false
            self.lock.unlock()
            body()
        }
    }
}

final class NativeView: InputView, MTKViewDelegate {
    let metal: MTKView
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState
    let wake = WakeGate()
    let transfers = TransferBridge()
    var transferBusy = false
    var interceptedKeys = Set<UInt16>()
    var transferCompletion: ((Result<Void, Error>) -> Void)?
    var clipboard: NSPasteboard {
        if ProcessInfo.processInfo.environment["VSPOD_IRON_TRANSFER_SELFTEST"] == "1" {
            guard let name = ProcessInfo.processInfo.environment["VSPOD_IRON_TEST_BOARD"],
                  name.range(of: "^org\\.vspod\\.clipboard-spike\\.[a-f0-9-]+$", options: .regularExpression) != nil else {
                fail("Transfer selftest requires an isolated named pasteboard")
            }
            return NSPasteboard(name: NSPasteboard.Name(name))
        }
        return .general
    }
    var handle: UnsafeMutableRawPointer?
    var texture: MTLTexture?
    var buffers: [MTLBuffer] = []
    var busy = [false, false, false]
    var bufferIndex = 0
    var upload: (Int, Int, Int, Int, Int, Int, UInt64)?
    var ages: [Double] = []
    var completions: [Double] = []
    var inputUpdates: [Double] = []
    var pendingInput: Double?
    var submitted = 0
    var firstFrame = true
    var stopping = false
    var snapshotPath: String?
    var remoteCursor = NSCursor.arrow
    var cursorUpdates = 0
    var cursorSignatures = Set<Data>()
    var terminalSample: Data?
    var terminalSampling = false
    var terminalChangedFrames = 0
    let selftest = ProcessInfo.processInfo.environment["VSPOD_IRON_SELFTEST"] == "1"

    init() {
        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { fail("Metal is unavailable") }
        self.queue = queue
        metal = MTKView(frame: .zero, device: device)
        let shader = """
        #include <metal_stdlib>
        using namespace metal;
        struct Vertex { float4 position [[position]]; float2 uv; };
        vertex Vertex vertex_main(uint id [[vertex_id]]) {
            const float2 p[] = {float2(-1,-1),float2(1,-1),float2(-1,1),float2(1,1)};
            Vertex v; v.position=float4(p[id],0,1);
            v.uv=float2((p[id].x+1)*0.5,(1-p[id].y)*0.5); return v;
        }
        fragment float4 fragment_main(Vertex v [[stage_in]], texture2d<float> image [[texture(0)]]) {
            constexpr sampler s(coord::normalized, address::clamp_to_edge, filter::nearest);
            return float4(image.sample(s,v.uv).rgb,1);
        }
        """
        do {
            let library = try device.makeLibrary(source: shader, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "vertex_main")
            descriptor.fragmentFunction = library.makeFunction(name: "fragment_main")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch { fail("Metal pipeline: \(error)") }
        super.init(frame: .zero)
        automatedInputOnly = selftest || ProcessInfo.processInfo.environment["VSPOD_IRON_TRANSFER_SELFTEST"] == "1"
        sendInput = { [weak self] command in self?.command(command) }
        registerForDraggedTypes([.fileURL])
        metal.isPaused = true
        metal.enableSetNeedsDisplay = true
        metal.framebufferOnly = false
        metal.autoResizeDrawable = false
        metal.colorPixelFormat = .bgra8Unorm
        metal.clearColor = MTLClearColorMake(0.08, 0.08, 0.08, 1)
        metal.autoresizingMask = [.width, .height]
        metal.delegate = self
        addSubview(metal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
    override func hitTest(_ point: NSPoint) -> NSView? { self }
    override func keyDown(with event: NSEvent) {
        guard acceptsInput(event) else { return }
        if event.modifierFlags.contains(.command), [8, 9].contains(event.keyCode) {
            interceptedKeys.insert(event.keyCode)
            let shifted = event.modifierFlags.contains(.shift)
            if event.keyCode == 8 { copyFromGuest(shifted: shifted) }
            else { pasteToGuest(shifted: shifted) }
            return
        }
        if transferBusy { NSSound.beep(); return }
        super.keyDown(with: event)
    }
    override func keyUp(with event: NSEvent) {
        if interceptedKeys.remove(event.keyCode) != nil { return }
        super.keyUp(with: event)
    }

    func guestShortcut(_ code: UInt16, shifted: Bool = false) {
        modifiers([])
        modifiers(shifted ? [.control, .shift] : [.control])
        scan(code, down: true)
        scan(code, down: false)
        modifiers([])
    }

    func beginTransfer() -> Bool {
        guard !stopping, !transferBusy else { NSSound.beep(); return false }
        transferBusy = true
        window?.subtitle = "Transferring..."
        modifiers([])
        return true
    }

    func finishTransfer(_ result: Result<Void, Error>) {
        transferBusy = false
        window?.subtitle = ""
        guard !stopping else { return }
        if let completion = transferCompletion { transferCompletion = nil; completion(result); return }
        if case .failure(let error) = result {
            let alert = NSAlert()
            alert.messageText = "Transfer failed"
            alert.informativeText = error.localizedDescription
            if let window { alert.beginSheetModal(for: window) }
            else { alert.runModal() }
        }
    }

    @objc func copyClipboard(_ sender: Any?) { copyFromGuest(shifted: false) }
    @objc func pasteClipboard(_ sender: Any?) { pasteToGuest(shifted: false) }
    @objc func copyTerminalClipboard(_ sender: Any?) { copyFromGuest(shifted: true) }
    @objc func pasteTerminalClipboard(_ sender: Any?) { pasteToGuest(shifted: true) }

    func pasteToGuest(shifted: Bool) {
        guard beginTransfer() else { return }
        do {
            let payload = try transfers.read(clipboard)
            transfers.call(["action": "paste", "payload": payload]) { [weak self] result in
                guard let self, !self.stopping else { return }
                switch result {
                case .success:
                    self.guestShortcut(0x2f, shifted: shifted)
                    self.finishTransfer(.success(()))
                case .failure(let error): self.finishTransfer(.failure(error))
                }
            }
        } catch { finishTransfer(.failure(error)) }
    }

    func copyFromGuest(shifted: Bool) {
        guard beginTransfer() else { return }
        let board = clipboard
        let changeCount = board.changeCount
        transfers.call(["action": "prepareCopy"]) { [weak self] prepared in
            guard let self, !self.stopping else { return }
            switch prepared {
            case .failure(let error): self.finishTransfer(.failure(error))
            case .success(let value):
                guard let marker = value["marker"] as? String else {
                    self.finishTransfer(.failure(self.transfers.error("Missing guest copy marker"))); return
                }
                self.guestShortcut(0x2e, shifted: shifted)
                self.transfers.call(["action": "copy", "marker": marker]) { [weak self] result in
                    guard let self, !self.stopping else { return }
                    do {
                        let copied = try result.get()
                        guard board.changeCount == changeCount else {
                            throw self.transfers.error("Host clipboard changed during copy; it was not overwritten")
                        }
                        try self.transfers.write(copied, to: board)
                        self.finishTransfer(.success(()))
                    } catch { self.finishTransfer(.failure(error)) }
                }
            }
        }
    }

    func dropFiles(_ board: NSPasteboard, at point: NSPoint, operation: NSDragOperation) -> Bool {
        guard !transferBusy, !stopping, operation.contains(.copy), bounds.contains(point),
              let urls = board.readObjects(forClasses: [NSURL.self],
                options: [.urlReadingFileURLsOnly: true]) as? [URL],
              !urls.isEmpty, urls.count <= 100, urls.allSatisfy(\.isFileURL),
              beginTransfer() else { return false }
        let x = min(remoteWidth - 1, Int(point.x * Double(remoteWidth) / max(1, bounds.width)))
        let y = min(remoteHeight - 1, Int((bounds.height - point.y) * Double(remoteHeight) / max(1, bounds.height)))
        transfers.call(["action": "drop", "paths": urls.map(\.path), "x": x, "y": y]) { [weak self] result in
            self?.finishTransfer(result.map { _ in () })
        }
        return true
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard !transferBusy, !stopping, sender.draggingSourceOperationMask.contains(.copy),
              sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self],
                options: [.urlReadingFileURLsOnly: true]) else { return [] }
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { draggingEntered(sender) }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { draggingEntered(sender) == .copy }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        dropFiles(sender.draggingPasteboard, at: convert(sender.draggingLocation, from: nil),
                  operation: sender.draggingSourceOperationMask)
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: remoteCursor) }
    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        remoteCursor.set()
    }
    override func layout() {
        super.layout()
        metal.frame = bounds
        metal.drawableSize = bounds.size
    }

    func start(endpoint: String, pin: String) {
        let context = Unmanaged.passUnretained(self).toOpaque()
        handle = iron_start(endpoint, pin, { context, kind, message in
            guard let context else { return }
            let view = Unmanaged<NativeView>.fromOpaque(context).takeUnretainedValue()
            let text = message.map { String(cString: $0) } ?? ""
            if kind == 0 || kind == 3 {
                view.wake.schedule { [weak view] in
                    guard let view, !view.stopping else { return }
                    view.receiveCursor()
                    view.requestDraw()
                }
            } else {
                DispatchQueue.main.async { [weak view] in
                    guard let view, !view.stopping else { return }
                    if kind == 2 { fail(text) }
                    log(text)
                }
            }
        }, context)
        guard handle != nil else { fail("Could not start transport") }
    }

    func requestDraw() {
        if !stopping { metal.setNeedsDisplay(metal.bounds) }
    }

    func receiveCursor() {
        guard let handle else { return }
        _ = iron_cursor(handle, { context, kind, pixels, width, height, hx, hy in
            guard let context else { fail("Missing cursor context") }
            let view = Unmanaged<NativeView>.fromOpaque(context).takeUnretainedValue()
            switch kind {
            case 0: view.remoteCursor = .arrow
            case 1:
                let image = NSImage(size: NSSize(width: 1, height: 1), flipped: false) { _ in true }
                view.remoteCursor = NSCursor(image: image, hotSpot: .zero)
            case 2:
                guard let pixels, width > 0, height > 0, width <= 384, height <= 384, hx < width, hy < height,
                      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width),
                        pixelsHigh: Int(height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                        isPlanar: false, colorSpaceName: .deviceRGB, bitmapFormat: .alphaNonpremultiplied,
                        bytesPerRow: Int(width) * 4, bitsPerPixel: 32),
                      let destination = bitmap.bitmapData else { fail("Invalid cursor bitmap") }
                memcpy(destination, pixels, Int(width * height * 4))
                let image = NSImage(size: NSSize(width: Int(width), height: Int(height)))
                image.addRepresentation(bitmap)
                view.remoteCursor = NSCursor(image: image, hotSpot: NSPoint(x: Int(hx), y: Int(hy)))
                if view.selftest {
                    view.cursorSignatures.insert(Data(bytes: pixels, count: Int(width * height * 4)))
                    log("IRON_CURSOR_BITMAP=\(width)x\(height) hotspot=\(hx),\(hy) unique=\(view.cursorSignatures.count)")
                }
            default: fail("Invalid cursor kind: \(kind)")
            }
            view.cursorUpdates += 1
            view.window?.invalidateCursorRects(for: view)
            if let window = view.window, window.isKeyWindow,
               view.bounds.contains(view.convert(window.mouseLocationOutsideOfEventStream, from: nil)) {
                view.remoteCursor.set()
            }
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    func command(_ text: String) {
        guard let handle, !stopping else { return }
        let parts = text.split(separator: " ")
        let numbers = parts.dropFirst().compactMap { UInt32($0) }
        var accepted = false
        switch parts.first {
        case "K" where numbers.count == 2:
            accepted = iron_input(handle, 0, numbers[0], numbers[1], 0)
            if numbers[0] & 0x8000 == 0 && ![0x1d, 0x2a, 0x38].contains(numbers[1])
                && !modifierCodes.contains(0x1d) && !modifierCodes.contains(0x38) && pendingInput == nil {
                pendingInput = CACurrentMediaTime()
            }
        case "M" where numbers.count == 3:
            accepted = iron_input(handle, 1, numbers[0], numbers[1], numbers[2])
        case "R" where numbers.count == 2:
            accepted = iron_input(handle, 2, numbers[0], numbers[1], 0)
        default: fail("Invalid native input command: \(text)")
        }
        if !accepted { fail("Input queue closed/full or invalid input: \(text)") }
    }

    func receive(_ pixels: UnsafePointer<UInt8>, width: Int, height: Int,
                 x: Int, y: Int, dirtyWidth: Int, dirtyHeight: Int,
                 generation: UInt64, age: Double) {
        guard let device = metal.device else { fail("Lost Metal device") }
        let stride = (width * 4 + 255) & ~255
        if texture?.width != width || texture?.height != height {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm,
                width: width, height: height, mipmapped: false)
            descriptor.storageMode = .private
            descriptor.usage = [.shaderRead]
            guard let newTexture = device.makeTexture(descriptor: descriptor) else { fail("Texture allocation") }
            texture = newTexture
            buffers = (0..<3).map { _ in
                guard let buffer = device.makeBuffer(length: stride * height, options: .storageModeShared) else {
                    fail("Staging buffer allocation")
                }
                return buffer
            }
            log("IRON_TEXTURE=\(width)x\(height)")
        }
        remoteWidth = width
        remoteHeight = height
        if selftest, width >= 750, height >= 650 {
            var sample = Data()
            for row in 500..<650 {
                sample.append(pixels.advanced(by: (row * width + 320) * 4), count: 280 * 4)
            }
            if terminalSampling, let previous = terminalSample, previous != sample {
                terminalChangedFrames += 1
            }
            terminalSample = sample
        }
        let destination = buffers[bufferIndex].contents()
        for row in y..<y + dirtyHeight {
            memcpy(destination.advanced(by: row * stride + x * 4),
                   pixels.advanced(by: (row * width + x) * 4), dirtyWidth * 4)
        }
        upload = (x, y, dirtyWidth, dirtyHeight, stride, bufferIndex, generation)
        if ages.count < 100_000 { ages.append(age) }
        if let sent = pendingInput {
            if inputUpdates.count < 100_000 { inputUpdates.append((CACurrentMediaTime() - sent) * 1000) }
            pendingInput = nil
        }
    }

    func draw(in view: MTKView) {
        guard !stopping, let handle,
              let index = busy.firstIndex(of: false),
              let drawable = view.currentDrawable,
              let pass = view.currentRenderPassDescriptor,
              let command = queue.makeCommandBuffer() else { return }
        bufferIndex = index
        upload = nil
        let received = iron_frame(handle, { context, pixels, width, height, x, y, dw, dh, generation, age in
            guard let context, let pixels else { fail("Invalid frame callback") }
            Unmanaged<NativeView>.fromOpaque(context).takeUnretainedValue().receive(pixels,
                width: Int(width), height: Int(height), x: Int(x), y: Int(y),
                dirtyWidth: Int(dw), dirtyHeight: Int(dh), generation: generation, age: age)
        }, Unmanaged.passUnretained(self).toOpaque())
        guard let texture else { return }
        var slot: Int?
        if received, let (x, y, width, height, stride, index, _) = upload {
            guard let blit = command.makeBlitCommandEncoder() else { fail("Metal blit encoder") }
            blit.copy(from: buffers[index], sourceOffset: y * stride + x * 4,
                      sourceBytesPerRow: stride, sourceBytesPerImage: stride * texture.height,
                      sourceSize: MTLSize(width: width, height: height, depth: 1), to: texture,
                      destinationSlice: 0, destinationLevel: 0,
                      destinationOrigin: MTLOrigin(x: x, y: y, z: 0))
            blit.endEncoding()
            busy[index] = true
            slot = index
        }
        guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { fail("Metal render encoder") }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
        var readback: (MTLBuffer, Int, Int, Int, String)?
        if let path = snapshotPath {
            let width = drawable.texture.width, height = drawable.texture.height
            let stride = (width * 4 + 255) & ~255
            guard let buffer = metal.device?.makeBuffer(length: stride * height, options: .storageModeShared),
                  let blit = command.makeBlitCommandEncoder() else { fail("Snapshot resources") }
            blit.copy(from: drawable.texture, sourceSlice: 0, sourceLevel: 0,
                sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                sourceSize: MTLSize(width: width, height: height, depth: 1), to: buffer,
                destinationOffset: 0, destinationBytesPerRow: stride, destinationBytesPerImage: stride * height)
            blit.endEncoding()
            readback = (buffer, width, height, stride, path)
            snapshotPath = nil
        }
        command.present(drawable)
        let started = CACurrentMediaTime()
        command.addCompletedHandler { [weak self] completed in
            let elapsed = (CACurrentMediaTime() - started) * 1000
            DispatchQueue.main.async {
                guard let self, !self.stopping else { return }
                if completed.status == .error { fail("Metal submission: \(String(describing: completed.error))") }
                if let slot { self.busy[slot] = false }
                if let (buffer, width, height, stride, path) = readback {
                    self.writeSnapshot(buffer, width: width, height: height, stride: stride, path: path)
                    self.window?.performClose(nil)
                    return
                }
                if received {
                    if self.completions.count < 100_000 { self.completions.append(elapsed) }
                    self.submitted += 1
                    if self.firstFrame {
                        self.firstFrame = false
                        log("IRON_NATIVE_READY")
                        if ProcessInfo.processInfo.environment["VSPOD_IRON_TRANSFER_SELFTEST"] == "1" {
                            self.runTransferSelftest()
                        } else if self.selftest { self.runSelftest() }
                    }
                    // Retry once after a busy drawable; the mailbox still holds the latest dirty union.
                    self.requestDraw()
                }
            }
        }
        command.commit()
    }
    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { requestDraw() }

    func writeSnapshot(_ buffer: MTLBuffer, width: Int, height: Int, stride: Int, path: String) {
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue
        guard let context = CGContext(data: buffer.contents(), width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: stride, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info),
              let image = context.makeImage(),
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            fail("Snapshot encoding")
        }
        do { try png.write(to: URL(fileURLWithPath: path), options: .atomic) }
        catch { fail("Snapshot write: \(error)") }
        log("IRON_SNAPSHOT=\(width)x\(height) texture=\(remoteWidth)x\(remoteHeight)")
    }

    override func windowWillClose(_ notification: Notification) {
        guard !stopping else { return }
        modifiers([])
        stopping = true
        transfers.stop()
        NSCursor.arrow.set()
        resizeWork?.cancel()
        if let handle { iron_stop(handle); self.handle = nil }
        func summary(_ name: String, _ values: [Double]) {
            let sorted = values.sorted()
            guard !sorted.isEmpty else { log("\(name) n=0"); return }
            log(String(format: "%@ n=%d p50=%.3fms p95=%.3fms max=%.3fms", name, sorted.count,
                sorted[sorted.count / 2], sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))], sorted.last!))
        }
        summary("IRON_MAILBOX_AGE", ages)
        summary("IRON_SUBMIT_TO_GPU_COMPLETE", completions)
        summary("IRON_INPUT_TO_NEXT_UPDATE_PROXY", inputUpdates)
        log("IRON_NATIVE_CLOSED frames=\(submitted)")
        log("IRON_CURSOR_UPDATES=\(cursorUpdates) unique=\(cursorSignatures.count)")
        NSApplication.shared.terminate(nil)
    }

    func runSelftest() {
        guard let window else { fail("Selftest window") }
        func later(_ seconds: Double, _ action: @escaping () -> Void) {
            // A first framebuffer can precede VS Code's cursor/theme initialization.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8 + seconds, execute: action)
        }
        func key(_ code: UInt16, _ characters: String, _ flags: NSEvent.ModifierFlags = []) {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: characters,
                charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
            self.keyDown(with: event)
            self.keyUp(with: event)
            self.modifiers([])
        }
        func pointer(_ x: Double, _ y: Double) -> NSEvent {
            NSEvent.mouseEvent(with: .mouseMoved, location: NSPoint(x: x, y: self.bounds.height - y),
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 0, pressure: 0)!
        }
        var testedCursors = [String: Data]()
        func captureCursor(_ name: String) {
            guard let image = self.remoteCursor.image.tiffRepresentation else { fail("Cursor image readback") }
            if name == "editor", self.remoteCursor.hotSpot == .zero { fail("Editor still has default cursor") }
            testedCursors[name] = image
            log("IRON_CURSOR_TEST=\(name) hotspot=\(self.remoteCursor.hotSpot)")
        }
        later(0.8) { self.mouseMoved(with: pointer(100, 200)) }
        later(1) {
            self.mouseMoved(with: pointer(450, 130))
        }
        later(1.9) { captureCursor("editor") }
        later(2) { self.mouseMoved(with: pointer(100, 200)) }
        later(2.9) { captureCursor("explorer") }
        later(3) { self.mouseMoved(with: pointer(303, 300)) }
        later(3.9) { captureCursor("splitter") }
        later(4) {
            guard testedCursors.count == 3, Set(testedCursors.values).count == 3 else {
                fail("Missing distinct editor/arrow/splitter AppKit cursor shapes")
            }
            log("IRON_CURSOR_SHAPES_PASS unique=3")
        }
        later(5) {
            let point = NSPoint(x: 450, y: self.bounds.height - 130)
            let click = NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1,
                clickCount: 1, pressure: 1)!
            self.mouseDown(with: click); self.mouseUp(with: click)
        }
        later(5.5) { key(0, "a", .command) }
        let letters: [Character: UInt16] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,
            "x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"o":31,
            "u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46," ":49,"\n":36]
        let text = Array("Native Iron input verified\nSecond line")
        later(0.5) {
            self.modifiers([.shift, .control])
            self.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification))
            guard self.pressedCodes.isEmpty && self.modifierCodes.isEmpty else { fail("Focus-loss key release") }
            log("IRON_FOCUS_RELEASE_PASS")
        }
        for (index, character) in text.enumerated() {
            later(6 + Double(index) * 0.12) {
                key(letters[Character(String(character).lowercased())]!, String(character),
                    character.isUppercase ? .shift : [])
            }
        }
        later(11.5) { key(1, "s", .command) }
        later(12) { key(50, "`", .control) }
        let terminalCommand = Array("seq 1 400")
        for (index, character) in terminalCommand.enumerated() {
            later(13 + Double(index) * 0.1) {
                let digits: [Character: UInt16] = ["1":18, "4":21, "0":29]
                key(digits[character] ?? letters[character]!, String(character))
            }
        }
        later(14.2) { key(36, "\n") }
        var scrollStart = 0
        later(16) { scrollStart = self.submitted; self.terminalSampling = true }
        for index in 0..<90 {
            later(16.1 + Double(index) / 60) {
                self.scroll(pointer(500, 600), deltaY: 6, deltaX: 0, precise: true)
            }
        }
        later(18) {
            let frames = self.submitted - scrollStart
            self.terminalSampling = false
            if frames >= 8, self.terminalChangedFrames >= 8 {
                log("IRON_TERMINAL_SCROLL_PASS frames=\(frames) contentChanges=\(self.terminalChangedFrames) duration=2s packets=90")
            } else {
                log("IRON_TERMINAL_SCROLL_FAIL frames=\(frames) contentChanges=\(self.terminalChangedFrames) duration=2s packets=90")
            }
            key(50, "`", .control)
        }
        later(19) { window.setContentSize(NSSize(width: 1000, height: 680)) }
        later(22) { window.setContentSize(NSSize(width: 1200, height: 800)) }
        later(25) {
            guard self.remoteWidth == 1200 && self.remoteHeight == 800 else { fail("Resize did not arrive") }
            log("IRON_SELFTEST_SAVED")
        }
        later(27) {
            if let path = ProcessInfo.processInfo.environment["VSPOD_IRON_SNAPSHOT"] {
                self.snapshotPath = path
                self.requestDraw()
            } else { window.performClose(nil) }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
guard CommandLine.arguments.count == 3 else { fail("Usage: iron-native endpoint sha256-pin") }
let native = NativeView()
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
    styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
window.title = "VSPod - IronRDP / Metal - disposable workspace"
window.isReleasedWhenClosed = false
window.contentMinSize = NSSize(width: 400, height: 300)
window.contentView = native
window.delegate = native
window.acceptsMouseMovedEvents = true
window.center()
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(native)
let menu = NSMenu()
let applicationItem = NSMenuItem()
let applicationMenu = NSMenu()
applicationMenu.addItem(withTitle: "Quit VSPod Playground", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "q").target = window
applicationItem.submenu = applicationMenu
menu.addItem(applicationItem)
let editItem = NSMenuItem()
let editMenu = NSMenu(title: "Edit")
for (title, action, key, shifted) in [
    ("Copy from Guest", #selector(NativeView.copyClipboard(_:)), "c", false),
    ("Paste into Guest", #selector(NativeView.pasteClipboard(_:)), "v", false),
    ("Copy from Terminal", #selector(NativeView.copyTerminalClipboard(_:)), "c", true),
    ("Paste into Terminal", #selector(NativeView.pasteTerminalClipboard(_:)), "v", true)
] {
    let item = editMenu.addItem(withTitle: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = shifted ? [.command, .shift] : [.command]
    item.target = native
}
editItem.submenu = editMenu
menu.addItem(editItem)
app.mainMenu = menu
app.activate(ignoringOtherApps: true)
native.start(endpoint: CommandLine.arguments[1], pin: CommandLine.arguments[2])
app.run()
