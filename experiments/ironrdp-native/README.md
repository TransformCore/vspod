# IronRDP with direct native Metal rendering

An isolated, interactive macOS experiment. **The production Tauri/code-server
runtime is unchanged.** Genuine VS Code runs fullscreen in the same disposable,
non-root xrdp container as the [previous experiment](../rdp-spike/README.md).
The client is now IronRDP 0.17.0, linked into an AppKit/Metal executable.

## Live path

```text
AppKit keyboard/mouse -> bounded Rust input channel -> IronRDP -> TLS -> xrdp
                                                                       |
MTKView <- Metal private texture <- reusable upload buffers <- IronRDP framebuffer
```

- One native process, with a Rust network/decode worker and AppKit main thread.
- No browser, frame files, PNG decoding, `NSImage` conversion or polling in the
  live rendering path. PNG readback exists only for explicit acceptance testing.
- Latest-frame mailbox: dirty regions are unioned, not queued as old frames.
  Only dirty rows are copied into persistent CPU storage and Metal upload buffers.
- Coalesced UI notifications, three reusable staging slots, at most three
  uploaded frames in flight. GPU resources are retained until completion.
- Persistent private RGBA texture, dirty-region blits, event-driven native
  rendering. Mouse cursor movement remains local, without a network round trip.
- Server cursor shapes (including cached shapes, I-beams and splitters) are
  decoded by IronRDP and applied as AppKit `NSCursor` bitmaps with their original
  hotspots. Default/hidden cursors are supported; remote position hints never
  warp the host mouse. Cursor updates use a latest-state mailbox on the UI thread.
- Shared [native input handlers](../../packages/app-runner/host/macos/InputView.swift), direct in-process
  FFI calls, US scancodes, Cmd-to-Ctrl shortcuts, mouse buttons/dragging/scrolling,
  focus-loss key release and debounced live resize.
- TCP_NODELAY on both client/tunnel sockets. The Docker-exec tunnel remains;
  this does not remove Docker Desktop VM or container application overhead.
- Lossless classic bitmap updates: RemoteFX/video codecs and bulk compression
  are not requested. This is not a GPU RDP decoder or a zero-copy implementation.

### Server pacing matters too

xorgxrdp 0.10.2 hardcodes a **40 ms minimum capture interval (25 FPS ceiling)**.
The isolated [Dockerfile](./Dockerfile) rebuilds the matching driver modules,
changing that constant to **8 ms**. Its 4 ms change-batching delay remains.
This removes a server-side cap; it does **not** prove sustained 125 FPS.
The original FreeRDP server image is not modified.

The source archives and hashes are pinned in the Dockerfile. Build dependencies
stay in a separate build stage; runtime isolation is unchanged.

### High-resolution scrolling

The Xorg backend supports XInput smooth-scroll valuators, but the pinned
xorgxrdp mouse driver uses integer division and forces every sub-unit delta to
at least one valuator unit. This distorts small trackpad events. It also declares
a 100-RDP-unit wheel increment, rather than the standard 120 units.

The native experiment's driver uses floating-point deltas and a 120-unit
increment. The AppKit input bridge preserves fractional wheel units, splits
large movements without truncation, and keeps vertical/horizontal remainders
separate. Gesture cancellation, momentum completion and focus loss reset the
remainders. The isolated native image enables
`terminal.integrated.smoothScrolling`; the old FreeRDP image's settings remain
unchanged. These are wheel/scrollback fixes, not a guarantee of smooth output
from commands that emit large bursts.

## Run a playable window

Requires macOS, Swift/AppKit/Metal, Rust/Cargo, Docker and Node.js. Tested on Intel
macOS with an x86_64 Docker engine. First build downloads dependencies, compiles
the native client and builds the isolated driver image.

Use the explicitly approved experimental seccomp profile from the
[desktop spike](../desktop-spike/README.md), **not** unconfined seccomp:

```sh
scratch=$(mktemp -d)
curl --fail --location \
  https://raw.githubusercontent.com/moby/profiles/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json \
  -o "$scratch/default.json"
node experiments/desktop-spike/namespace-profile.mjs \
  "$scratch/default.json" "$scratch/desktop-seccomp.json"

node experiments/ironrdp-native/play.mjs \
  --seccomp "$scratch/desktop-seccomp.json"
```

Close the window or press **Cmd+Q** to remove the container and temporary runtime.
Ctrl+C/SIGTERM also cleans up. Reusable Docker/Cargo build caches and the native
executable under ignored `target/` remain. No host files, accounts or credentials
are mounted. **All remote edits are disposable.**

## Clipboard and file drops

- **Cmd+C / Cmd+V** explicitly copy guest content to the host clipboard or paste
  host content into VS Code. Native Edit menu actions provide the same controls.
- **Cmd+Shift+C / Cmd+Shift+V** use the terminal's copy/paste shortcuts.
  Physical Ctrl+C remains a guest terminal interrupt.
- Unicode text (including multiline and large selections), PNG images,
  host TIFF-to-PNG conversion, and files/folders are supported. Images require a
  suitable guest target, such as a Markdown editor or the image preview.
- Drag host file URLs onto an **Explorer folder** to copy them into that folder.
  Dropping onto the editor opens staged files instead. Host source files are
  never moved. VS Code's paste confirmation dialogs remain enabled.
- Transfers are explicit: **no background clipboard mirroring**. Guest context
  menu copy alone does not update macOS; use the native copy action. Cmd+X is
  ordinary guest input, not a cross-boundary cut.
- The window displays "Transferring..." while busy and shows transfer failures
  as alert sheets. Unsupported guest copies leave the host clipboard unchanged.
  A host clipboard change during an asynchronous copy cancels its write-back.

The bridge reuses the bounded [X clipboard agent](../desktop-spike/clipboard-agent.py)
and [XDND source](../desktop-spike/xdnd.py) over Docker-exec stdin/stdout.
It is a local sideband, **not IronRDP CLIPRDR**. No host directory is mounted.
Only explicitly selected host paths are staged in the disposable container.
Guest file exports are limited to the workspace and transfer staging roots.

Limits are 8 MiB per transfer, 100 manifest entries (including directories),
24 MiB encoded IPC, and 30 seconds per native helper invocation. Images are also
limited to 8192 pixels per side and 16 megapixels. Symlinks, special files,
duplicate names and unsafe paths are rejected. Exported host clipboard file URLs
refer to private temporary copies: paste them elsewhere **before closing the
playground**, which removes them along with guest staging.

Inbound drops are copy-only file-URL drops, not file promises. There is no
guest-to-Finder dragging; use file copy/paste for that direction. Native drop
acceptance precedes asynchronous guest completion; subsequent errors are shown.
XDND hover/negotiation occurs after the host drop, without live guest hover
previews.

## Acceptance

```sh
cargo test --locked --manifest-path experiments/ironrdp-native/Cargo.toml
cargo test --locked --manifest-path experiments/ironrdp-native/Cargo.toml -p ironrdp-session
cargo clippy --locked --manifest-path experiments/ironrdp-native/Cargo.toml -- -D warnings
node --test experiments/ironrdp-native/transfers.test.mjs

VSPOD_IRON_TRANSFER_SELFTEST=1 \
node experiments/ironrdp-native/play.mjs \
  --seccomp "$scratch/desktop-seccomp.json"

VSPOD_IRON_SELFTEST=1 VSPOD_IRON_SAVE_SNAPSHOT="$scratch/iron.png" \
node experiments/ironrdp-native/play.mjs \
  --seccomp "$scratch/desktop-seccomp.json"
```

The selftest invokes the actual native input handlers, clicks the editor,
selects all, types two lines and saves using Cmd+S. It asserts the **saved file
contents**, checks focus-loss key release, and checks X desktop, fullscreen
editor bounds and native texture at **1100x750, 1000x680 and 1200x800**.
It also moves over the editor, Explorer and sidebar splitter, requiring three
distinct AppKit cursor images. It opens the terminal, runs `seq 1 400`, sends 90
paced high-resolution scroll inputs and requires at least eight presented
updates and eight changes in a terminal-text-only pixel region over two seconds.
This rejects a test satisfied only by caret animation or an unchanged frame.
It reads back the Metal drawable after rendering and compares it with a direct
X screenshot. The gate permits at most 0.5% of pixels to differ by more than
3/255 per RGB channel. The cursor/scroll acceptance run had **38/960,000**
differing pixels (0.004%, blinking caret); the initial rendering run had zero.

The scroll check recorded 39 presented updates and nine terminal-text-region
changes during its two-second observation. This proves progressive remote
content updates, **not smooth 60 FPS scrolling** or a measured improvement over
the previous client. Command-output bursts and interactive feel remain separate
evaluation points. During selftests, real keyboard/mouse events are ignored
so host activity cannot redirect the scripted remote input.

The combined clipboard/drop build's final regression passed the same scroll
threshold with 46 updates and ten terminal-content changes, and zero pixels
outside the render-comparison tolerance. Earlier runs produced only 5-7 content
changes and failed that gate: performance is variable, not a sustained-frame-rate
guarantee. The threshold is unchanged. The fixture now warms up VS Code before
cursor checks, checks geometry only until each requested size matches, and
reports a scroll failure after the remaining rendering checks have run.

Seven Rust tests cover dirty-region coalescing, framebuffer replacement,
dimensions, TLS pin mismatch, keyboard flags, signed wheel input, padded bitmap
cropping, cursor bounds/hotspots/byte lengths and short resize-deactivation
packets. The launcher also runs the Swift wheel-accumulator regression tests.
The existing FreeRDP interactive
selftest also passes after extracting the shared input handlers.
These are controlled native-handler tests, not automated WindowServer gestures.

The separate transfer acceptance uses an isolated named native pasteboard,
never the normal macOS clipboard. It exercises the real native copy/paste and
drop handlers against VS Code: byte-exact Unicode and 5,000-record text
roundtrips, TIFF Markdown paste, actual image-preview PNG copy with pixel
comparison, Explorer file export, binary/empty-directory import, and real XDND
Explorer-folder/editor drops. It confirms the legitimate multi-file paste
dialog rather than disabling it. Multiline terminal paste is checked not to
execute until explicit Return, then actual selected terminal output is copied
back with blank lines preserved (displayed tabs may become spaces). Unsupported
paste content is rejected without changing its host pasteboard. Four Node tests
cover chunk-boundary UTF-8, manifests, traversal and payload limits.
Actual Finder/WindowServer drag dispatch and file promises are not certified by
these controlled tests; they still need interactive evaluation.

### Timing: useful diagnostics, not input-to-photon

The last bounded run reported:

| Metric | Samples | Median | p95 |
|---|---:|---:|---:|
| Latest mailbox update to native frame acquisition | 369 | 1.88 ms | 15.62 ms |
| Metal submission to completion callback on main queue | 369 | 2.92 ms | 16.42 ms |
| Eligible key input to next acquired update, proxy only | 15 | 57.78 ms | 252.73 ms |

Mailbox age starts **after decoding**, at the latest published update, not at
server capture. GPU completion includes callback/main-queue scheduling and is
**not display scanout**. The input proxy is uncorrelated: a caret/animation can
satisfy it, multiple inputs can coalesce, and not every key gets a sample.
The long tail is real in this diagnostic, but cannot be attributed to typing
latency from this metric. No input-to-photon, sustained FPS, scrolling benchmark
or controlled FreeRDP-vs-IronRDP decoder comparison is claimed.

The old file-based display path and 25 FPS server cap are removed. Whether the
whole system now feels native still needs interactive evaluation, especially
fast typing, trackpad scrolling and selection under load.

## Isolated compatibility patches

The registry `ironrdp-session` 0.11.0 source is vendored with its original
MIT/Apache licence files. Only these upstream areas are changed:

1. `src/fast_path.rs`: crop padded source bitmap dimensions to the destination
   rectangle before applying pixels. Unpatched xrdp narrow updates caused an
   out-of-bounds panic. Tests cover a bottom/right framebuffer-edge update,
   bottom-up layout, DWORD row padding, height cropping and invalid lengths.
2. `src/x224/mod.rs`: recognize xrdp's exact six-byte header-only Deactivate All
   form. The normal PDU decoder requires a share ID and otherwise rejects live
   resize. Other short/malformed PDUs still go through normal validation.
3. `Cargo.toml`: enable the crate's unit-test target.

The bridge updates the session share ID after reactivation. Other dependencies
and production workspaces are unpatched. These fixes need upstreaming/replacement
before adopting the dependency in production; this is not hostile-server
hardening or a complete protocol interoperability certification.

## Boundaries and remaining work

- UID 1000, capabilities dropped, no-new-privileges, read-only root, approved
  namespace seccomp, private tmpfs, no host mounts or published Docker ports.
  Electron sandboxing remains enabled. The seccomp spike is not a security audit.
- Server TLS certificate SHA-256 pin checked before session credentials are
  sent. **Direct xrdp mode has no client authentication.** Dummy autologon data
  only selects the backend. Docker access and a one-connection loopback listener
  are an experimental boundary with a residual local first-connection race.
- No automatic host clipboard synchronization, outbound native dragging, IME,
  international/dead-key composition, full native menu translation, reconnect or accessibility.
  Rendering is one remote pixel per content point; Retina pixel-density scaling
  is not implemented. Third-party extensions are disabled for the synthetic
  workspace; official Copilot remains untested.
- IronRDP is MIT OR Apache-2.0; xrdp is Apache-2.0; xorgxrdp is permissive
  X11-style. Declared Rust dependency metadata offers permissive choices
  (including MIT/Apache for `r-efi`'s alternative LGPL licence). This is not a
  source-level legal audit. The Debian image contains GPL/LGPL software; it is
  **not** a GPL-free image, nor does this establish a distribution licence for
  Microsoft VS Code or the VSPod project.
