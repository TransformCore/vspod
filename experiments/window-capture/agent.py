#!/usr/bin/python3
"""Disposable XComposite window capture; stdout is a bounded binary protocol."""
import hashlib
import json
import os
import select
import struct
import sys
import time
import zlib

from Xlib import X, Xatom, display, error, protocol
from Xlib.ext import composite, damage, res, xfixes, xtest

MAX_WINDOWS = 24
MAX_PIXELS = 4096 * 2160
MAX_RECTS = 24
MAX_POINTER = 16384
# Above this share of the window, one full capture is cheaper than many small ones.
FULL_CAPTURE_SHARE = 0.6
# Small payloads are cheaper to send raw than to compress.
COMPRESS_MIN_BYTES = 16384
# Discovery is event-driven; this slow poll only backs up missed lifecycle events.
DISCOVERY_FALLBACK = 1.0
LIFECYCLE_EVENTS = (X.CreateNotify, X.DestroyNotify, X.MapNotify, X.UnmapNotify, X.ConfigureNotify, X.ReparentNotify)
CURSOR_THEME = "/usr/share/icons/Adwaita/cursors"
MAX_CURSOR_NAMES = 16
XCURSOR_IMAGE = 0xFFFD0002


def xcursor_frames(data):
    """Yields (nominal_size, ARGB bytes) for each image chunk of an Xcursor file."""
    if data[:4] != b"Xcur" or len(data) < 16:
        return
    header, _, count = struct.unpack_from("<III", data, 4)
    for index in range(min(count, 1024)):
        if header + index * 12 + 12 > len(data):
            return
        kind, size, position = struct.unpack_from("<III", data, header + index * 12)
        if kind != XCURSOR_IMAGE or position + 36 > len(data):
            continue
        width, height = struct.unpack_from("<II", data, position + 16)
        if not (1 <= width <= 256 and 1 <= height <= 256) or position + 36 + width * height * 4 > len(data):
            continue
        yield size, data[position + 36:position + 36 + width * height * 4]


def cursor_fingerprints(directory=CURSOR_THEME):
    """Maps the hash of every theme cursor image to its names. Chromium sets unnamed X cursors loaded
    from this theme, so matching pixels is the only way to recover the CSS cursor for native mapping."""
    table = {}
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return table
    for name in names:
        try:
            with open(os.path.join(directory, name), "rb") as handle:
                data = handle.read(4 * 1024 * 1024)
        except OSError:
            continue
        for _, pixels in xcursor_frames(data):
            table.setdefault(hashlib.sha1(pixels).digest(), set()).add(name)
    return {key: sorted(value)[:MAX_CURSOR_NAMES] for key, value in table.items()}


def add_rect(rects, rect):
    """Merges a damaged (x0, y0, x1, y1) rectangle into a small overlapping-union list."""
    x0, y0, x1, y1 = rect
    merged = True
    while merged:
        merged = False
        for other in rects:
            if x0 <= other[2] and other[0] <= x1 and y0 <= other[3] and other[1] <= y1:
                rects.remove(other)
                x0, y0, x1, y1 = min(x0, other[0]), min(y0, other[1]), max(x1, other[2]), max(y1, other[3])
                merged = True
                break
    rects.append((x0, y0, x1, y1))
    if len(rects) > MAX_RECTS:
        box = (min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects))
        rects.clear()
        rects.append(box)


class Agent:
    def __init__(self):
        self.d = display.Display()
        self.root = self.d.screen().root
        self.root_size = (self.d.screen().width_in_pixels, self.d.screen().height_in_pixels)
        self.d.composite_query_version()
        self.d.damage_query_version()
        self.d.xfixes_query_version()
        self.cursor_serial = None
        self.cursor_names = cursor_fingerprints()
        self.windows = {}
        self.focus = None
        self.pressed = set()
        self.buttons = set()
        self.atoms = {}
        self.failure = None
        self.damage_error = self.d.query_extension("DAMAGE").first_error
        self.damage_event = self.d.extension_event.DamageNotify
        # XFixesCursorNotify is event 1 of the extension.
        self.cursor_event = self.d.query_extension("XFIXES").first_event + 1
        self.cursor_changed = True
        self.rediscover = True
        self.last_input = None
        self.watched_properties = {self.atom(name) for name in ("_NET_CLIENT_LIST", "_NET_WM_NAME", "WM_NAME", "WM_TRANSIENT_FOR")}
        self.root.change_attributes(event_mask=X.SubstructureNotifyMask | X.PropertyChangeMask)
        self.d.xfixes_select_cursor_input(self.root, xfixes.XFixesDisplayCursorNotifyMask)
        self.d.set_error_handler(self.xerror)

    def xerror(self, exception, request):
        # Windows can disappear between discovery and an asynchronous X request.
        if not isinstance(exception, (error.BadWindow, error.BadDrawable, error.BadPixmap, error.BadMatch)) and exception.code != self.damage_error:
            self.failure = exception
            return
        print(f"X lifecycle race: {exception.__class__.__name__}", file=sys.stderr)

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.d.intern_atom(name)
        return self.atoms[name]

    def prop(self, window, name, kind=X.AnyPropertyType):
        value = window.get_full_property(self.atom(name), kind)
        return value.value if value else None

    def send(self, header, pixels=b""):
        header["bytes"] = len(pixels)
        encoded = json.dumps(header, separators=(",", ":")).encode()
        sys.stdout.buffer.write(struct.pack("!I", len(encoded)) + encoded + pixels)
        sys.stdout.buffer.flush()

    def message(self, window, name, values):
        self.root.send_event(protocol.event.ClientMessage(
            window=window, client_type=self.atom(name), data=(32, values)),
            event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        self.d.flush()

    def metadata(self, window, popup=False):
        attrs = window.get_attributes()
        if attrs.map_state != X.IsViewable or attrs.win_class != X.InputOutput:
            return None
        geometry = window.get_geometry()
        if not 1 <= geometry.width <= 4096 or not 1 <= geometry.height <= 2160 or geometry.width * geometry.height > MAX_PIXELS:
            raise ValueError("Guest window exceeds capture dimensions")
        origin = self.root.translate_coords(window, 0, 0)
        transient = window.get_wm_transient_for()
        owner = transient.id if transient else 0
        if popup and not owner:
            owner = self.focus or 0
        title = self.prop(window, "_NET_WM_NAME")
        title = bytes(title).decode("utf-8", errors="replace") if title is not None else window.get_wm_name() or ""
        return dict(id=window.id, title=title[:1024], x=origin.x, y=origin.y,
                    width=geometry.width, height=geometry.height, popup=popup, owner=owner,
                    dialog=bool(owner) and not popup)

    def discover(self):
        ids = self.prop(self.root, "_NET_CLIENT_LIST", Xatom.WINDOW)
        candidates = []
        for wid in ids if ids is not None else []:
            window = self.d.create_resource_object("window", int(wid))
            try:
                cls = window.get_wm_class()
                if cls and any(part.lower() == "code" for part in cls):
                    candidates.append((window, False))
            except error.BadWindow:
                continue
        resources = self.d.res_query_clients().clients
        code_owners = [(client.resource_base, client.resource_mask) for client in resources
                       if any(window.id & ~client.resource_mask == client.resource_base for window, _ in candidates)]
        # Menus/tooltips bypass the WM and therefore do not occur in _NET_CLIENT_LIST.
        for window in self.root.query_tree().children:
            try:
                attrs = window.get_attributes()
                cls = window.get_wm_class()
                owned = any(window.id & ~mask == base for base, mask in code_owners)
                if attrs.override_redirect and owned and (cls is None or any(part.lower() == "code" for part in cls)):
                    candidates.append((window, True))
            except error.BadWindow:
                continue
        found = set()
        for window, popup in candidates:
            try:
                meta = self.metadata(window, popup)
                if meta is None:
                    continue
                found.add(window.id)
                state = self.windows.get(window.id)
                if state is None:
                    if len(self.windows) >= MAX_WINDOWS:
                        raise ValueError("Too many guest windows")
                    window.composite_redirect_window(composite.RedirectAutomatic)
                    window.change_attributes(event_mask=X.StructureNotifyMask | X.PropertyChangeMask)
                    damage_id = window.damage_create(damage.DamageReportRawRectangles)
                    self.d.sync()
                    state = dict(window=window, damage=damage_id, dirty=True, full=True, rects=[], pixmap=None, meta=None, sequence=0)
                    self.windows[window.id] = state
                if state["meta"] != meta:
                    if state["meta"] is None or any(state["meta"][key] != meta[key] for key in ("width", "height")):
                        if state["pixmap"]:
                            state["pixmap"].free()
                        state["pixmap"] = window.composite_name_window_pixmap()
                        state["dirty"] = state["full"] = True
                    state["meta"] = meta
                    self.send(dict(type="window", **meta))
            except (error.BadWindow, error.BadDrawable, error.BadMatch):
                print("Window disappeared during discovery", file=sys.stderr)
        for wid in set(self.windows) - found:
            state = self.windows.pop(wid)
            self.d.damage_destroy(state["damage"])
            if state["pixmap"]:
                state["pixmap"].free()
            self.send(dict(type="destroy", id=wid))
            if self.focus == wid:
                self.release()
                self.focus = None

    def release(self):
        for key in self.pressed:
            xtest.fake_input(self.d, X.KeyRelease, key)
        for button in self.buttons:
            xtest.fake_input(self.d, X.ButtonRelease, button)
        self.pressed.clear()
        self.buttons.clear()
        self.d.flush()

    def activate(self, wid, pointer_motion=False):
        state = self.windows[wid]
        if state["meta"]["popup"]:
            return
        if self.focus != wid:
            self.release()
            self.message(state["window"], "_NET_ACTIVE_WINDOW", [2, X.CurrentTime, 0, 0, 0])
            state["window"].set_input_focus(X.RevertToParent, X.CurrentTime)
            self.d.sync()
            self.focus = wid
        if not pointer_motion and not any(other["meta"]["popup"] and other["meta"]["owner"] == wid for other in self.windows.values()):
            state["window"].set_input_focus(X.RevertToParent, X.CurrentTime)

    def command(self, request):
        action = request.get("action")
        if action == "quit":
            return False
        if action == "release":
            self.release()
            return True
        wid = request.get("id")
        if type(wid) is not int or wid not in self.windows:
            self.send(dict(type="rejected", id=wid, action=action, message="Unknown guest window"))
            return True
        state = self.windows[wid]
        if action in ("key", "mouse") and request.get("down") is True:
            self.last_input = time.monotonic()
        if action == "close":
            self.message(state["window"], "_NET_CLOSE_WINDOW", [X.CurrentTime, 2, 0, 0, 0])
        elif action == "resize":
            width, height = request["width"], request["height"]
            if type(width) is not int or type(height) is not int or not 300 <= width <= 2400 or not 200 <= height <= 1400:
                raise ValueError("Invalid native resize")
            state["window"].configure(width=width, height=height)
        elif action == "focus":
            self.activate(wid)
        elif action == "key":
            self.activate(wid)
            key, down = request["key"], request["down"]
            if type(key) is not int or not 8 <= key <= 255 or type(down) is not bool:
                raise ValueError("Invalid X key")
            xtest.fake_input(self.d, X.KeyPress if down else X.KeyRelease, key)
            (self.pressed.add if down else self.pressed.discard)(key)
        elif action == "mouse":
            x, y, button, down = request["x"], request["y"], request["button"], request["down"]
            self.activate(wid, pointer_motion=button == 0)
            meta = state["meta"]
            if (type(x) is not int or type(y) is not int or not -MAX_POINTER <= x <= MAX_POINTER
                    or not -MAX_POINTER <= y <= MAX_POINTER
                    or type(button) is not int or not 0 <= button <= 7 or type(down) is not bool):
                raise ValueError("Invalid local pointer input")
            # Coordinates are relative to this window but may lie outside it: the host's key window also
            # reports moves over its popups and beyond its frame. Mapping through the root keeps those on
            # the same guest location instead of clamping onto this window's edge (e.g. the menu bar).
            rx, ry = meta["x"] + x, meta["y"] + y
            width, height = self.root_size
            if not (0 <= rx < width and 0 <= ry < height):
                if not button:
                    return True
                rx, ry = min(max(rx, 0), width - 1), min(max(ry, 0), height - 1)
            xtest.fake_input(self.d, X.MotionNotify, x=rx, y=ry)
            if button:
                xtest.fake_input(self.d, X.ButtonPress if down else X.ButtonRelease, button)
                (self.buttons.add if down else self.buttons.discard)(button)
        elif action == "probe":
            # Test-only full capture that the host records without applying, so it cannot repair a stale texture.
            meta = state["meta"]
            image = state["pixmap"].get_image(0, 0, meta["width"], meta["height"], X.ZPixmap, 0xffffffff)
            self.send(dict(type="probe", id=wid, width=meta["width"], height=meta["height"],
                           tag=str(request.get("tag", ""))[:80]), image.data)
        elif action == "snapshot":
            state["dirty"] = state["full"] = True
            state["snapshot"] = request.get("tag", "")[:80]
        elif action == "bounds":
            # Screen bounds drive Wayland popup constraints; X11 clients position their own override-redirect menus.
            pass
        else:
            raise ValueError("Unsupported window command")
        self.d.flush()
        return True

    def capture(self):
        for state in list(self.windows.values()):
            if not state["dirty"] or not state["pixmap"]:
                continue
            meta = state["meta"]
            width, height = meta["width"], meta["height"]
            rects = [(max(0, x0), max(0, y0), min(width, x1), min(height, y1)) for x0, y0, x1, y1 in state["rects"]]
            rects = [r for r in rects if r[2] > r[0] and r[3] > r[1]]
            if state["full"] or sum((r[2] - r[0]) * (r[3] - r[1]) for r in rects) > FULL_CAPTURE_SHARE * width * height:
                rects = [(0, 0, width, height)]
            state["dirty"] = state["full"] = False
            state["rects"] = []
            if not rects:
                continue
            try:
                started = time.monotonic()
                chunks = []
                for x0, y0, x1, y1 in rects:
                    image = state["pixmap"].get_image(x0, y0, x1 - x0, y1 - y0, X.ZPixmap, 0xffffffff)
                    if image is None or len(image.data) != (x1 - x0) * (y1 - y0) * 4:
                        raise ValueError("Expected tightly packed 32-bit X pixels")
                    chunks.append(image.data)
                payload = b"".join(chunks)
                captured = time.monotonic()
                encoding = None
                if len(payload) >= COMPRESS_MIN_BYTES:
                    # Raw DEFLATE at level 1: flat editor backgrounds compress well and the pipe is the bottleneck.
                    compressor = zlib.compressobj(1, zlib.DEFLATED, -15)
                    payload = compressor.compress(payload) + compressor.flush()
                    encoding = "deflate"
                state["sequence"] += 1
                # Raw-rectangle events do not need it, but keep the server-side region bounded.
                self.d.damage_subtract(state["damage"])
                self.send(dict(type="frame", id=meta["id"], width=width, height=height,
                               rects=[[x0, y0, x1 - x0, y1 - y0] for x0, y0, x1, y1 in rects],
                               sequence=state["sequence"], tag=state.pop("snapshot", ""),
                               cap_us=int((captured - started) * 1e6),
                               dirty_us=int((started - state.pop("dirty_at", started)) * 1e6),
                               input_us=int((started - (self.last_input or started)) * 1e6),
                               encoding=encoding, comp_us=int((time.monotonic() - captured) * 1e6)), payload)
            except (error.BadWindow, error.BadDrawable, error.BadMatch):
                print("Window disappeared during capture", file=sys.stderr)

    def cursor(self):
        if not self.cursor_changed:
            return
        self.cursor_changed = False
        cursor = self.d.xfixes_get_cursor_image(self.root)
        if cursor.cursor_serial == self.cursor_serial:
            return
        if not 1 <= cursor.width <= 256 or not 1 <= cursor.height <= 256:
            raise ValueError("Cursor exceeds spike dimensions")
        pixels = struct.pack("<" + "I" * len(cursor.cursor_image), *cursor.cursor_image)
        names = self.cursor_names.get(hashlib.sha1(pixels).digest(), [])
        self.send(dict(type="cursor", width=cursor.width, height=cursor.height, names=names,
                       xhot=cursor.xhot, yhot=cursor.yhot, serial=cursor.cursor_serial), pixels)
        self.cursor_serial = cursor.cursor_serial

    def event(self, event):
        if event.type == self.damage_event:
            for state in self.windows.values():
                if event.damage == state["damage"]:
                    if not state["dirty"]:
                        state["dirty_at"] = time.monotonic()
                    state["dirty"] = True
                    area = event.area
                    add_rect(state["rects"], (area.x, area.y, area.x + area.width, area.y + area.height))
        elif event.type == self.cursor_event:
            self.cursor_changed = True
        elif event.type in LIFECYCLE_EVENTS:
            self.rediscover = True
        elif event.type == X.PropertyNotify and event.atom in self.watched_properties:
            self.rediscover = True

    def run(self):
        self.send(dict(type="ready", composite=True, damage=True))
        data = bytearray()
        last_discovery = 0
        while True:
            if self.failure:
                raise self.failure
            if self.rediscover or time.monotonic() - last_discovery >= DISCOVERY_FALLBACK:
                self.rediscover = False
                self.discover()
                last_discovery = time.monotonic()
            while self.d.pending_events():
                self.event(self.d.next_event())
            self.capture()
            self.cursor()
            # Replies read during capture can leave events queued that select() cannot see.
            waiting = self.d.pending_events() or self.rediscover or self.cursor_changed
            timeout = 0 if waiting else max(0, DISCOVERY_FALLBACK - (time.monotonic() - last_discovery))
            ready, _, _ = select.select([self.d, sys.stdin.buffer], [], [], timeout)
            if sys.stdin.buffer in ready:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 65536:
                    raise ValueError("Input command exceeds limit")
                while b"\n" in data:
                    line, _, data = data.partition(b"\n")
                    if not self.command(json.loads(line)):
                        self.release()
                        return
        self.release()


if __name__ == "__main__":
    try:
        Agent().run()
    except Exception as exception:
        print(f"Window agent failed: {exception}", file=sys.stderr)
        raise
