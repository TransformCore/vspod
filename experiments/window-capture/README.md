# Independent guest-window capture spike

Separate from the IronRDP experiment and production VSPod. Genuine VS Code runs
in a disposable Linux container; each guest application window gets its own
AppKit/Metal window. **No desktop framebuffer is streamed and no RDP connection
is used.** The guest window manager's titlebars/borders are excluded from capture.

```text
VS Code -> Xvfb + Openbox -> XComposite named window pixmaps
                                    |
                  XDamage raw rectangles -> merged dirty rects
                                    |
                           Python agent / Docker exec
                                    |
               framed metadata + dirty-rect BGRA (DEFLATE if >= 16 KiB)
                                    |
                      AppKit windows + individual Metal textures
                                    |
                       targeted input/resize/close commands
                                    |
                           XTest + window-manager requests
```

## Run

Requires macOS, Swift/AppKit/Metal, Docker and Node.js. The first run builds an
image with Xvfb and Python-Xlib. VS Code 1.106.3 is downloaded into the private
container tmpfs at startup; third-party extensions are disabled.

Use the approved experimental namespace seccomp profile described in the
[desktop spike](../desktop-spike/README.md), never unconfined seccomp:

```sh
node experiments/window-capture/play.mjs \
  --seccomp /absolute/path/to/desktop-seccomp.json
```

Set `VSPOD_WINDOW_BACKEND=wayland` to use the smithay compositor from
[`../wayland-capture`](../wayland-capture/README.md) instead of Xvfb and
`agent.py`. The same host and acceptance suite are used, with Retina 2x guest
buffers (`VSPOD_WINDOW_SCALE=1` for 1x).

Select **File > New Window** inside VS Code, or press **Cmd+Shift+N**.
The resulting guest window appears as another native macOS window. Each native
window can move and resize independently. Cmd shortcuts map to Linux Ctrl.
Closing a native window requests a guest close, allowing the real unsaved-file
dialog to appear. Closing the final guest window ends the session; **Cmd+Q**
quits the whole spike immediately, discarding disposable work.

The guest desktop has a fixed 4096x2160 backing screen, but each native window
displays only its own client pixmap. Main-window sizes are bounded to
300x200 through 2400x1400. Host window movement does not move guest windows;
popup placement is calculated relative to the owning host window.

## What this proves

The actual acceptance run:

1. Types and saves a file through the first native input handler.
2. Clicks the actual **File** menu, captures its separate anonymous Electron
   popup into an owned native panel, and clicks **New Window** inside that panel.
   This is not a second CLI launch or a synthetic replacement menu.
3. Discovers the resulting second VS Code window and edits/saves a different
   file through its native handler.
4. Resizes the two guest clients independently to 820x600 and 960x700.
5. Places the larger guest window fully over the first. Checks both guest
   geometry and stacking order, then reads the first window's named pixmap.
   Changes the first file externally while it remains fully covered and requires
   a fresh repaint in the editor text region (879 changed pixels in the run).
6. Reads back the actual native Metal drawable and compares RGB pixels against
   that fully occluded guest pixmap: **0/492,000 pixels** outside 3/255 tolerance.
7. Reveals the first guest window and compares captures: 5,124/492,000 pixels
   changed (1.04%, including activation-sensitive UI). This is not a byte-exact
   occluded-versus-visible claim.
8. Closes the second native window with unsaved edits. Discovers the separate
   491x131 GTK dialog, attaches its native window to the correct parent, and
   cancels it through native input.
9. Saves and closes the second window. The first remains editable and saves
   another change. Finally closes the first and verifies clean host exit.
10. Shows guest cursors as the real macOS cursors (arrow, I-beam, pointing hand,
    resize, crosshair, not-allowed, grab and others), so they follow the user's
    pointer size and colour settings. Chromium sets unnamed X cursors, so the agent
    fingerprints every image in the guest's Adwaita theme and sends the matching
    names with each XFixes cursor change. Cursors with no AppKit equivalent, such as
    diagonal resize or busy, use the guest image. The guest renders them at
    `XCURSOR_SIZE=48` and the host draws them at half size for Retina; earlier builds
    drew guest images at 1 px per point, about three times too large.
11. Runs the integrated terminal in bash. The container account's login shell is
    `/bin/sh`, which is dash. Dash has no line editing, so arrow keys were echoed as
    `^[[A`. The acceptance run edits a terminal line with Left/End and recalls it
    with Up.

```sh
VSPOD_WINDOW_SELFTEST=1 \
VSPOD_WINDOW_EVIDENCE=/absolute/private/evidence-directory \
node experiments/window-capture/play.mjs \
  --seccomp /absolute/path/to/desktop-seccomp.json

docker run --rm -i --network none \
  --env PYTHONPATH=/opt/window-capture --entrypoint python3 \
  vspod-experiment:window-capture - < experiments/window-capture/agent_test.py

swiftc -warnings-as-errors -typecheck \
  packages/app-runner/host/macos/main.swift \
  packages/app-runner/host/macos/Configuration.swift \
  packages/app-runner/host/macos/Integrations.swift \
  packages/app-runner/host/macos/InputView.swift
```

Nine unit tests cover unknown-window rejection, resize limits, key validation,
pointer boundaries/coordinate mapping, held-key cleanup, unsupported actions and
dirty-rectangle merging/collapse.

Pointer coordinates are sent relative to the receiving native window, without
clamping. The agent maps them into guest root coordinates. AppKit gives the key main
window every mouse move, including moves over its popup menus and outside its frame.
Earlier builds clamped these to the window edge, so moving out of an open menu,
for example up into the macOS title bar, hovered VS Code's guest menu bar and switched
from File to Edit. Because popups are placed at the same owner-relative offset on the
host as in the guest, moves over a popup land on that popup. Moves outside are dropped
if they fall off the guest root and otherwise reach empty guest desktop. Button events
off the root are clamped so a release is never lost. The acceptance run includes a
regression check: it moves above and left of the window while the File menu is open.
An earlier build also rejected out-of-window coordinates and ended the session when
VS Code shrank a popup.
The runtime test uses native handlers and actual guest menus/dialogs; it does
not automate WindowServer gestures. It never reads or changes the host clipboard.
Evidence includes individual window/menu/dialog PNGs and raw pixmap/Metal data.

The acceptance run starts with a passive-startup check. With no input, it compares
the native Metal drawable against the guest window. Guest snapshots force a full
recapture, which would repair a stale texture, so the check uses `probe` captures
instead: the host records them but does not apply them. It probes before and after
the native readback and counts the comparison only if both probes match. This
avoids a race with VS Code painting mid-check. The same settled-match check runs
after the first edit/save and at the end of every benchmark run, after hundreds of
partial updates. The test helper presses Escape before each Enter so a VS Code
word-suggestion popup cannot swallow it.

An earlier build did not mark windows dirty on XDamage events: python-xlib does not
deliver them as `damage.DamageNotify` instances, so the agent now matches the
extension event code. Snapshot-driven checks had hidden this, and the interactive
window stayed on its first, grey loading frame.

## Responsiveness spike

`VSPOD_WINDOW_BENCH=1` runs [bench.mjs](bench.mjs) instead of acceptance. It
reports the time from a native key press until the next guest frame is
**presented** by Metal (`CAMetalDrawable.presentedTime`), not just received. The
scenarios are 30 typed characters, 20 Page Downs in a 5,000-line file, and
`seq 1 3000` in the integrated terminal. The guest uses a solid editor cursor,
so blink repaints are not counted as responses.

```sh
VSPOD_WINDOW_BENCH=1 VSPOD_WINDOW_BENCH_LABEL=run-name \
VSPOD_WINDOW_EVIDENCE=/absolute/private/evidence-directory \
node experiments/window-capture/play.mjs --seccomp /absolute/path/to/desktop-seccomp.json
```

Measured on one Apple-silicon Mac with Docker Desktop. These are single runs.
Medians typically vary by about ±10 ms, and p90 is sensitive to occasional host
stalls: two later runs of the final build gave typing p50 34 and 64 ms, with p90
156 and 463 ms. Page Down p50 was 41 and 62 ms.
Both runs passed the post-benchmark settled-match check (0 differing pixels):

| Change | Typing p50/p90 | Page Down p50/p90 | Terminal flood |
| --- | --- | --- | --- |
| Baseline: full window per change | 111 / 144 ms | 128 / 172 ms | 49 MB, 21 frames |
| XDamage dirty rectangles, event-driven loop | 38 / 48 ms | 51 / 78 ms | 4.7 MB |
| + raw DEFLATE level 1 for payloads >= 16 KiB | **24 / 48 ms** | **39 / 47 ms** | **0.3 MB** |
| Immediate Metal draw, no vsync (dropped) | 51 / 63 ms | 67 / 82 ms | no gain |
| 4 container CPUs (no gain) | 26 / 42 ms | 47 / 76 ms | 0.3 MB |
| SwiftShader GL instead of `--disable-gpu` (much worse) | 52 / 256 ms | 397 / 498 ms | 2.2 MB |

Per-frame breakdown with DEFLATE, from `WINDOW_LATENCY` log lines:

- A typed character makes VS Code repaint the whole editor text area,
  318x509 px or 647 KB raw. That compresses to about 12 KB.
- XComposite capture takes about 1 ms and DEFLATE 1-3 ms.
- Small frames complete the host -> guest -> host round trip in about 5 ms.
- Metal presents within about 2 ms of receipt.
- **The remaining cost is VS Code itself:** 12-25 ms from input to repaint when
  typing and about 30-45 ms for Page Down, using Chromium software rendering in
  the container.

Before compression, `docker exec` moved only about 35-40 MB/s, so transport was
half of the latency. Further transport work, such as LZ4 or a Rust/libxcb agent
with MIT-SHM, can save at most a few milliseconds now. Faster guest rendering is
the remaining lever.

`VSPOD_WINDOW_CPUS` (1-8, default 2) and `VSPOD_WINDOW_GPU` (`off` or
`swiftshader`) are experiment knobs for these comparisons.

## Implementation boundaries

- XComposite captures client backing pixmaps, not rectangles cropped out of the
  root desktop. XDamage raw rectangles are merged into at most 24 per window. If
  more than 60% of the window is dirty, one full capture is sent instead. Each
  pass sends one message per window. Resizes and snapshots always send a full
  frame. Discovery is event-driven, using root substructure, client structure and
  title/transient property events, with a 1 s fallback poll. Cursor images update
  on XFixes cursor events instead of being polled.
- XRes resource ownership identifies anonymous Electron popups that have no
  `WM_CLASS`. Transient hints identify GTK dialog parents. Anonymous popup
  ownership falls back to the currently focused guest window in this dedicated
  VS Code session; this is not a general desktop window-classification solution.
- Menus are borderless native child panels; dialogs are owned native child
  windows. Guest modality is preserved for the tested unsaved-file prompt.
  Complete application-wide modality, nested popup chains, file pickers,
  tooltips and menus crossing screen boundaries are not certified.
- The wire format is a four-byte big-endian JSON-header length, then a UTF-8
  header with a byte count and `rects` list. The payload is the concatenated,
  tightly packed little-endian BGRA rectangles, optionally raw DEFLATE. The host
  decodes into a buffer of exactly the declared size and rejects any other size. Input
  is newline-delimited JSON over a separate pipe. Limits: 24 surfaces, 16 KiB
  output headers, 4096x2160 capture size, 64 KiB input buffering, validated key,
  pointer and resize values. Unexpected errors fail explicitly.
- Metal uses one texture per window and uploads only dirty rectangles. It waits
  for GPU completion before the next CPU overwrite, and frame reads apply
  backpressure. There is no shared-memory transport. The latency figures above
  are measurements from one machine, not a native-latency guarantee.
- The current input path uses the shared US scancode handler and XTest.
  Scrolling is discrete; Retina scaling, IME, accessibility, reconnection,
  multi-monitor host placement and host minimization semantics need further work.
- Clipboard, file transfer and drag/drop from the IronRDP client are **not wired
  into this alternative backend**. Guest-internal copy/paste still works.
  Keeping those features in the working IronRDP experiment is intentional.
- Main guest windows remain mapped. Fresh repaints for external file changes
  while fully occluded are tested, not just preservation of old backing pixels.
  Guest unmapping/minimization is not certified.

## Isolation and licensing

The launcher uses a named disposable container: UID 1000, capabilities dropped,
no-new-privileges, read-only root, approved namespace seccomp, private bounded
tmpfs, 2 GiB/2 CPUs/512 PIDs and 128 MiB shm. There are no host mounts, credentials
or published ports. Electron sandboxing remains enabled. Docker access and the
private exec stream are the experimental transport boundary, not a production
authentication/security review.

**Python-Xlib is LGPL-2.1-or-later.** It is a convenient prototype binding, not a
permissively licensed production dependency choice. To retain the earlier
permissive-licensing goal, replace this agent binding with a suitably reviewed
libxcb/Xlib implementation before adoption. The Debian image also contains
GPL/LGPL components; this is not a GPL-free-image or distribution-licence claim.

Production VSPod and the existing [IronRDP playground](../ironrdp-native/README.md)
are unchanged. Closing the spike removes its container, executable and private
runtime; Docker build caches remain.
