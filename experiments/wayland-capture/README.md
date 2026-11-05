# Wayland per-window capture spike

A minimal [smithay](https://github.com/Smithay/smithay) (MIT) Wayland compositor that replaces the X11 stack
(Xvfb, openbox and `agent.py`) in [`../window-capture`](../window-capture/README.md). Genuine VS Code runs
with `--ozone-platform=wayland` inside the same hardened container. Each `xdg_toplevel` and `xdg_popup`
becomes its own native macOS window through the unchanged wire protocol and the same Swift/Metal host.

Under X11 the agent scrapes windows from a virtual screen. Here the compositor *is* the display server: it
receives each window's buffer, damage, role, parent and cursor shape directly from the client, so there is
nothing to fingerprint or reconcile.

The compositor and native host now live in [`packages/app-runner`](../../packages/app-runner/README.md).
This directory retains only the VS Code application fixture, probe and acceptance documentation.
The playground builds the generic runner image before building this fixture image.

## Run

```bash
cd ../window-capture
# Interactive playground (Retina 2x buffers by default)
VSPOD_WINDOW_BACKEND=wayland node play.mjs --seccomp <approved-profile.json>
# Acceptance suite, benchmark, or 1x buffers for an X11-equivalent comparison
VSPOD_WINDOW_BACKEND=wayland VSPOD_WINDOW_SELFTEST=1 node play.mjs --seccomp <profile>
VSPOD_WINDOW_BACKEND=wayland VSPOD_WINDOW_BENCH=1 node play.mjs --seccomp <profile>
VSPOD_WINDOW_BACKEND=wayland VSPOD_WINDOW_SCALE=1 node play.mjs --seccomp <profile>
# Clipboard, drag-and-drop, URL handoff and popup-edge integrations (VSPOD_WINDOW_EVIDENCE=<dir> keeps snapshots)
VSPOD_WINDOW_BACKEND=wayland VSPOD_WINDOW_INTEGRATIONS=1 node play.mjs --seccomp <profile>
# Menu-bar hover stress: random real-speed glides across the titles (VSPOD_STRESS_ROUNDS, default 60)
VSPOD_WINDOW_BACKEND=wayland VSPOD_WINDOW_STRESS=1 node play.mjs --seccomp <profile>
```

`play.mjs` builds `vspod-app-runner:dev` from the runner package (Rust builder + minimal guest runtime),
then `vspod-experiment:wayland` from this directory. The host runs
`docker exec -i <container> /opt/app-runner/vspod-compositor --bridge` instead of `agent.py`,
selected by a private, versioned host configuration. Container flags match the X11 spike: non-root, `--cap-drop ALL`,
`no-new-privileges`, the approved seccomp profile, a read-only root and resource limits.

`probe.sh` / `Dockerfile.probe` is the Phase 1 probe. It runs VS Code under headless weston and records which
Wayland protocols it uses.

## Design

| Concern | Compositor behaviour |
| --- | --- |
| Pixels | `wl_shm` ARGB/XRGB8888 is copied into a per-window CPU shadow, cropped to the xdg window geometry; the buffer is released and frame callbacks fire immediately |
| Transparency | ARGB8888 popups are flagged `alpha`. The host draws them premultiplied into a non-opaque layer and panel, so menu corners are rounded (and shadowed) like native menus. Everything else is drawn opaque |
| Damage | Surface damage is scaled to buffer pixels; >24 rects collapse to a bounding box; >60 % area or a size change sends a full frame; DEFLATE (fast) when ≥ 4 KiB |
| Retina | One output at scale 2 (`APP_RUNNER_SCALE`), so Chromium renders 2x buffers. Metadata stays logical; the host sizes its Metal drawable at `bounds × scale` |
| Roles | Toplevels map to main windows. A toplevel with a parent maps to a dialog centred on its parent. Popups map to borderless panels placed from the positioner |
| GTK dialogs | VS Code's native message boxes are GTK on a *second* Wayland connection. `xdg_foreign` v2 lets GTK parent them to Chromium's exported toplevel |
| Menus | Popup grabs take keyboard focus. A press outside the grab chain dismisses popups newest-first, like a desktop compositor |
| Input | Logical coordinates from the host. Wheel uses `axis` + `v120`. Client key repeat is disabled (rate 0) and macOS repeat is forwarded |
| Cursors | `wp_cursor_shape_v1` names (`text`, `pointer`, `ns-resize`, …) are sent as names only. The host maps them to real `NSCursor`s, so they follow the user's pointer size and colour |
| Decorations | `xdg-decoration` (Chromium) and KDE `org_kde_kwin_server_decoration` (GTK 3 dialogs) are always server-side; the native macOS title bar is the frame |
| Reconnect | The host socket accepts a new bridge at any time; the compositor replays `ready`, every mapped window (metadata + full frame) and the cursor |

The bridge uses explicit read/write loops. `std::io::copy` specialises socket↔pipe copies to `splice(2)`.
Splicing from an AF_UNIX stream into the `docker exec` stdout pipe stalled until more data arrived, so frames
were only delivered when stdin closed.

Wayland containers run with `--shm-size 512m` (X11 keeps 128m). Chromium's software compositor allocates its
`wl_shm` buffers in `/dev/shm`; at 2x a maximised 1792x995 window used 96 MB and 2400x1400 used 155 MB. With
128m the GPU process repeatedly exited (`exit_code=5`) and VS Code aborted with "GPU process isn't usable".
Acceptance now maximises a window and fails if the GPU process exits.

## Results

The unchanged acceptance suite (`../window-capture/test.mjs`, now backend-aware) passes end to end on Wayland:

- Startup and post-edit Metal drawables match settled guest buffers: **0 / 2,340,000** pixels outside
  tolerance at 2x.
- A first-window edit is saved; the real **File** menu opens as a native popup panel; moving the pointer
  outside the window keeps it open; **New Window** creates a second native window, which is edited and saved
  independently.
- Live repaint of a fully covered window: each client owns its buffer, so there is no XComposite equivalent
  to manage.
- The unsaved-changes prompt arrives as an owned dialog (via `xdg_foreign`); Escape cancels it, the second
  window then closes, and the first stays editable.
- Terminal Left/End/Up line editing works; `text`/`default`/`ns-resize` cursor shapes map to native
  `iBeam`/`arrow`/`resizeUpDown`.
- Closing the last window ends the host cleanly.

The X11 path re-passes its acceptance suite with the host changes, and the 11 `agent.py` unit tests pass.

Benchmark (`bench.mjs`, same machine and session, `--cpus 2`, software rendering):

| Backend | Typing receive p50 / p90 | Typing present p50 / p90 | Typing bytes p50 | Page-down present p50 / p90 | `seq 1 3000` flood |
| --- | --- | --- | --- | --- | --- |
| X11 (1x) | 18 / 24 ms | 45 / 67 ms | 11.7 KB | 63 / 66 ms | 1.59 s, 0.3 MB |
| Wayland 1x | 15 / 20 ms | 44 / 49 ms | 13.4 KB | 65 / 230 ms | 1.58 s, 0.3 MB |
| Wayland 2x (Retina) | 23 / 42 ms | 65 / 83 ms | 43.7 KB | 82 / 98 ms | 1.57 s, 0.8 MB |

At equal resolution Wayland matches X11. Retina 2x quadruples pixels for sharp text at a cost of about
20 ms per keystroke. In every row, roughly 25–40 ms lies between receive and present on the host. That
host-side gap is the next optimisation target (e.g. presenting directly from the receive path rather than
waiting for the next display-link draw).

### Terminal renderer

The containers have no GPU, so xterm.js's default WebGL renderer falls back to Chromium's software WebGL
("GPU stall due to ReadPixels"). Both backends therefore set `terminal.integrated.gpuAcceleration` to `off`
(the DOM renderer), overridable with `VSPOD_TERMINAL_GPU=auto|on|off`. Wayland 2x keystroke-to-present
(p50 / p90, bytes p50):

| Terminal | WebGL (`auto`) | DOM (`off`) |
| --- | --- | --- |
| Panel | 64 / 98 ms, 28.8 KB | 46 / 63 ms, 12.9 KB |
| Moved into its own window | 161 / 229 ms, 127.5 KB | 47 / 49 ms, 11.6 KB |

The benchmark now covers both cases (`terminal-typing`, `window-terminal-typing`).

### Menu hover

smithay sends only `wl_pointer.enter` when pointer focus changes surface. Chromium updates menu hover on
motion, so the first move into a menu (or back out of one) highlighted nothing until the pointer moved
again. After a focus change, the compositor now sends a frame and then a motion at the same location.
The guest's `APP_RUNNER_POINTER_TRACE=1` (playground: `VSPOD_POINTER_TRACE=1`) logs each pointer event's hit-test,
focus and popup grabs to `/tmp/compositor.log`.

Electron also ignores the first hover over a menu-bar title after a menu switch: it reopens the sibling
menu as if from the keyboard (`hold_first_switch_`). A real mouse moves past this. The acceptance run moves
twice over each title, then asserts that every hover highlights a row (including the first) and every
title switch opens a new menu.

On the host, AppKit delivered most real mouse moves over a borderless, non-activating popup panel nowhere,
so hover stalled after the first row or two. The host now takes every `mouseMoved` with a local event
monitor and routes it, in screen coordinates, to the popup's owning window, which maps it into guest
coordinates. The hover check posts genuine events onto the popup panel through the app event queue
(`testPostMove`). Without the monitor it fails with no highlighted rows.

Sporadic misses on the menu bar itself had two causes, found with `menubar-stress.mjs`
(`VSPOD_WINDOW_STRESS=1`). It glides the pointer to random titles at real mouse speeds (a move every 8 ms, 2–16
pt steps) and checks the menu the bar settles on. Before the fix, 6 of 60 glides ended on the wrong menu.

1. **Host input starvation.** Mouse moves and rendering shared the AppKit main thread. Each guest repaint
   inflated, uploaded and drew there, and `draw` waited for the GPU and a vsync-bound drawable (about 20 ms
   for the 1800x1300 main window). Each new popup panel also compiled its own Metal shader (up to 0.8 s).
   Moves reached the compositor more than 1.5 s late, so the pointer was at rest before Electron saw it
   cross the last title. Now decoding happens on the stream reader thread. Each window uploads and draws on
   its own serial queue into a plain `CAMetalLayer`, with draws coalesced. The shader pipeline is shared.
   `VSPOD_HOST_TRACE=1` logs any host work over 4 ms as `HOST_SLOW`.
2. **Electron's asynchronous menu switch.** Electron switches menu-bar menus asynchronously and ignores a
   move at the position a menu opened at. If the pointer comes to rest on another title while a switch is
   in flight, the wrong menu stays open until the pointer moves again; a real mouse's jitter usually hides
   this. When a popup maps under a resting pointer (no move for 50 ms) over a toplevel, the compositor
   moves it 1 px and back 60 ms later. Replaying the same position does nothing, so the move must differ.
   The generic runner disables this workaround unless the application opts in with `electronMenuNudge`.

After both fixes, 0 of 150 glides miss (`POINTER nudge=` appears in the pointer trace when the nudge fires).

## Why this is promising for VSPod

- **No X11 surface in the container:** no Xvfb, window manager, XComposite, XFixes cursor fingerprinting or
  `python3-xlib` agent. A single 3.3 MB binary (linked only to libc and libxkbcommon) replaces them.
- **Semantics come from the protocol:** roles, parents, popups, grabs, cursor names and per-window damage are
  explicit rather than inferred.
- **Retina is native:** 2x buffers come from the client instead of upscaling a 1x framebuffer.
- **Generic:** any Wayland-native app (GTK4, Qt6, Electron, Chromium) gets the same treatment, and the X11
  path remains as a fallback for X-only apps.

## Host integrations

`VSPOD_WINDOW_BACKEND=wayland VSPOD_WINDOW_INTEGRATIONS=1 node play.mjs --seccomp <profile>` runs
[`integrations.mjs`](../window-capture/integrations.mjs) against real VS Code. All 12 checks pass. Test pasteboard
traffic uses a private named pasteboard, so the suite never touches your clipboard.

| Integration | How it works | Verified |
|-------------|--------------|----------|
| Host → guest clipboard | On Cmd+V the host sends the macOS pasteboard to the compositor first. Text is offered under the UTF-8 text MIME types, images as `image/png`, and files as `text/uri-list`, `code/file-list` and `x-special/gnome-copied-files`. Files are staged under `/tmp/vspod-transfer`. The compositor becomes the `wl_data_device` selection, and the key is forwarded after that. | Unicode multi-line text byte-for-byte; ~1 MiB text; a host folder pasted into the Explorer; a PNG pasted into Markdown (VS Code writes `image.png` + link) |
| Guest → host clipboard | `new_selection` reads the client's selection on the next idle (smithay stores it only after the callback). It prefers files, then PNG, then text. A worker thread reads the pipe with a 30 s / 8 MiB limit. File URIs must canonicalise (no symlinks) under the workspace or staging roots. The host writes files to a private `transfers/N` folder and puts file URLs on the pasteboard. | Editor copy; ~1 MiB copy; Explorer file copy |
| Finder → VS Code drop | The host is an `NSDraggingDestination` on main windows. It stages the files, then the compositor runs a server-side `start_dnd` at the drop point (Copy, `text/uri-list`), moves the pointer and releases the button. | Drop on the editor opens the file; drop on the Explorer copies it into the workspace |
| Browser handoff | `/usr/local/bin/xdg-open` → `vspod-compositor --open URL` → a Unix socket → host `NSWorkspace.open`, when the attachment permits external URLs. Electron `openExternal` uses it. | A guest `xdg-open`; VS Code "Help: Documentation" opened in the host browser path |
| Edge-aware popups | The host reports each main window's visible-screen bounds (window-relative) on create, move, resize and screen change. The compositor feeds them to `PositionerState::get_unconstrained_geometry`, so Chromium's flip and slide adjustments work. | A context menu opens downwards mid-screen and flips above the pointer at the Dock edge |

### Security policy

- **Clipboard export needs user activation.** Guest selections are mirrored to macOS only within 1 s of real host
  input (`WINDOW_CLIPBOARD_IGNORED` otherwise), so background guest processes cannot overwrite the Mac clipboard.
- **Clipboard import happens only on a paste gesture.** The host sends the pasteboard only on Cmd+V into a guest
  window, so the guest never sees clipboard contents you did not paste.
- **Bounded transfers.** Every transfer is limited to 8 MiB and 100 entries. Text must be UTF-8 and images must be valid
  PNG. File names reject `..`, separators and control characters. Symlinks and special files are skipped. Host
  writes use `.withoutOverwriting`, and the private transfer folders are mode 0700.
- **URL opening.** Only `http`/`https` URLs of up to 2048 characters, with no whitespace or control characters, are
  accepted, and only within 10 s of a user gesture. Each gesture allows one open. The host additionally rejects
  credentials in URLs and loopback hosts: container ports are not forwarded, so `localhost` would reach the Mac,
  not the guest.

### Known limitations

- Paste via the guest's Edit menu or context menu uses the guest selection. Only Cmd+V pulls the macOS
  clipboard first.
- Files copied out of the guest are private copies in the session's temporary root, which is deleted on exit.
  Production needs a persistent per-repository transfer folder.
- OAuth sign-in redirects to `vscode://` or loopback do not return to the container. This belongs to the identity
  broker (device code or brokered tokens), not URL forwarding.
- Guest → Finder drags (dragging out of VS Code) are not bridged.
- GTK 3 ignores `xdg-decoration`, so dialogs rely on the KDE decoration protocol. GTK dialogs that use a
  `GtkHeaderBar` (for example, file choosers when `gtk-dialogs-use-header` is set) would still draw their own
  header under the macOS title bar.
- Surface (bitmap) cursors fall back to the arrow; VS Code only uses shape names.
- Software rendering only (`--disable-gpu`); dmabuf/GPU would need a virtual GPU path.
- One fixed output; there is no multi-monitor or per-monitor scale. Popup constraints use the main window's
  current screen.

## Licensing

`vspod-compositor` is MIT. All 93 crates in the resolved graph (including `base64`, MIT OR Apache-2.0) are permissive (MIT, Apache-2.0, BSD, Zlib,
Unicode-3.0, Unlicense); the two LGPL-2.1 mentions are alternatives in `MIT OR Apache-2.0 OR LGPL-2.1`.
Runtime additions are `libxkbcommon0` and `xkb-data` (MIT-style).
