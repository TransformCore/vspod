#!/usr/bin/python3
"""Bounded copy-only XDND source for the disposable desktop experiment."""
import json
from pathlib import Path
import select
import sys
import time

from Xlib import X, Xatom, display, protocol


def drop(request):
    connection = display.Display()
    root = connection.screen().root
    source = root.create_window(0, 0, 1, 1, 0, X.CopyFromParent,
                                event_mask=X.PropertyChangeMask)
    atoms = {name: connection.intern_atom(name) for name in (
        "XdndAware", "XdndEnter", "XdndPosition", "XdndStatus", "XdndLeave",
        "XdndDrop", "XdndFinished", "XdndSelection", "XdndActionCopy",
        "text/uri-list", "TARGETS",
    )}
    paths = request["paths"]
    if not isinstance(paths, list) or not 1 <= len(paths) <= 100:
        raise ValueError("Invalid drop file list")
    for path in paths:
        resolved = Path(path).resolve(strict=True)
        if str(resolved) != path or Path("/tmp/clipboard-transfers") not in resolved.parents:
            raise ValueError("Drop files must be explicit staged container paths")
    payload = ("\r\n".join(Path(path).as_uri() for path in paths) + "\r\n").encode()
    if len(payload) > 65536:
        raise ValueError("Drop URI list exceeds limit")
    x, y = request["x"], request["y"]
    geometry = root.get_geometry()
    if not isinstance(x, int) or not isinstance(y, int) or not 0 <= x < geometry.width or not 0 <= y < geometry.height:
        raise ValueError("Drop coordinates outside framebuffer")
    target = connection.create_resource_object("window", int(request["window"], 16))
    aware = target.get_full_property(atoms["XdndAware"], Xatom.ATOM)
    if aware is None or not len(aware.value):
        raise ValueError("Target does not advertise XDND")
    version = min(int(aware.value[0]), 5)
    source.set_selection_owner(atoms["XdndSelection"], X.CurrentTime)
    source.change_property(atoms["XdndAware"], Xatom.ATOM, 32, [5])
    root.warp_pointer(x, y)
    connection.sync()

    def send(kind, values):
        target.send_event(protocol.event.ClientMessage(
            window=target, client_type=atoms[kind], data=(32, values),
        ), event_mask=0)
        connection.flush()

    send("XdndEnter", [source.id, version << 24, atoms["text/uri-list"], 0, 0])
    send("XdndPosition", [source.id, 0, (x << 16) | y, X.CurrentTime, atoms["XdndActionCopy"]])
    deadline = time.monotonic() + 10
    sent_drop = False
    requested = False
    last_position = time.monotonic()
    try:
        while time.monotonic() < deadline:
            if not sent_drop and time.monotonic() - last_position >= 0.3:
                send("XdndPosition", [source.id, 0, (x << 16) | y, X.CurrentTime, atoms["XdndActionCopy"]])
                last_position = time.monotonic()
            if not connection.pending_events():
                select.select([connection], [], [], 0.1)
            while connection.pending_events():
                event = connection.next_event()
                if event.type == X.SelectionRequest:
                    prop = event.property or event.target
                    if event.selection != atoms["XdndSelection"]:
                        prop = X.NONE
                    elif event.target == atoms["TARGETS"]:
                        event.requestor.change_property(prop, Xatom.ATOM, 32, [atoms["TARGETS"], atoms["text/uri-list"]])
                    elif event.target == atoms["text/uri-list"]:
                        event.requestor.change_property(prop, event.target, 8, payload)
                        requested = True
                    else:
                        prop = X.NONE
                    event.requestor.send_event(protocol.event.SelectionNotify(
                        time=event.time, requestor=event.requestor, selection=event.selection,
                        target=event.target, property=prop,
                    ), propagate=False)
                    connection.flush()
                elif event.type == X.ClientMessage:
                    values = event.data[1]
                    if event.client_type == atoms["XdndStatus"]:
                        accepted = bool(values[1] & 1) and values[4] == atoms["XdndActionCopy"]
                        if request.get("cancel") and accepted:
                            return {"cancelled": True, "accepted": accepted, "selection_requested": requested}
                        if not accepted:
                            continue
                        if not sent_drop:
                            send("XdndDrop", [source.id, 0, X.CurrentTime, 0, 0])
                            sent_drop = True
                    elif event.client_type == atoms["XdndFinished"]:
                        return {
                            "accepted": bool(values[1] & 1),
                            "copy": values[2] == atoms["XdndActionCopy"],
                            "selection_requested": requested,
                            "finished": True,
                        }
        raise TimeoutError("XDND target did not complete negotiation")
    finally:
        if not sent_drop:
            send("XdndLeave", [source.id, 0, 0, 0, 0])
        source.destroy()
        connection.flush()
        connection.close()


if __name__ == "__main__":
    print(json.dumps(drop(json.load(sys.stdin))))
