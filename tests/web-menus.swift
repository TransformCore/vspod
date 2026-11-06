import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let configuration = try JSONSerialization.jsonObject(with: Data(contentsOf: input)) as! [String: String]
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1400, height: 900))
let window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.contentView = web
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(web)
app.activate(ignoringOtherApps: true)
let cookie = HTTPCookie(properties: [.name: configuration["cookieName"]!, .value: configuration["cookieValue"]!,
                                   .domain: "127.0.0.1", .path: "/"])!
web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
    web.load(URLRequest(url: URL(string: configuration["origin"]! + "/?folder=/workspace")!))
}

let script = """
(() => {
    const trust = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')]
        .find(button => button.textContent.includes('Yes, I trust'));
    if (trust) { trust.click(); return null; }
    const editors = [...document.querySelectorAll('.editor-instance .monaco-editor')];
    if (editors.length < 2) return null;
    const menu = document.querySelector('.menubar-menu-button[aria-label="View"]');
    if (!menu || menu.getBoundingClientRect().width === 0) return null;
    const holder = menu.querySelector('.menubar-menu-items-holder');
    if (!holder) {
        const bounds = menu.getBoundingClientRect();
        menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0,
            clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, view: window }));
        return null;
    }
    const bounds = holder.getBoundingClientRect();
    if (bounds.height < 100) return null;
    const points = [];
    for (const editor of editors) {
        const rect = editor.getBoundingClientRect();
        const left = Math.max(bounds.left, rect.left), right = Math.min(bounds.right, rect.right);
        const top = Math.max(bounds.top, rect.top), bottom = Math.min(bounds.bottom, rect.bottom);
        if (right - left < 10 || bottom - top < 10) continue;
        for (const fraction of [.1, .5, .9]) {
            const x = left + (right - left) * .8, y = top + (bottom - top) * fraction;
            const hit = document.elementFromPoint(x, y);
            points.push({ x, y, inside: !!hit && holder.contains(hit) });
        }
    }
    const titlebar = getComputedStyle(document.querySelector('.part.titlebar'));
    return { points, editorCount: editors.length, userAgent: navigator.userAgent,
        titlebar: { overflow: titlebar.overflow, zIndex: titlebar.zIndex } };
})()
"""

let deadline = Date().addingTimeInterval(60)
var evaluating = false
Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { timer in
    if Date() > deadline { fputs("Timed out waiting for a menu over two real editor panes\n", stderr); exit(1) }
    if evaluating { return }
    evaluating = true
    web.evaluateJavaScript(script) { result, error in
        if let error { fputs("Menu probe: \(error)\n", stderr); exit(1) }
        guard let value = result as? [String: Any] else { evaluating = false; return }
        timer.invalidate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            web.takeSnapshot(with: nil) { image, error in
                if let error { fputs("Menu snapshot: \(error)\n", stderr); exit(1) }
                do {
                    try JSONSerialization.data(withJSONObject: value)
                        .write(to: input.deletingLastPathComponent().appendingPathComponent("menu-result.json"))
                    guard let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                          let png = bitmap.representation(using: .png, properties: [:]) else {
                        fputs("Cannot encode native WebKit menu snapshot\n", stderr); exit(1)
                    }
                    try png.write(to: input.deletingLastPathComponent().appendingPathComponent("menu.png"))
                    exit(0)
                } catch { fputs("Menu evidence: \(error)\n", stderr); exit(1) }
            }
        }
    }
}
app.run()
