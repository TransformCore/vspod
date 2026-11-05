import AppKit
import MetalKit
import Compression

func log(_ message: String) { print(message); fflush(stdout) }
let hostTrace = ProcessInfo.processInfo.environment["VSPOD_HOST_TRACE"] == "1"
func traced<T>(_ label: @autoclosure () -> String, _ body: () -> T) -> T {
    guard hostTrace else { return body() }
    let start = CACurrentMediaTime()
    let result = body()
    let ms = (CACurrentMediaTime() - start) * 1000
    if ms > 4 { log(String(format: "HOST_SLOW ms=%.1f ", ms) + label()) }
    return result
}
func fail(_ message: String) -> Never {
    fputs("Window capture: \(message)\n", stderr)
    exit(1)
}

// One device, queue and pipeline for every window: compiling the shader per window cost ~50 ms of main-thread
// time for each guest menu.
enum Gpu {
    static let device: MTLDevice = {
        guard let device = MTLCreateSystemDefaultDevice() else { fail("Metal unavailable") }
        return device
    }()
    static let queue: MTLCommandQueue = {
        guard let queue = device.makeCommandQueue() else { fail("Metal unavailable") }
        return queue
    }()
    static let pipeline: MTLRenderPipelineState = {
        let shader = """
        #include <metal_stdlib>
        using namespace metal;
        struct Vertex { float4 position [[position]]; float2 uv; };
        vertex Vertex vertex_main(uint id [[vertex_id]]) {
            const float2 p[] = {float2(-1,-1),float2(1,-1),float2(-1,1),float2(1,1)};
            Vertex v; v.position=float4(p[id],0,1);
            v.uv=float2((p[id].x+1)*0.5,(1-p[id].y)*0.5); return v;
        }
        fragment float4 fragment_main(Vertex v [[stage_in]], texture2d<float> image [[texture(0)]],
                                      constant uint &alpha [[buffer(0)]]) {
            constexpr sampler s(coord::normalized, address::clamp_to_edge, filter::nearest);
            float4 c = image.sample(s,v.uv);
            return alpha ? c : float4(c.rgb,1);
        }
        """
        do {
            let library = try device.makeLibrary(source: shader, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "vertex_main")
            descriptor.fragmentFunction = library.makeFunction(name: "fragment_main")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            return try device.makeRenderPipelineState(descriptor: descriptor)
        } catch { fail("Metal pipeline: \(error)") }
    }()
}

// A plain CAMetalLayer, so drawables can be acquired off the main thread (MTKView only draws on main).
final class MetalSurface: NSView {
    let metalLayer = CAMetalLayer()
    init() {
        super.init(frame: .zero)
        metalLayer.device = Gpu.device
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = false
        metalLayer.isOpaque = true
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
    override func makeBackingLayer() -> CALayer { metalLayer }
}

final class WindowView: InputView {
    let id: Int
    unowned let session: Session
    let metal = MetalSurface()
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState
    // Uploads and draws run here so a vsync-bound drawable wait never delays native input on the main thread.
    let render: DispatchQueue
    // Render-queue state.
    var texture: MTLTexture?
    var inFlight: MTLCommandBuffer?
    var drawScheduled = false
    var drawAlpha = false
    var drawSnapshot: String?
    var drawLatency: (seq: Int, at: CFTimeInterval, received: CFTimeInterval, header: [String: Any], bytes: Int)?
    // Main-thread mirror of the uploaded texture size, used to drop partials that predate a resize.
    var uploadedSize: (Int, Int)?
    var frames = 0
    var popup = false
    var dialog = false
    // Premultiplied alpha from the guest (Wayland popups' rounded corners); otherwise drawn opaque.
    var alpha = false {
        didSet {
            guard alpha != oldValue else { return }
            metal.metalLayer.isOpaque = !alpha
            window?.isOpaque = !alpha
            window?.backgroundColor = alpha ? .clear : .windowBackgroundColor
            requestDraw()
        }
    }
    // Guest pixels per logical point; the Wayland compositor sends 2x buffers for Retina sharpness.
    var scale = 1
    var closingFromGuest = false
    var closingRequested = false
    // Benchmark-only: time from a native key/button press to the next guest frame on screen.
    var pendingInput: (seq: Int, at: CFTimeInterval)?

    init(id: Int, session: Session) {
        self.id = id
        self.session = session
        queue = Gpu.queue
        pipeline = Gpu.pipeline
        render = DispatchQueue(label: "vspod.render.\(id)", qos: .userInteractive)
        super.init(frame: .zero)
        automatedInputOnly = session.selftest
        sendInput = { [weak self] in self?.input($0) }
        metal.autoresizingMask = [.width, .height]
        addSubview(metal)
        registerForDraggedTypes([.fileURL])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
    override func hitTest(_ point: NSPoint) -> NSView? { self }
    // The key main window receives every mouse move, including those over its popup panels or outside
    // its frame. Send the true offset rather than clamping to this window's edge; the agent maps it into
    // guest root coordinates, where popups sit at the same relative position as they do here.
    override func mouse(_ event: NSEvent, flags: Int) {
        guard acceptsInput(event) else { return }
        modifiers(event.modifierFlags)
        let point = convert(event.locationInWindow, from: nil)
        let x = Int((point.x * Double(remoteWidth) / max(1, bounds.width)).rounded(.down))
        let y = Int(((bounds.height - point.y) * Double(remoteHeight) / max(1, bounds.height)).rounded(.down))
        sendInput("M \(flags) \(x) \(y)")
    }
    // Real mouse moves arrive here from Session's event monitor rather than through AppKit routing.
    func moved(_ event: NSEvent) {
        guard acceptsInput(event), let window else { return }
        modifiers(event.modifierFlags)
        let screen = event.window.map { $0.convertPoint(toScreen: event.locationInWindow) } ?? event.locationInWindow
        let point = convert(window.convertPoint(fromScreen: screen), from: nil)
        let x = Int((point.x * Double(remoteWidth) / max(1, bounds.width)).rounded(.down))
        let y = Int(((bounds.height - point.y) * Double(remoteHeight) / max(1, bounds.height)).rounded(.down))
        sendInput("M \(0x0800) \(x) \(y)")
        if ([window] + (window.childWindows ?? [])).contains(where: { $0.frame.contains(screen) }) { session.cursor.set() }
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: session.cursor) }
    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        session.cursor.set()
    }
    override func keyDown(with event: NSEvent) {
        guard acceptsInput(event) else { return }
        if event.modifierFlags.contains(.command), event.keyCode == 12 {
            session.stop()
            return
        }
        // Cmd+V (and Cmd+Shift+V in the terminal): give the guest the host clipboard just before the keystroke,
        // so the guest only ever sees the clipboard when the user pastes.
        if session.configuration.integrations.clipboard,
           event.modifierFlags.contains(.command), event.keyCode == 9, !event.isARepeat {
            do { session.send(try Integrations.clipboardCommand(Integrations.pasteboard,
                allowFiles: session.configuration.integrations.files)) }
            catch { log("WINDOW_CLIPBOARD_SKIPPED reason=\(error.localizedDescription)") }
        }
        super.keyDown(with: event)
    }
    // Finder drops: files are read on the host (same limits as the clipboard) and dropped by the compositor.
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        popup || !session.configuration.integrations.files ? [] : .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        popup || !session.configuration.integrations.files ? [] : .copy
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard !popup, let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty else { return false }
        return drop(urls, at: convert(sender.draggingLocation, from: nil))
    }
    func drop(_ urls: [URL], at point: NSPoint) -> Bool {
        guard session.configuration.integrations.files else {
            log("WINDOW_DROP_REJECTED reason=host policy")
            return false
        }
        do {
            let x = Int((point.x * Double(remoteWidth) / max(1, bounds.width)).rounded(.down))
            let y = Int(((bounds.height - point.y) * Double(remoteHeight) / max(1, bounds.height)).rounded(.down))
            send(["action": "drop", "x": x, "y": y, "entries": try Integrations.entries(urls)])
            return true
        } catch {
            log("WINDOW_DROP_REJECTED reason=\(error.localizedDescription)")
            return false
        }
    }
    /// The visible screen area relative to this window's content top-left (points, y down), so the compositor
    /// can flip and slide guest menus to stay on screen.
    func sendBounds() {
        guard !popup, let window, let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let top = window.convertPoint(toScreen: NSPoint(x: 0, y: bounds.height))
        send(["action": "bounds", "x": Int((visible.minX - top.x).rounded()), "y": Int((top.y - visible.maxY).rounded()),
              "width": Int(visible.width), "height": Int(visible.height)])
    }
    override func keyUp(with event: NSEvent) {
        if event.modifierFlags.contains(.command), event.keyCode == 12 { return }
        super.keyUp(with: event)
    }
    override func layout() {
        super.layout()
        metal.frame = bounds
        let size = CGSize(width: bounds.width * CGFloat(scale), height: bounds.height * CGFloat(scale))
        if metal.metalLayer.drawableSize != size {
            metal.metalLayer.drawableSize = size
            requestDraw()
        }
    }
    func send(_ body: [String: Any]) {
        guard !closingFromGuest, !session.stopping else { return }
        var command = body
        command["id"] = id
        session.send(command)
    }
    func input(_ text: String) {
        let parts = text.split(separator: " ")
        if session.bench, let flags = Int(parts.dropFirst().first ?? ""),
           (parts.first == "K" && flags & 0x8000 == 0) || (parts.first == "M" && flags & 0x8000 != 0) {
            session.inputSeq += 1
            pendingInput = (session.inputSeq, CACurrentMediaTime())
        }
        let numbers = parts.dropFirst().compactMap { Int($0) }
        switch parts.first {
        case "K" where numbers.count == 2:
            let code = numbers[1]
            let extended = numbers[0] & 0x100 != 0
            let extendedKeys = [0x1c:104, 0x1d:105, 0x38:108, 0x47:110, 0x48:111,
                                0x49:112, 0x4b:113, 0x4d:114, 0x4f:115, 0x50:116,
                                0x51:117, 0x52:118, 0x53:119]
            guard let xkey = extended ? extendedKeys[code] : code + 8 else { fail("Unsupported extended key") }
            send(["action": "key", "key": xkey, "down": numbers[0] & 0x8000 == 0])
        case "M" where numbers.count == 3:
            let flags = numbers[0]
            var button = 0
            if flags & 0x1000 != 0 { button = 1 }
            else if flags & 0x2000 != 0 { button = 3 }
            else if flags & 0x4000 != 0 { button = 2 }
            if flags & 0x600 != 0 {
                let negative = flags & 0x100 != 0
                let wheel = flags & 0x400 != 0 ? (negative ? 6 : 7) : (negative ? 5 : 4)
                send(["action": "mouse", "x": numbers[1], "y": numbers[2], "button": wheel, "down": true])
                send(["action": "mouse", "x": numbers[1], "y": numbers[2], "button": wheel, "down": false])
            } else {
                send(["action": "mouse", "x": numbers[1], "y": numbers[2],
                      "button": button, "down": flags & 0x8000 != 0])
            }
        default: fail("Unexpected input: \(text)")
        }
    }
    static func payloadSize(width: Int, height: Int, rects: [[Int]]) -> Int {
        var expected = 0
        for rect in rects {
            guard rect.count == 4, rect[0] >= 0, rect[1] >= 0, rect[2] > 0, rect[3] > 0,
                  rect[0] + rect[2] <= width, rect[1] + rect[3] <= height else { fail("Invalid damage rectangle") }
            expected += rect[2] * rect[3] * 4
        }
        return expected
    }
    // Runs on the stream reader thread so decompression never delays native input on the main thread.
    static func decode(_ header: [String: Any], _ data: Data) -> ([String: Any], Data) {
        guard let encoding = header["encoding"] as? String else { return (header, data) }
        guard encoding == "deflate", let width = header["width"] as? Int, let height = header["height"] as? Int,
              width > 0, height > 0, width <= 8192, height <= 4320,
              let rects = header["rects"] as? [[Int]], !rects.isEmpty, rects.count <= 24 else {
            fail("Unsupported frame encoding")
        }
        let expected = payloadSize(width: width, height: height, rects: rects)
        // Decode into a buffer of exactly the declared size so a bad stream cannot over-allocate.
        var decoded = Data(count: expected)
        let written = decoded.withUnsafeMutableBytes { target in
            data.withUnsafeBytes { source in
                compression_decode_buffer(target.bindMemory(to: UInt8.self).baseAddress!, expected,
                    source.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written == expected else { fail("Compressed frame did not decode to its rectangles") }
        var header = header
        header["encoding"] = nil
        header["wire"] = data.count
        return (header, decoded)
    }
    @discardableResult
    func frame(_ header: [String: Any], _ data: Data) -> Data {
        guard let width = header["width"] as? Int, let height = header["height"] as? Int,
              width > 0, height > 0, width <= 4096 * scale, height <= 2160 * scale,
              let rects = header["rects"] as? [[Int]], !rects.isEmpty, rects.count <= 24 else { fail("Invalid frame shape") }
        let expected = WindowView.payloadSize(width: width, height: height, rects: rects)
        let wire = header["wire"] as? Int ?? data.count
        guard !(header["encoding"] is String) else { fail("Frame was not decoded before upload") }
        guard data.count == expected else { fail("Frame payload does not match its rectangles") }
        let full = rects.count == 1 && rects[0] == [0, 0, width, height]
        if uploadedSize.map({ $0 != (width, height) }) ?? true {
            // After a resize the agent always sends a full frame first; earlier partials are stale.
            guard full else {
                log("WINDOW_STALE_PARTIAL id=\(id) size=\(width)x\(height)")
                return data
            }
            uploadedSize = (width, height)
        }
        remoteWidth = width / scale
        remoteHeight = height / scale
        render.async { [self] in
            if texture?.width != width || texture?.height != height {
                let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm,
                    width: width, height: height, mipmapped: false)
                descriptor.storageMode = .managed
                descriptor.usage = [.shaderRead]
                texture = Gpu.device.makeTexture(descriptor: descriptor)
                guard texture != nil else { fail("Texture allocation") }
            }
            // The one texture is shared with the last draw; let the GPU finish reading it first.
            inFlight?.waitUntilCompleted()
            data.withUnsafeBytes { bytes in
                var offset = 0
                for rect in rects {
                    texture!.replace(region: MTLRegionMake2D(rect[0], rect[1], rect[2], rect[3]), mipmapLevel: 0,
                        withBytes: bytes.baseAddress!.advanced(by: offset), bytesPerRow: rect[2] * 4)
                    offset += rect[2] * rect[3] * 4
                }
            }
        }
        frames += 1
        session.frameCount += 1
        session.byteCount += wire
        if let input = pendingInput {
            requestDraw(latency: (input.seq, input.at, CACurrentMediaTime(), header, wire))
            pendingInput = nil
        } else {
            requestDraw()
        }
        if frames == 1 { log("WINDOW_FRAME id=\(id) size=\(width)x\(height)") }
        return data
    }
    // Main thread: coalesces into one pending draw that also covers every upload queued before it runs.
    func requestDraw(snapshot: String? = nil,
                     latency: (seq: Int, at: CFTimeInterval, received: CFTimeInterval, header: [String: Any], bytes: Int)? = nil) {
        let alpha = self.alpha
        let reshadow = alpha && frames <= 2
        render.async { [self] in
            drawAlpha = alpha
            if let snapshot { drawSnapshot = snapshot }
            if let latency { drawLatency = latency }
            guard !drawScheduled else { return }
            drawScheduled = true
            render.async { [self] in
                drawScheduled = false
                let size = metal.metalLayer.drawableSize
                traced("draw id=\(id) \(Int(size.width))x\(Int(size.height))") { drawNow() }
                // The panel shadow follows the drawn shape, so recompute it once the rounded corners are on screen.
                if reshadow { DispatchQueue.main.async { self.window?.invalidateShadow() } }
            }
        }
    }
    // Render queue only.
    func drawNow() {
        guard let texture, let drawable = metal.metalLayer.nextDrawable(),
              let command = queue.makeCommandBuffer() else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentTexture(texture, index: 0)
        var translucent: UInt32 = drawAlpha ? 1 : 0
        encoder.setFragmentBytes(&translucent, length: 4, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
        var readback: (MTLBuffer, Int)?
        if drawSnapshot != nil {
            let stride = (drawable.texture.width * 4 + 255) & ~255
            guard let buffer = Gpu.device.makeBuffer(length: stride * drawable.texture.height, options: .storageModeShared),
                  let blit = command.makeBlitCommandEncoder() else { fail("Native snapshot allocation") }
            blit.copy(from: drawable.texture, sourceSlice: 0, sourceLevel: 0,
                sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                sourceSize: MTLSize(width: drawable.texture.width, height: drawable.texture.height, depth: 1),
                to: buffer, destinationOffset: 0, destinationBytesPerRow: stride,
                destinationBytesPerImage: stride * drawable.texture.height)
            blit.endEncoding()
            readback = (buffer, stride)
        }
        if let latency = drawLatency {
            drawLatency = nil
            drawable.addPresentedHandler { presented in
                let shown = presented.presentedTime > 0 ? presented.presentedTime : CACurrentMediaTime()
                let agent = latency.header["cap_us"].map { " capture_us=\($0)" } ?? ""
                let compress = latency.header["comp_us"].map { " compress_us=\($0)" } ?? ""
                let render = latency.header["input_us"].map { " input_to_capture_us=\($0)" } ?? ""
                let dirty = latency.header["dirty_us"].map { " dirty_age_us=\($0)" } ?? ""
                let rects = (latency.header["rects"] as? [[Int]]).map { " rects=" + $0.map { $0.map(String.init).joined(separator: ",") }.joined(separator: ";") } ?? ""
                DispatchQueue.main.async {
                    log(String(format: "WINDOW_LATENCY seq=%d receive_ms=%.2f present_ms=%.2f bytes=%d",
                        latency.seq, (latency.received - latency.at) * 1000, (shown - latency.at) * 1000, latency.bytes) + agent + compress + render + dirty + rects)
                }
            }
        }
        command.addCompletedHandler { command in
            if command.status == .error { fail("Metal draw failed: \(String(describing: command.error))") }
        }
        command.present(drawable)
        command.commit()
        inFlight = command
        if readback != nil { command.waitUntilCompleted() }
        if let tag = drawSnapshot, let (buffer, stride) = readback {
            var data = Data()
            for row in 0..<drawable.texture.height {
                data.append(buffer.contents().advanced(by: row * stride).assumingMemoryBound(to: UInt8.self),
                    count: drawable.texture.width * 4)
            }
            do {
                try data.write(to: URL(fileURLWithPath: session.root + "/" + tag + ".metal.bgra"))
            } catch { fail("Native snapshot write: \(error)") }
            drawSnapshot = nil
            log("WINDOW_METAL_SNAPSHOT tag=\(tag) id=\(id) size=\(drawable.texture.width)x\(drawable.texture.height)")
        }
    }
    func windowDidBecomeKey(_ notification: Notification) {
        if let modal = session.views.values.first(where: { $0.dialog && session.metadata[$0.id]?["owner"] as? Int == id }) {
            modal.window?.makeKeyAndOrderFront(nil)
            return
        }
        if !popup { send(["action": "focus"]) }
    }
    func windowDidMove(_ notification: Notification) {
        sendBounds()
        for child in session.views.keys where session.metadata[child]?["owner"] as? Int == id {
            session.positionPopup(child)
        }
    }
    override func windowDidResignKey(_ notification: Notification) {
        // A popup must keep the owner's guest focus; ordinary key release remains explicit.
        modifiers([])
        for code in pressedCodes { scan(code, down: false) }
    }
    override func windowDidResize(_ notification: Notification) {
        if !popup { sendBounds() }
        guard !popup, !dialog, !closingFromGuest else { return }
        resizeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.closingFromGuest else { return }
            let width = min(2400, max(300, Int(self.bounds.width)))
            let height = min(1400, max(200, Int(self.bounds.height)))
            if width != self.remoteWidth || height != self.remoteHeight {
                self.send(["action": "resize", "width": width, "height": height])
            }
        }
        resizeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closingFromGuest { return true }
        closingRequested = true
        send(["action": "close"])
        return false
    }
    override func windowWillClose(_ notification: Notification) {
        resizeWork?.cancel()
    }
}

final class Session: NSObject {
    let configuration: HostConfiguration
    let selftest = ProcessInfo.processInfo.environment["VSPOD_WINDOW_SELFTEST"] == "1"
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    let writeQueue = DispatchQueue(label: "org.vspod.window-input")
    let root: String
    var views = [Int: WindowView]()
    var windows = [Int: NSWindow]()
    var metadata = [Int: [String: Any]]()
    var stopping = false
    var mainCount = 0
    var cursor = NSCursor.arrow
    static let cursorScale = 2.0
    // X/CSS cursor names (as fingerprinted from the guest theme) with a direct AppKit equivalent.
    static let nativeCursors: [String: (name: String, cursor: NSCursor)] = {
        var table: [String: (name: String, cursor: NSCursor)] = [:]
        let groups: [(String, NSCursor, [String])] = [
            ("arrow", .arrow, ["default", "arrow", "left_ptr", "top_left_arrow"]),
            ("iBeam", .iBeam, ["text", "xterm"]),
            ("verticalIBeam", .iBeamCursorForVerticalLayout, ["vertical-text"]),
            ("pointingHand", .pointingHand, ["pointer", "hand1", "hand2"]),
            ("resizeLeftRight", .resizeLeftRight, ["col-resize", "ew-resize", "sb_h_double_arrow", "e-resize",
                                                   "w-resize", "left_side", "right_side"]),
            ("resizeUpDown", .resizeUpDown, ["row-resize", "ns-resize", "sb_v_double_arrow", "n-resize",
                                             "s-resize", "top_side", "bottom_side"]),
            ("crosshair", .crosshair, ["crosshair", "cross", "tcross"]),
            ("operationNotAllowed", .operationNotAllowed, ["not-allowed", "no-drop"]),
            ("openHand", .openHand, ["grab"]),
            ("closedHand", .closedHand, ["grabbing"]),
            ("dragCopy", .dragCopy, ["copy"]),
            ("dragLink", .dragLink, ["alias"]),
            ("contextualMenu", .contextualMenu, ["context-menu"]),
        ]
        for (name, cursor, aliases) in groups { for alias in aliases { table[alias] = (name, cursor) } }
        return table
    }()
    let bench = ProcessInfo.processInfo.environment["VSPOD_WINDOW_BENCH"] == "1"
    var inputSeq = 0
    var frameCount = 0
    var byteCount = 0

    init(configuration: HostConfiguration) {
        self.configuration = configuration
        self.root = configuration.root
        super.init()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["docker", "exec", "-i"] +
            (configuration.protocol == "x11" ? ["--env", "DISPLAY=:11"] : []) +
            [configuration.container] + configuration.bridge
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.standardError
    }
    func send(_ body: [String: Any]) {
        guard !stopping else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: body)
            data.append(10)
            writeQueue.async {
                do { try self.input.fileHandleForWriting.write(contentsOf: data) }
                catch { if !self.stopping { fail("Guest input pipe: \(error)") } }
            }
        } catch { fail("Input encoding: \(error)") }
    }
    func start() {
        do { try process.run() } catch { fail("Guest agent launch: \(error)") }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.views.values.forEach { $0.sendBounds() }
        }
        // AppKit sends mouse moves to whichever window it picks; borderless non-activating popup panels swallow
        // most of them, so hover inside guest menus stalled after the first row. Route every real move to the
        // key window's view (which maps it into guest coordinates, popups included) and drop the original.
        NSEvent.addLocalMonitorForEvents(matching: .mouseMoved) { [weak self] event in
            guard let self, var view = (event.window ?? NSApplication.shared.keyWindow)?.contentView as? WindowView,
                  self.views[view.id] === view else { return event }
            while view.popup, let parent = view.window?.parent?.contentView as? WindowView { view = parent }
            view.moved(event)
            return nil
        }
        DispatchQueue.global().async {
            do {
                func read(_ count: Int) throws -> Data {
                    var result = Data()
                    while result.count < count {
                        guard let chunk = try self.output.fileHandleForReading.read(upToCount: count - result.count),
                              !chunk.isEmpty else { throw NSError(domain: "Guest stream ended", code: 1) }
                        result.append(chunk)
                    }
                    return result
                }
                while true {
                    let prefix = try read(4)
                    let size = prefix.reduce(0) { ($0 << 8) | Int($1) }
                    guard size > 0, size <= 1 << 20 else { fail("Invalid header size") }
                    guard let raw = try JSONSerialization.jsonObject(with: read(size)) as? [String: Any],
                          let count = raw["bytes"] as? Int, count >= 0, count <= 8192 * 4320 * 4 else {
                        fail("Invalid stream header")
                    }
                    let payload = try read(count)
                    let (header, pixels) = raw["type"] as? String == "frame" ? WindowView.decode(raw, payload) : (raw, payload)
                    DispatchQueue.main.sync { traced("receive \(header["type"] ?? "") id=\(header["id"] ?? "") bytes=\(pixels.count)") { self.receive(header, pixels) } }
                }
            } catch {
                if !self.stopping { fail("Guest stream: \(error)") }
            }
        }
        DispatchQueue.global().async {
            while let line = readLine() {
                do {
                    guard let data = line.data(using: .utf8),
                          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        fail("Invalid host control request")
                    }
                    DispatchQueue.main.sync { self.control(request) }
                } catch { fail("Host control: \(error)") }
            }
            DispatchQueue.main.async { self.stop() }
        }
    }
    func receive(_ header: [String: Any], _ pixels: Data) {
        guard let type = header["type"] as? String else { fail("Missing event type") }
        if type == "ready" {
            if configuration.protocol == "wayland", header["version"] as? Int != configuration.version {
                fail("Unsupported app-runner guest protocol version")
            }
            log("WINDOW_AGENT_READY")
            return
        }
        if type == "rejected" {
            if let id = header["id"] as? Int, views[id] == nil {
                log("WINDOW_STALE_INPUT id=\(id) action=\(header["action"] ?? "")")
                return
            }
            fail("Guest rejected input: \(header)")
        }
        if type == "cursor" {
            guard let width = header["width"] as? Int, let height = header["height"] as? Int,
                  let x = header["xhot"] as? Int, let y = header["yhot"] as? Int,
                  width > 0, height > 0, width <= 256, height <= 256,
                  x >= 0, y >= 0, x < width, y < height, pixels.count == width * height * 4,
                  let provider = CGDataProvider(data: pixels as CFData),
                  let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                    bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
                fail("Invalid guest cursor")
            }
            guard let names = header["names"] as? [String], names.count <= 16,
                  names.allSatisfy({ $0.range(of: "^[a-zA-Z0-9_-]{1,40}$", options: .regularExpression) != nil }) else {
                fail("Invalid guest cursor names")
            }
            // Native cursors follow the user's macOS pointer size and colour; the guest image is only a fallback.
            if let native = names.lazy.compactMap({ Session.nativeCursors[$0] }).first {
                cursor = native.cursor
                log("WINDOW_CURSOR native=\(native.name) guest=\(names.joined(separator: ","))")
            } else {
                // The guest renders cursors at XCURSOR_SIZE=48, i.e. 2x a 24 pt cursor.
                cursor = NSCursor(image: NSImage(cgImage: image, size: NSSize(width: Double(width) / Session.cursorScale,
                                                                              height: Double(height) / Session.cursorScale)),
                                  hotSpot: NSPoint(x: Double(x) / Session.cursorScale, y: Double(y) / Session.cursorScale))
                log("WINDOW_CURSOR image size=\(width)x\(height) hotspot=\(x),\(y) guest=\(names.joined(separator: ","))")
            }
            for view in views.values { view.window?.invalidateCursorRects(for: view) }
            if let window = NSApplication.shared.keyWindow, let view = window.contentView,
               view.bounds.contains(view.convert(window.mouseLocationOutsideOfEventStream, from: nil)) { cursor.set() }
            return
        }
        if integration(type, header, pixels) { return }
        guard let id = header["id"] as? Int else { fail("Missing window id") }
        switch type {
        case "window":
            guard let width = header["width"] as? Int, let height = header["height"] as? Int,
                  let popup = header["popup"] as? Bool, let dialog = header["dialog"] as? Bool,
                  let title = header["title"] as? String,
                  width > 0, height > 0, width <= 4096, height <= 2160 else { fail("Invalid window metadata") }
            let scale = header["scale"] as? Int ?? 1
            guard (1...2).contains(scale) else { fail("Invalid window scale") }
            metadata[id] = header
            defer { views[id]?.alpha = popup && header["alpha"] as? Bool == true }
            if windows[id] == nil {
                let view = WindowView(id: id, session: self)
                view.popup = popup
                view.dialog = dialog
                view.scale = scale
                view.remoteWidth = width
                view.remoteHeight = height
                let style: NSWindow.StyleMask = popup ? [.borderless, .nonactivatingPanel] : [.titled, .closable, .resizable]
                let window: NSWindow = popup
                    ? NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: style, backing: .buffered, defer: false)
                    : NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: style, backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = view
                window.delegate = view
                window.acceptsMouseMovedEvents = true
                window.contentMinSize = dialog || popup ? NSSize(width: 1, height: 1) : NSSize(width: 300, height: 200)
                if !dialog && !popup { window.contentMaxSize = NSSize(width: 2400, height: 1400) }
                views[id] = view
                windows[id] = window
                if !popup && !dialog {
                    mainCount += 1
                    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
                    let offset = CGFloat((mainCount - 1) % 5) * 30
                    window.setFrameTopLeftPoint(NSPoint(x: screen.minX + 40 + offset, y: screen.maxY - 30 - offset))
                    window.makeKeyAndOrderFront(nil)
                    window.makeFirstResponder(view)
                }
                log("WINDOW_CREATED id=\(id) popup=\(popup) owner=\(header["owner"] ?? 0) dialog=\(dialog)")
                view.sendBounds()
            }
            guard let window = windows[id], let view = views[id] else { fail("Missing native window") }
            window.title = title
            if !window.inLiveResize, !view.closingRequested,
               Int(view.bounds.width) != width || Int(view.bounds.height) != height {
                window.setContentSize(NSSize(width: width, height: height))
            }
            positionPopup(id)
            for child in views.keys where views[child]?.popup == true || views[child]?.dialog == true { positionPopup(child) }
            log("WINDOW_META id=\(id) size=\(width)x\(height) at=\(header["x"] ?? 0),\(header["y"] ?? 0) title=\(title)")
        case "frame":
            guard let view = views[id] else { fail("Frame for unknown window") }
            let pixels = view.frame(header, pixels)
            if let tag = header["tag"] as? String, !tag.isEmpty {
                guard let rects = header["rects"] as? [[Int]], rects.count == 1, rects[0][0] == 0, rects[0][1] == 0,
                      rects[0][2] == header["width"] as? Int, rects[0][3] == header["height"] as? Int else {
                    fail("Snapshot frame is not a full capture")
                }
                guard tag.range(of: "^[a-zA-Z0-9-]{1,60}$", options: .regularExpression) != nil else {
                    fail("Invalid snapshot tag")
                }
                do {
                    try pixels.write(to: URL(fileURLWithPath: root + "/" + tag + ".bgra"))
                    try JSONSerialization.data(withJSONObject: header).write(to: URL(fileURLWithPath: root + "/" + tag + ".json"))
                    guard let width = header["width"] as? Int, let height = header["height"] as? Int,
                          let provider = CGDataProvider(data: pixels as CFData),
                          let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue).union(.byteOrder32Little),
                            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
                          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                        fail("Snapshot encoding failed")
                    }
                    try png.write(to: URL(fileURLWithPath: root + "/" + tag + ".png"))
                    log("WINDOW_SNAPSHOT tag=\(tag) id=\(id)")
                } catch { fail("Snapshot write: \(error)") }
            }
        case "probe":
            guard selftest, let tag = header["tag"] as? String,
                  tag.range(of: "^[a-zA-Z0-9-]{1,60}$", options: .regularExpression) != nil,
                  let width = header["width"] as? Int, let height = header["height"] as? Int,
                  pixels.count == width * height * 4 else { fail("Invalid probe") }
            do { try pixels.write(to: URL(fileURLWithPath: root + "/" + tag + ".probe.bgra")) }
            catch { fail("Probe write: \(error)") }
            log("WINDOW_PROBE tag=\(tag) id=\(id)")
        case "destroy":
            views[id]?.closingFromGuest = true
            if let owner = metadata[id]?["owner"] as? Int, views[id]?.dialog == true {
                views[owner]?.closingRequested = false
                windows[owner]?.ignoresMouseEvents = false
                windows[owner]?.makeKeyAndOrderFront(nil)
            }
            windows[id]?.parent?.removeChildWindow(windows[id]!)
            windows[id]?.close()
            views.removeValue(forKey: id)
            windows.removeValue(forKey: id)
            metadata.removeValue(forKey: id)
            log("WINDOW_DESTROYED id=\(id)")
            if mainCount > 0, !views.values.contains(where: { !$0.popup && !$0.dialog }) { stop() }
        default: fail("Unsupported event \(type)")
        }
    }
    func integration(_ type: String, _ header: [String: Any], _ payload: Data) -> Bool {
        switch type {
        case "clipboardSet": log("WINDOW_CLIPBOARD_SET kind=\(header["kind"] ?? "")")
        case "clipboardIgnored": log("WINDOW_CLIPBOARD_IGNORED reason=\(header["reason"] ?? "")")
        case "clipboard":
            guard configuration.integrations.clipboard,
                  header["kind"] as? String != "files" || configuration.integrations.files else {
                log("WINDOW_CLIPBOARD_REJECTED reason=host policy")
                return true
            }
            do { log("WINDOW_CLIPBOARD \(try Integrations.receiveClipboard(header, payload, root: root))") }
            catch { log("WINDOW_CLIPBOARD_REJECTED reason=\(error.localizedDescription)") }
        case "drop": log("WINDOW_DROP result=\(header["result"] ?? "")")
        case "openRejected": log("WINDOW_OPEN_REJECTED reason=\(header["reason"] ?? "")")
        case "open":
            guard configuration.integrations.externalUrls,
                  let text = header["url"] as? String, let url = Integrations.openableURL(text) else {
                log("WINDOW_OPEN_REJECTED reason=host policy")
                return true
            }
            log("WINDOW_OPEN url=\(url.absoluteString)")
            if !selftest { NSWorkspace.shared.open(url) }
        default: return false
        }
        return true
    }
    func positionPopup(_ id: Int) {
        guard let meta = metadata[id], views[id]?.popup == true || views[id]?.dialog == true, let child = windows[id],
              let owner = meta["owner"] as? Int, let parent = windows[owner],
              let parentMeta = metadata[owner], let x = meta["x"] as? Int, let y = meta["y"] as? Int,
              let px = parentMeta["x"] as? Int, let py = parentMeta["y"] as? Int,
              let height = meta["height"] as? Int, let content = parent.contentView else { return }
        let origin = parent.convertPoint(toScreen: NSPoint(x: 0, y: content.bounds.height))
        child.setFrameTopLeftPoint(NSPoint(x: origin.x + Double(x - px), y: origin.y - Double(y - py)))
        if child.parent !== parent { parent.addChildWindow(child, ordered: .above) }
        if views[id]?.dialog == true {
            parent.ignoresMouseEvents = true
            child.makeKeyAndOrderFront(nil)
            child.makeFirstResponder(views[id])
        } else { child.orderFront(nil) }
        if height < 1 { fail("Invalid popup height") }
    }
    func control(_ request: [String: Any]) {
        guard let action = request["action"] as? String else { fail("Missing host action") }
        if action == "stop" { stop(); return }
        if action == "focus", request["id"] == nil {
            NSApplication.shared.activate(ignoringOtherApps: true)
            for (id, window) in windows where views[id]?.popup == false { window.orderFront(nil) }
            if let window = windows.first(where: { views[$0.key]?.popup == false })?.value {
                window.makeKeyAndOrderFront(nil)
            }
            log("WINDOW_FOCUSED")
            return
        }
        if action == "stats" {
            log("WINDOW_STATS frames=\(frameCount) bytes=\(byteCount)")
            return
        }
        if action == "writePasteboard" {
            guard selftest else { fail("Pasteboard control is selftest-only") }
            do { try Integrations.writeTestPasteboard(request) } catch { fail("Test pasteboard: \(error)") }
            log("WINDOW_PASTEBOARD_WRITTEN")
            return
        }
        if action == "readPasteboard" {
            guard selftest, let tag = request["tag"] as? String,
                  tag.range(of: "^[a-zA-Z0-9-]{1,60}$", options: .regularExpression) != nil else { fail("Invalid pasteboard read") }
            do { try JSONSerialization.data(withJSONObject: Integrations.dumpTestPasteboard()).write(to: URL(fileURLWithPath: root + "/" + tag + ".pasteboard.json")) }
            catch { fail("Pasteboard dump: \(error)") }
            log("WINDOW_PASTEBOARD tag=\(tag)")
            return
        }
        if action == "frames" {
            let screen = NSScreen.main?.visibleFrame ?? .zero
            let frames = windows.mapValues { [$0.frame.minX, $0.frame.minY, $0.frame.width, $0.frame.height] }
            let body: [String: Any] = ["screen": [screen.minX, screen.minY, screen.width, screen.height],
                                       "windows": Dictionary(uniqueKeysWithValues: frames.map { (String($0.key), $0.value) })]
            do { log("WINDOW_FRAMES \(String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self))") }
            catch { fail("Frame dump: \(error)") }
            return
        }
        guard let id = request["id"] as? Int, let view = views[id], let window = windows[id] else {
            fail("Unknown control window")
        }
        if action == "testKey" {
            guard selftest, let code = request["code"] as? UInt16 else { fail("Invalid test key") }
            let raw = request["flags"] as? UInt ?? 0
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: raw),
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "",
                charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)!
            view.keyDown(with: event)
            view.keyUp(with: event)
            view.modifiers([])
        } else if action == "testClick" {
            guard selftest, let x = request["x"] as? Double, let y = request["y"] as? Double else { fail("Invalid test click") }
            let right = request["button"] as? String == "right"
            let event = NSEvent.mouseEvent(with: right ? .rightMouseDown : .leftMouseDown, location: NSPoint(x: x, y: view.bounds.height - y),
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                eventNumber: 1, clickCount: 1, pressure: 1)!
            if right { view.rightMouseDown(with: event); view.rightMouseUp(with: event) }
            else { view.mouseDown(with: event); view.mouseUp(with: event) }
        } else if action == "testDrop" {
            guard selftest, let x = request["x"] as? Double, let y = request["y"] as? Double,
                  let paths = request["paths"] as? [String] else { fail("Invalid test drop") }
            _ = view.drop(paths.map { URL(fileURLWithPath: $0) }, at: NSPoint(x: x, y: view.bounds.height - y))
        } else if action == "nativeMove" {
            // Top-left of the window frame, relative to the visible screen's top-left (points, y down).
            guard let x = request["x"] as? Double, let y = request["y"] as? Double, let screen = window.screen ?? NSScreen.main else {
                fail("Invalid host move")
            }
            window.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.minX + x, y: screen.visibleFrame.maxY - y))
        } else if action == "testMove" {
            // AppKit sends the key window moves anywhere on screen, so test offsets may lie outside the view.
            guard selftest, let x = request["x"] as? Double, let y = request["y"] as? Double else { fail("Invalid test move") }
            let event = NSEvent.mouseEvent(with: .mouseMoved, location: NSPoint(x: x, y: view.bounds.height - y),
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                eventNumber: 1, clickCount: 0, pressure: 0)!
            view.mouseMoved(with: event)
        } else if action == "testPostMove" {
            // A genuine move over this window (e.g. a popup panel), dispatched through the application event
            // queue so it takes the same routing as a real mouse. The location is in screen coordinates: AppKit
            // remaps a posted window-relative location via the screen under the real cursor, so a window-relative
            // post lands elsewhere whenever the cursor sits on a display with a different height.
            guard selftest, let x = request["x"] as? Double, let y = request["y"] as? Double else { fail("Invalid test move") }
            let location = window.convertPoint(toScreen: view.convert(NSPoint(x: x, y: view.bounds.height - y), to: nil))
            let event = NSEvent.mouseEvent(with: .mouseMoved, location: location,
                modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                eventNumber: 1, clickCount: 0, pressure: 0)!
            NSApplication.shared.postEvent(event, atStart: false)
        } else if action == "nativeResize" {
            guard let width = request["width"] as? Int, let height = request["height"] as? Int,
                  width >= 300, height >= 200, width <= 2400, height <= 1400 else { fail("Invalid host size") }
            window.setContentSize(NSSize(width: width, height: height))
        } else if action == "nativeClose" {
            window.performClose(nil)
        } else if action == "nativeSnapshot" {
            guard selftest, let tag = request["tag"] as? String,
                  tag.range(of: "^[a-zA-Z0-9-]{1,60}$", options: .regularExpression) != nil else {
                fail("Invalid native snapshot request")
            }
            view.requestDraw(snapshot: tag)
        } else { send(request) }
    }
    @objc func quit(_ sender: Any?) { stop() }
    func stop() {
        guard !stopping else { return }
        if configuration.stopGuestOnQuit { send(["action": "quit"]) }
        writeQueue.sync {}
        stopping = true
        NSCursor.arrow.set()
        do { try input.fileHandleForWriting.close() }
        catch { fputs("Window input close failed: \(error)\n", stderr) }
        if process.isRunning { process.terminate() }
        NSApplication.shared.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
guard CommandLine.arguments.count == 2 else {
    fail("Usage: app-host private-host-configuration.json")
}
let session = Session(configuration: HostConfiguration.read(CommandLine.arguments[1]))
let menu = NSMenu()
let item = NSMenuItem()
let submenu = NSMenu()
submenu.addItem(withTitle: "Quit Isolated App", action: #selector(Session.quit(_:)), keyEquivalent: "q").target = session
item.submenu = submenu
menu.addItem(item)
app.mainMenu = menu
app.activate(ignoringOtherApps: true)
session.start()
app.run()
