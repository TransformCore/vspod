# Isolated Desktop Display Spike

**Result: the app-only framebuffer approach works on the tested Intel Mac.**
Genuine Linux VS Code runs fullscreen in a disposable container, streamed into a
native AppKit window through a nonpersistent WKWebView. Resizing the host window
changes the remote framebuffer, not just its CSS scale.

This opt-in experiment does not change VSPod's CLI, Tauri app, maintained image,
existing containers, repository mounts or persistent volumes. It is not a
production backend or a Copilot acceptance test.

## Reproduce the display test

Requires macOS, Swift with AppKit/WebKit, Node.js 22, Docker, and network access to
Debian and Microsoft's official download service. Only x86_64 has been tested.
Run from the repository root:

```sh
scratch=$(mktemp -d)
curl --fail --location \
  https://raw.githubusercontent.com/moby/profiles/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json \
  -o "$scratch/default.json"
node experiments/desktop-spike/namespace-profile.mjs \
  "$scratch/default.json" "$scratch/desktop-seccomp.json"
node experiments/desktop-spike/display.mjs \
  --seccomp "$scratch/desktop-seccomp.json" \
  --snapshot "$scratch/desktop.png"
```

The generator verifies the baseline SHA-256:
`6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`.
It refuses to overwrite a profile; the viewer also requires a new snapshot path.
Snapshot capture is optional.

The runner builds `vspod-experiment:desktop-sandbox-probe`, compiles the small
native host viewer into private temporary storage, then opens and automatically
resizes the window. It closes the viewer and removes its uniquely named container
and host runtime directory after the bounded test. Ctrl+C also triggers cleanup.
The experimental dependency image/build cache and requested snapshot remain.
Remove the named files in `scratch` when no longer needed.

VS Code 1.106.3 is downloaded at runtime into disposable executable tmpfs.
Microsoft binaries are not baked into the image; applicable Microsoft terms still
govern use. This outdated pin matches the existing editor core for a reproducible
comparison, not a recommended production version or current Copilot certification.
A first attempt downloading the latest editor exceeded the 1 GiB scratch limit.

## Verified acceptance

The runner asserts:

- The native WKWebView establishes a real authenticated RFB connection.
- Host viewport, remote X framebuffer and VS Code client bounds match at
  **1100x750**, **900x600** and **1200x800**.
- The application starts at `(0,0)` and retains `_NET_WM_STATE_FULLSCREEN`.
  There is no remote window-manager border or desktop around the editor.
- A real editor workbench and synthetic text file render in the snapshot.
  The normal workspace trust prompt remains enabled.
- Editor logs contain no renderer launch failure.
- A zygote-descended renderer with a compositor thread has nested PID namespaces,
  zero effective capabilities, `NoNewPrivs: 1`, active seccomp, and multiple
  seccomp filters. This is diagnostic evidence, not a security certification.
- Anonymous requests for the page, noVNC module and socket are denied; the
  authenticated module loads, and cross-origin socket requests are denied.

The first successful resize-only test exposed a renderer-failure dialog. The
final profile adds the PID-only clone used when Chromium forks its renderer;
acceptance now checks renderer health as well as display dimensions.

## Transport and isolation

```text
macOS AppKit NSWindow (native outer frame)
  -> nonpersistent WKWebView + noVNC
  -> authenticated HTTP/WebSocket gateway on 127.0.0.1:<ephemeral port>
  -> loopback-only websockify and TigerVNC
  -> private X display + Openbox + fullscreen genuine VS Code
```

- UID 1000, all outer capabilities dropped, no-new-privileges, read-only root.
- Explicit experimental seccomp profile, 2 GiB memory, 512 PID/thread limit,
  2 CPUs, 128 MiB shared memory and private 1 GiB executable/nodev/nosuid tmpfs.
- No host paths, Docker socket, host display socket or persistent volumes.
  No real repository, account login or host credentials are supplied.
- Only the authenticated gateway is published, bound to IPv4 host loopback.
  VNC and its WebSocket proxy listen only on container loopback.
- A random 256-bit capability travels through process stdin, then a session
  HttpOnly cookie in an ephemeral WebKit store. It is not put in URLs,
  command-line arguments or environment variables. Access logs are disabled.
- The internal eight-character VNC password is ephemeral; it is not the external
  access-control boundary. VNC clipboard forwarding remains disabled. The optional
  clipboard test below uses a separate explicit-transfer diagnostic bridge.
- Downloads, editor settings and session credentials disappear with the container.
  Outbound networking remains enabled; this is not an egress-isolated runtime.

### Why the custom seccomp profile is necessary

With Docker's built-in default policy, `unshare -Ur true` fails. VS Code's default
launch aborts with exit 133 because the setuid helper is unusable in the
user-owned/nosuid install; a namespace-only diagnostic also reports
`No usable sandbox!`. A display protocol alone cannot fix that prerequisite.

The user explicitly approved testing narrow namespace permissions while retaining
Electron sandboxing, non-root and no-new-privileges. Relative to the **pinned
upstream Moby profile**, the generator adds:

- `unshare` for exactly `CLONE_NEWUSER` or `CLONE_NEWNET`.
- `clone`, masking all namespace flags, for USER, USER+PID+NET, PID+NET, or PID.
- `chroot`, used by Chromium after entering its inner user namespace.

It does not add `mount`, `setns`, `clone3` permissions or outer capabilities.
There is no `--privileged`, `seccomp=unconfined` or `--no-sandbox`.
The outer user has no `CAP_SYS_CHROOT`; seccomp cannot filter its pathname.
The profile is not proven syscall-minimal, and user namespaces expose additional
kernel attack surface. The upstream baseline is **not an export of Docker
29.9.2's exact built-in policy**; no equivalence claim is made. Clone argument
filtering assumes the normal Linux argument order, not architectures such as s390.

The simpler startup comparison remains available:

```sh
node experiments/desktop-spike/probe.mjs
node experiments/desktop-spike/probe.mjs --seccomp "$scratch/desktop-seccomp.json"
```

That probe only checks X-window creation. Use the display test for renderer and
fullscreen/resize evidence.

## Clipboard acceptance spike

Run the same sandboxed display test with:

```sh
node experiments/desktop-spike/display.mjs \
  --seccomp "$scratch/desktop-seccomp.json" --clipboard-test
```

**The normal macOS clipboard is never read, overwritten or backed up.**
`Pasteboard.swift` only accepts randomly named `org.vspod.clipboard-spike.*`
pasteboards and refuses the general pasteboard. Fixtures are synthetic. Each
named pasteboard is released and all transferred host/container files are removed
when the test ends.

The test compiles a native AppKit helper, uses explicit bounded JSON transfers
through `docker exec` stdin, and operates the genuine editor with `xdotool`. It
does not add a host mount or publish a clipboard service. A private Unix socket
inside the container controls a Python X selection owner. The owner provides
MIME negotiation and the X11 INCR protocol for larger payloads; the RFB clipboard
channel remains disabled. The container has no way to request host pasteboard
contents or select a host path through this harness.

### Results on Intel macOS / x86_64 Docker

| Workflow | Measured acceptance |
|---|---|
| Host text -> editor | Native text pasteboard -> X clipboard -> actual editor paste/save; Unicode, emoji, Japanese, tabs, blank lines and trailing newline match exactly |
| Editor text -> host | Actual editor copy replaces a sentinel; native pasteboard text matches exactly |
| No background mirroring | Changing the native test pasteboard without a transfer leaves the container clipboard unchanged |
| Large text | 5,000 multiline Unicode records cross the incremental X clipboard protocol without truncation |
| Terminal paste | A real VS Code terminal receives a multiline shell command; a marker is absent before explicit Return and present after confirmation/execution |
| Terminal output copy | Actual terminal Select All / Copy reaches the native pasteboard with multiline output and blank lines intact; displayed tabs become spaces |
| PNG images | Native PNG <-> X `image/png` round trip is byte-exact |
| Screenshot-style images | Native TIFF-only pasteboard converts to PNG with identical decoded RGBA pixels |
| Larger images | A noisy 512x512 PNG larger than 512 KiB crosses INCR without corruption |
| Editor image paste | Built-in Markdown paste creates a real image file and reference; decoded pixels match |
| Editor image copy | Built-in image-preview Copy Image replaces a text-only sentinel and reaches the native pasteboard with identical pixels |
| Files/folders into editor | Native file URLs -> byte transfer -> `code/file-list` and URI clipboard targets -> Explorer paste; multiple files, spaces in names, binary bytes, nested and empty directories are verified |
| Files/folders back to host | Actual Explorer selection/copy replaces a text sentinel with workspace file URLs; files are exported to private host storage, then published as native file URLs; all exported bytes and directory entries match |
| Invalid requests | Traversal, duplicate paths, missing parents, symlinks, out-of-root exports, oversized payloads and general-pasteboard access are rejected |

This is **clipboard feasibility and application acceptance**, not finished
interactive clipboard integration:

- The native helper uses real macOS pasteboard types, but a private pasteboard,
  not Finder or another application's normal clipboard. Actual Finder paste and
  file promises are not tested.
- Copy/paste actions are automated Linux shortcuts. Host Cmd+C/Cmd+V, editor
  context-menu gesture authorization and macOS Edit menus are not wired into the
  viewer. The explicit test coordinator supplies the transfers instead.
- All clipboard content is limited to 8 MiB per transfer, at most 100 file
  manifest entries, and eight MIME formats. Symlinks and special files are
  intentionally rejected. Permissions, executable bits, timestamps, ACLs and
  extended attributes are not preserved. File-name conflicts/overwrite UX and
  large-file streaming remain unimplemented.
- For this synthetic test only, workspace trust is disabled so terminal commands
  can run, built-in extensions are enabled for Markdown and image preview, and
  three diagnostic keybindings invoke existing editor commands. The extension
  directory is disposable and no third-party extensions or account credentials
  are supplied. The normal display-only probe keeps its original trust prompt
  and disabled extensions.
- The Python agent and host coordinator are disposable diagnostic helpers, not
  production-ready hostile-container brokers. File race hardening, full schema
  validation, X protocol corner cases and clipboard denial-of-service resistance
  need a production implementation and review.

The main finding is that basic VNC text clipboard forwarding is insufficient:
native file URLs require actual byte transfer and VS Code's `code/file-list`
format, while larger images need incremental X selection transfer. These can be
implemented independently of the final display transport.

## Drag-and-drop feasibility spike

```sh
node experiments/desktop-spike/display.mjs \
  --seccomp "$scratch/desktop-seccomp.json" --drop-test
```

This tests a copy-only **host file drop -> container XDND** path, independently
of the VNC clipboard and without a host filesystem mount:

1. The native viewer registers an AppKit file-URL drop receiver. Its shared
   acceptance routine is exercised with a private native pasteboard containing
   synthetic host files and a folder. Text-only input, move-only operations and
   out-of-bounds locations are rejected.
2. The receiver records the selected file URLs and a top-origin content location.
   The test asserts `(150,130)` on the matched 1200x800 host/framebuffer.
3. The coordinator transfers only those files through the clipboard spike's
   bounded manifest importer into private container scratch storage.
4. `xdnd.py` owns `XdndSelection`, offers `text/uri-list`, and negotiates actual
   `XdndEnter`, `XdndPosition`, `XdndStatus`, `XdndDrop` and `XdndFinished`
   messages with the genuine editor window. It offers only `XdndActionCopy`.
5. Real editor effects, not just protocol acknowledgements, determine acceptance.

Verified on Intel macOS / x86_64 Docker:

| Target/action | Result |
|---|---|
| Native receiver acceptance | File URLs and coordinates recorded; unsupported text, move-only and invalid locations rejected |
| Cancel after accepted drag-over | `XdndLeave` without `XdndDrop`; destination file remains absent |
| Explorer folder row | Actual XDND copy into `drop-target`; text file with spaces, binary bytes, nested folder and empty directory match |
| Editor surface | Dropping the same staged text file opens it as an editor instead of importing it into the Explorer destination |
| Copy semantics | Original host files and directory entries remain unchanged |
| Bad requests | Out-of-frame coordinates and unstaged file paths rejected |

Important findings:

- Chromium can request selection data *before* accepting the drag. The source
  must serve that data and continue position negotiation, rather than treating
  the initial negative status as a final rejection.
- The actual Linux pointer must match the advertised drop location.
- Dropping an external folder onto Explorer's empty/root area can open VS Code's
  **Copy Folder / Cancel / Add Folder to Workspace** dialog. Accepting its
  default added a workspace root during investigation. The passing copy test
  targets a specific existing folder instead. This is native editor behaviour,
  not something a pixel-only bridge should silently replace.
- `XdndFinished` can precede application-level confirmation or copying. A positive
  protocol result alone is insufficient; the test also checks destination bytes.

### What this does not prove

This is a controlled feasibility spike, **not an end-to-end Finder gesture**.
The native acceptance routine shared with `performDragOperation` is called by
the fixture harness; WindowServer drag event delivery, Finder, hover feedback,
file promises and native source drag sessions have not been automated or accepted.
For diagnostics the AppKit callback records a drop locally, and the coordinator
later performs the transfer/XDND operation. A live asynchronous drop bridge,
transfer progress, cancellation during transfer and failure notification to the
native source remain to be implemented.

There is **no VS Code -> Finder drag-out bridge** yet. Mapping Linux drag-source
events to `NSDraggingSession`/`NSFilePromiseProvider` is a separate experiment.
Image-file drops, Chat attachments, arbitrary text drags and move operations are
not accepted by this test. Only matched logical-pixel geometry is tested; Retina
scaling, letterboxing and a window resizing during drag need explicit mapping.
As with clipboard mode, this synthetic test enables built-in extensions and
disables workspace trust, supplies no real repository or credentials, and removes
the unique container, private host fixtures and transfer storage afterward.

## Licensing and remaining work

noVNC (MPL-2.0) and TigerVNC (GPL-2.0) are **diagnostic dependencies of this separate
experiment**, not a decision to embed GPL code in VSPod or to adopt this transport
for an MIT distribution. Openbox and other system packages have their own
licenses. No third-party implementation is copied into VSPod source. Distribution
and linking obligations need review before choosing or shipping a production
transport; an Apache/ISC alternative remains a separate decision.

Not verified or implemented:

- Official Copilot sign-in, subscription entitlement, inline completions or Chat.
  Extensions are disabled for the display-only test; clipboard mode enables the
  built-in Markdown and image functionality but does not authenticate Copilot.
- Retina pixel-perfect rendering, latency, CPU/bandwidth, sustained typing,
  international keyboard/IME input, Cmd-key mapping, or accessibility.
  Current framebuffer sizes are logical WebView pixels, not a HiDPI design.
- Native macOS application menus, Linux file-dialog translation, notifications,
  interactive clipboard integration or external-link handling. Linux menus remain pixels
  inside the stream; only the outer window frame is native.
- Integration with VSPod profiles, persistent repository containers, account
  broker, reconnect, crash recovery or the production Tauri client.
- A production threat assessment, hardened client/content policy, signed updates,
  current-editor testing, download checksum pinning, or Apple Silicon acceptance.

The spike demonstrates the proposed geometry and display model without replacing
the working code-server backend. The next editor acceptance test is official
Copilot in a current genuine VS Code release, with explicit ephemeral sign-in and
an appropriate reviewed transport/security configuration.
