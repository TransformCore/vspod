import AppKit
import WebKit

struct Session: Decodable {
    let url: String
    let capability: String
    let reportPath: String
    let autoTest: Bool
    let snapshotPath: String?
    let dropFixturePaths: [String]?
    let dropReportPath: String?
}

final class DropWebView: WKWebView {
    var dropped: (([URL], NSPoint) -> Bool)?

    func acceptDrop(_ pasteboard: NSPasteboard, at point: NSPoint, operation: NSDragOperation) -> Bool {
        guard operation.contains(.copy), bounds.contains(point),
              let urls = pasteboard.readObjects(forClasses: [NSURL.self],
                options: [.urlReadingFileURLsOnly: true]) as? [URL],
              !urls.isEmpty, urls.count <= 100, urls.allSatisfy(\.isFileURL) else { return false }
        return dropped?(urls, point) ?? false
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard dropped != nil else { return super.draggingEntered(sender) }
        guard sender.draggingSourceOperationMask.contains(.copy),
              sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self],
                options: [.urlReadingFileURLsOnly: true]) else { return [] }
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        draggingEntered(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard dropped != nil else { return super.prepareForDragOperation(sender) }
        return draggingEntered(sender) == .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard dropped != nil else { return super.performDragOperation(sender) }
        return acceptDrop(sender.draggingPasteboard,
                   at: convert(sender.draggingLocation, from: nil),
                   operation: sender.draggingSourceOperationMask)
    }
}

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var view: DropWebView!
    var session: Session!
    var timer: Timer?
    var ticks = 0
    var snapshotTaken = false
    var dropTested = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            session = try JSONDecoder().decode(Session.self, from: FileHandle.standardInput.readDataToEndOfFile())
            guard let url = URL(string: session.url), url.scheme == "http", url.host == "127.0.0.1",
                  session.capability.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                throw NSError(domain: "Invalid session", code: 1)
            }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            view = DropWebView(frame: .zero, configuration: configuration)
            if let report = session.dropReportPath {
                view.registerForDraggedTypes([.fileURL])
                view.dropped = { urls, point in
                    let y = self.view.isFlipped ? point.y : self.view.bounds.height - point.y
                    let record: [String: Any] = [
                        "paths": urls.map(\.path), "x": Int(point.x), "y": Int(y),
                        "width": Int(self.view.bounds.width), "height": Int(self.view.bounds.height),
                        "operation": "copy"
                    ]
                    do {
                        try JSONSerialization.data(withJSONObject: record).write(
                            to: URL(fileURLWithPath: report), options: .atomic)
                        return true
                    } catch {
                        fputs("Unable to record native file drop.\n", stderr)
                        return false
                    }
                }
            }
            view.navigationDelegate = self
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
            window.title = "VSPod — Isolated Desktop Spike"
            window.contentView = view
            window.delegate = self
            window.center()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            let cookie = HTTPCookie(properties: [
                .domain: "127.0.0.1", .path: "/", .name: "vspod_spike",
                .value: session.capability, HTTPCookiePropertyKey("HttpOnly"): "TRUE"
            ])!
            configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                self.view.load(URLRequest(url: url))
            }
            timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
                self.view.evaluateJavaScript("({connected:window.spikeConnected===true,width:innerWidth,height:innerHeight})") { value, error in
                    guard error == nil, let value = value, JSONSerialization.isValidJSONObject(value) else { return }
                    do {
                        let data = try JSONSerialization.data(withJSONObject: value)
                        try data.write(to: URL(fileURLWithPath: self.session.reportPath), options: .atomic)
                    } catch { fputs("Unable to write display acceptance status.\n", stderr) }
                    if let state = value as? [String: Any], state["connected"] as? Bool == true, self.session.autoTest {
                        self.ticks += 1
                        if self.ticks == 3 { self.window.setContentSize(NSSize(width: 900, height: 600)) }
                        if self.ticks == 6 { self.window.setContentSize(NSSize(width: 1200, height: 800)) }
                        if self.ticks >= 8, !self.dropTested, let paths = self.session.dropFixturePaths {
                            self.dropTested = true
                            let board = NSPasteboard(name: NSPasteboard.Name("org.vspod.drop-spike.\(UUID().uuidString)"))
                            defer { board.releaseGlobally() }
                            let point = NSPoint(x: 150, y: self.view.isFlipped ? 130 : self.view.bounds.height - 130)
                            board.setString("Unsupported text-only drop fixture", forType: .string)
                            guard !self.view.acceptDrop(board, at: point, operation: .copy) else {
                                fputs("Native receiver accepted an unsupported drop type.\n", stderr)
                                NSApp.terminate(nil)
                                return
                            }
                            board.clearContents()
                            guard board.writeObjects(paths.map { NSURL(fileURLWithPath: $0) }),
                                  !self.view.acceptDrop(board, at: point, operation: .move),
                                  !self.view.acceptDrop(board, at: NSPoint(x: -1, y: -1), operation: .copy),
                                  self.view.acceptDrop(board, at: point, operation: .copy) else {
                                fputs("Native drop receiver self-test failed.\n", stderr)
                                NSApp.terminate(nil)
                                return
                            }
                        }
                        if self.ticks >= 8, !self.snapshotTaken, let path = self.session.snapshotPath {
                            self.snapshotTaken = true
                            self.view.takeSnapshot(with: nil) { image, error in
                                guard error == nil, let image = image,
                                      let tiff = image.tiffRepresentation,
                                      let bitmap = NSBitmapImageRep(data: tiff),
                                      let png = bitmap.representation(using: .png, properties: [:]) else {
                                    fputs("Unable to capture experimental viewer snapshot.\n", stderr)
                                    return
                                }
                                do { try png.write(to: URL(fileURLWithPath: path), options: .atomic) }
                                catch { fputs("Unable to save experimental viewer snapshot.\n", stderr) }
                            }
                        }
                    }
                }
            }
        } catch {
            fputs("Unable to initialize the isolated desktop client.\n", stderr)
            NSApp.terminate(nil)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url, let allowed = URL(string: session.url) else {
            decisionHandler(.cancel); return
        }
        decisionHandler(target.scheme == allowed.scheme && target.host == allowed.host && target.port == allowed.port ? .allow : .cancel)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
