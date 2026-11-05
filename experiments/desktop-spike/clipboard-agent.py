#!/usr/bin/python3
"""Disposable X selection owner. Accessible only through a private container socket."""
import base64
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import stat
from urllib.parse import unquote, urlsplit
import uuid
import time

from Xlib import X, Xatom, display, protocol

SOCKET = "/tmp/runtime/clipboard.sock"
LIMIT = 8 * 1024 * 1024
WIRE_LIMIT = 24 * 1024 * 1024
ROOT = Path("/tmp/clipboard-transfers")


def decode(value):
    data = base64.b64decode(value, validate=True)
    if len(data) > LIMIT:
        raise ValueError("Clipboard item exceeds limit")
    return data


def safe_entries(entries):
    if not isinstance(entries, list) or not entries or len(entries) > 100:
        raise ValueError("Invalid file manifest")
    seen = set()
    result = []
    total = 0
    for entry in entries:
        name = entry["path"]
        parts = name.split("/")
        if (not name or name.startswith("/") or "\\" in name
                or any(part in ("", ".", "..") for part in parts) or "\0" in name
                or name in seen):
            raise ValueError("Unsafe or duplicate file path")
        seen.add(name)
        if entry["kind"] not in ("file", "directory"):
            raise ValueError("Unsupported file kind")
        data = decode(entry["data"]) if entry["kind"] == "file" else b""
        total += len(data)
        if total > LIMIT:
            raise ValueError("File transfer exceeds limit")
        result.append((name, entry["kind"], data))
    kinds = {name: kind for name, kind, _ in result}
    for name in kinds:
        parts = name.split("/")
        for i in range(1, len(parts)):
            parent = "/".join(parts[:i])
            if parent not in kinds or kinds[parent] != "directory":
                raise ValueError("Missing or non-directory parent")
    return result


def clipboard_read(target):
    result = subprocess.run(
        ["xclip", "-selection", "clipboard", "-out", "-target", target],
        capture_output=True, timeout=5, check=True,
    )
    if len(result.stdout) > LIMIT:
        raise ValueError("Clipboard output exceeds limit")
    return result.stdout


def serve():
    os.umask(0o077)
    ROOT.mkdir(mode=0o700)
    connection = display.Display()
    window = connection.screen().root.create_window(0, 0, 1, 1, 0, X.CopyFromParent)
    selection = connection.intern_atom("CLIPBOARD")
    targets = connection.intern_atom("TARGETS")
    incr = connection.intern_atom("INCR")
    formats = {}
    transfers = {}
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(SOCKET)
    listener.listen(1)
    while True:
        ready, _, _ = select.select([listener, connection], [], [], 1)
        transfers = {key: value for key, value in transfers.items() if value[3] > time.monotonic()}
        # python-xlib can already have events buffered when the FD isn't readable.
        if connection in ready or connection.pending_events():
            while connection.pending_events():
                event = connection.next_event()
                if event.type == X.PropertyNotify and event.state == X.PropertyDelete:
                    key = (event.window.id, event.atom)
                    if key in transfers:
                        target, data, offset, expires = transfers[key]
                        chunk = data[offset:offset + 65536]
                        event.window.change_property(event.atom, target, 8, chunk)
                        if chunk:
                            transfers[key] = (target, data, offset + len(chunk), expires)
                        else:
                            del transfers[key]
                        connection.flush()
                    continue
                if event.type != X.SelectionRequest:
                    continue
                prop = event.property or event.target
                if event.target == targets:
                    event.requestor.change_property(prop, Xatom.ATOM, 32, [targets, *formats])
                elif event.target in formats:
                    data = formats[event.target]
                    if len(data) > 65536:
                        if len(transfers) >= 8:
                            prop = X.NONE
                        else:
                            event.requestor.change_attributes(event_mask=X.PropertyChangeMask)
                            transfers[(event.requestor.id, prop)] = (event.target, data, 0, time.monotonic() + 15)
                            event.requestor.change_property(prop, incr, 32, [len(data)])
                    else:
                        event.requestor.change_property(prop, event.target, 8, data)
                else:
                    prop = X.NONE
                event.requestor.send_event(protocol.event.SelectionNotify(
                    time=event.time, requestor=event.requestor, selection=event.selection,
                    target=event.target, property=prop,
                ), propagate=False)
                connection.flush()
        if listener not in ready:
            continue
        client, _ = listener.accept()
        with client:
            client.settimeout(10)
            try:
                body = bytearray()
                while True:
                    block = client.recv(65536)
                    if not block:
                        break
                    body.extend(block)
                    if len(body) > WIRE_LIMIT:
                        raise ValueError("Request exceeds limit")
                request = json.loads(body)
                operation = request["operation"]
                if operation == "write":
                    if not 1 <= len(request["formats"]) <= 8:
                        raise ValueError("Invalid format count")
                    supported = {"UTF8_STRING", "text/plain;charset=utf-8", "text/plain",
                                 "image/png", "text/uri-list", "x-special/gnome-copied-files",
                                 "code/file-list"}
                    if not set(request["formats"]).issubset(supported):
                        raise ValueError("Unsupported clipboard format")
                    values = {connection.intern_atom(key): decode(value)
                              for key, value in request["formats"].items()}
                    if sum(map(len, values.values())) > LIMIT:
                        raise ValueError("Combined clipboard payload exceeds limit")
                    formats = values
                    window.set_selection_owner(selection, X.CurrentTime)
                    connection.sync()
                    result = {"written": True}
                elif operation == "import":
                    entries = safe_entries(request["entries"])
                    destination = ROOT / uuid.uuid4().hex
                    destination.mkdir(mode=0o700)
                    for name, kind, data in sorted(entries):
                        path = destination / name
                        if kind == "directory":
                            path.mkdir(mode=0o700)
                        else:
                            path.write_bytes(data)
                    result = {"paths": [str(destination / name) for name, _, _ in entries if "/" not in name]}
                elif operation == "ping":
                    result = {"ready": True}
                else:
                    raise ValueError("Unsupported operation")
                client.sendall(json.dumps({"result": result}).encode())
            except (ValueError, KeyError, TypeError, OSError) as error:
                print("Clipboard request rejected: " + type(error).__name__, file=sys.stderr)
                client.sendall(json.dumps({"error": str(error)}).encode())


if __name__ == "__main__":
    if sys.argv[1:] == ["serve"]:
        serve()
    elif sys.argv[1:] == ["read"]:
        request = json.load(sys.stdin)
        value = clipboard_read(request["target"])
        print(json.dumps({"data": base64.b64encode(value).decode()}))
    elif sys.argv[1:] == ["export"]:
        request = json.load(sys.stdin)
        if request["target"] not in ("code/file-list", "text/uri-list"):
            raise ValueError("Invalid file target")
        uris = clipboard_read(request["target"]).decode("utf-8").splitlines()
        entries = []
        total = 0
        top_names = set()

        def append(path, relative):
            global total
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                raise ValueError("Symlinks are not transferred")
            if len(entries) >= 100:
                raise ValueError("Too many files")
            if stat.S_ISDIR(metadata.st_mode):
                entries.append({"path": relative, "kind": "directory"})
                for child in sorted(path.iterdir()):
                    append(child, relative + "/" + child.name)
            elif stat.S_ISREG(metadata.st_mode):
                total += metadata.st_size
                if total > LIMIT:
                    raise ValueError("File transfer exceeds limit")
                data = path.read_bytes()
                entries.append({"path": relative, "kind": "file",
                                "data": base64.b64encode(data).decode()})
            else:
                raise ValueError("Special files are not transferred")

        for uri in uris:
            parsed = urlsplit(uri)
            if parsed.scheme != "file" or parsed.netloc or parsed.query or parsed.fragment:
                raise ValueError("Only container-local file URLs are supported")
            path = Path(unquote(parsed.path))
            if path != path.resolve() or not any(root in path.parents for root in (ROOT, Path("/tmp/workspace"))):
                raise ValueError("File is outside permitted clipboard roots or follows a symlink")
            if path.name in top_names:
                raise ValueError("Duplicate top-level file name")
            top_names.add(path.name)
            append(path, path.name)
        safe_entries(entries)
        print(json.dumps({"entries": entries}))
    elif sys.argv[1:] == ["request"]:
        body = sys.stdin.buffer.read(WIRE_LIMIT + 1)
        if len(body) > WIRE_LIMIT:
            raise ValueError("Request exceeds limit")
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(15)
            client.connect(SOCKET)
            client.sendall(body)
            client.shutdown(socket.SHUT_WR)
            result = bytearray()
            while True:
                block = client.recv(65536)
                if not block:
                    break
                result.extend(block)
            sys.stdout.buffer.write(result)
    else:
        raise ValueError("Expected serve, read or request")
