import AppKit

struct WheelAccumulator {
    var remainder = 0.0
    mutating func steps(delta: Double, precise: Bool) -> [Int] {
        // Preserve sub-unit trackpad movement instead of rounding every event up.
        let movement = delta * (precise ? 3 : 120)
        if movement * remainder < 0 { remainder = 0 }
        remainder += movement
        var units = Int(remainder.rounded(.towardZero))
        remainder -= Double(units)
        var packets: [Int] = []
        while units != 0 {
            let packet = min(255, max(-255, units))
            packets.append(packet)
            units -= packet
        }
        return packets
    }
}

class InputView: NSImageView, NSWindowDelegate {
    var remoteWidth = 1100
    var remoteHeight = 750
    var modifierCodes = Set<UInt16>()
    var pressedCodes = Set<UInt16>()
    var resizeWork: DispatchWorkItem?
    var tracking: NSTrackingArea?
    var verticalWheel = WheelAccumulator()
    var horizontalWheel = WheelAccumulator()
    var automatedInputOnly = false
    var sendInput: (String) -> Void = { _ in fatalError("Input transport not configured") }
    let scanCodes: [UInt16: UInt16] = [
        0: 0x1e, 1: 0x1f, 2: 0x20, 3: 0x21, 4: 0x23, 5: 0x22, 6: 0x2c,
        7: 0x2d, 8: 0x2e, 9: 0x2f, 11: 0x30, 12: 0x10, 13: 0x11, 14: 0x12,
        15: 0x13, 16: 0x15, 17: 0x14, 18: 0x02, 19: 0x03, 20: 0x04, 21: 0x05,
        22: 0x07, 23: 0x06, 24: 0x0d, 25: 0x0a, 26: 0x08, 27: 0x0c, 28: 0x09,
        29: 0x0b, 30: 0x1b, 31: 0x18, 32: 0x16, 33: 0x1a, 34: 0x17, 35: 0x19,
        37: 0x26, 38: 0x24, 39: 0x28, 40: 0x25, 41: 0x27, 42: 0x2b, 43: 0x33,
        44: 0x35, 45: 0x31, 46: 0x32, 47: 0x34, 50: 0x29
    ]
    let specialCodes: [UInt16: UInt16] = [
        36: 0x1c, 48: 0x0f, 49: 0x39, 51: 0x0e, 53: 0x01, 76: 0x11c,
        115: 0x147, 116: 0x149, 117: 0x153, 119: 0x14f, 121: 0x151,
        123: 0x14b, 124: 0x14d, 125: 0x150, 126: 0x148,
        122: 0x3b, 120: 0x3c, 99: 0x3d, 118: 0x3e, 96: 0x3f, 97: 0x40,
        98: 0x41, 100: 0x42, 101: 0x43, 109: 0x44, 103: 0x57, 111: 0x58
    ]

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        tracking = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(tracking!)
    }

    func scan(_ code: UInt16, down: Bool) {
        sendInput("K \((code & 0x100) | (down ? 0 : 0x8000)) \(code & 0x7f)")
        if down { pressedCodes.insert(code) } else { pressedCodes.remove(code) }
    }

    func modifiers(_ flags: NSEvent.ModifierFlags) {
        var target = Set<UInt16>()
        if flags.contains(.command) || flags.contains(.control) { target.insert(0x1d) }
        if flags.contains(.shift) { target.insert(0x2a) }
        if flags.contains(.option) { target.insert(0x38) }
        for code in modifierCodes.subtracting(target) { scan(code, down: false) }
        for code in target.subtracting(modifierCodes) { scan(code, down: true) }
        modifierCodes = target
    }

    // Acceptance fixtures use timestamp zero; real mouse movement must not redirect their remote input.
    func acceptsInput(_ event: NSEvent) -> Bool { !automatedInputOnly || event.timestamp == 0 }
    override func flagsChanged(with event: NSEvent) {
        if acceptsInput(event) { modifiers(event.modifierFlags) }
    }
    override func keyDown(with event: NSEvent) {
        guard acceptsInput(event) else { return }
        modifiers(event.modifierFlags)
        if event.modifierFlags.contains(.command), event.keyCode == 12 {
            window?.performClose(nil)
            return
        }
        if let code = specialCodes[event.keyCode] ?? scanCodes[event.keyCode] { scan(code, down: true) }
        else { NSSound.beep() }
    }
    override func keyUp(with event: NSEvent) {
        guard acceptsInput(event) else { return }
        if let code = specialCodes[event.keyCode] ?? scanCodes[event.keyCode] { scan(code, down: false) }
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown, event.modifierFlags.contains(.command) else { return false }
        keyDown(with: event)
        keyUp(with: event)
        return true
    }

    func mouse(_ event: NSEvent, flags: Int) {
        guard acceptsInput(event) else { return }
        modifiers(event.modifierFlags)
        let point = convert(event.locationInWindow, from: nil)
        let x = min(remoteWidth - 1, max(0, Int(point.x * Double(remoteWidth) / max(1, bounds.width))))
        let y = min(remoteHeight - 1, max(0, Int((bounds.height - point.y) * Double(remoteHeight) / max(1, bounds.height))))
        sendInput("M \(flags) \(x) \(y)")
    }
    override func mouseMoved(with event: NSEvent) { mouse(event, flags: 0x0800) }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        mouse(event, flags: 0x9000)
    }
    override func mouseUp(with event: NSEvent) { mouse(event, flags: 0x1000) }
    override func mouseDragged(with event: NSEvent) { mouse(event, flags: 0x0800) }
    override func rightMouseDown(with event: NSEvent) { mouse(event, flags: 0xa000) }
    override func rightMouseUp(with event: NSEvent) { mouse(event, flags: 0x2000) }
    override func rightMouseDragged(with event: NSEvent) { mouse(event, flags: 0x0800) }
    override func otherMouseDown(with event: NSEvent) { mouse(event, flags: 0xc000) }
    override func otherMouseUp(with event: NSEvent) { mouse(event, flags: 0x4000) }
    override func otherMouseDragged(with event: NSEvent) { mouse(event, flags: 0x0800) }
    override func scrollWheel(with event: NSEvent) {
        guard acceptsInput(event) else { return }
        if event.phase == .began || event.phase == .cancelled {
            verticalWheel = WheelAccumulator()
            horizontalWheel = WheelAccumulator()
        }
        scroll(event, deltaY: event.scrollingDeltaY, deltaX: event.scrollingDeltaX,
               precise: event.hasPreciseScrollingDeltas)
        if event.momentumPhase == .ended || event.phase == .cancelled {
            verticalWheel = WheelAccumulator()
            horizontalWheel = WheelAccumulator()
        }
    }
    func scroll(_ event: NSEvent, deltaY: Double, deltaX: Double, precise: Bool) {
        let vertical = verticalWheel.steps(delta: deltaY, precise: precise)
        let horizontal = horizontalWheel.steps(delta: deltaX, precise: precise)
        if !vertical.isEmpty || !horizontal.isEmpty { mouse(event, flags: 0x0800) }
        for (steps, flag) in [(vertical, 0x0200), (horizontal, 0x0400)] {
            for step in steps { mouse(event, flags: flag | (step & 0x01ff)) }
        }
    }
    func windowDidResignKey(_ notification: Notification) {
        if automatedInputOnly && notification.object != nil { return }
        verticalWheel = WheelAccumulator()
        horizontalWheel = WheelAccumulator()
        modifiers([])
        for code in pressedCodes { scan(code, down: false) }
        for button in [0x1000, 0x2000, 0x4000] { sendInput("M \(button) 0 0") }
    }
    func windowDidResize(_ notification: Notification) {
        resizeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let width = min(4096, max(200, Int(bounds.width) / 2 * 2))
            let height = min(4096, max(200, Int(bounds.height)))
            sendInput("R \(width) \(height)")
        }
        resizeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }
    func windowWillClose(_ notification: Notification) {
        modifiers([])
        sendInput("Q")
        exit(0)
    }
}
