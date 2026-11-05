# Permissive RDP transport spike

**Result: xrdp + xorgxrdp + a native FreeRDP client works on the tested Intel Mac.**
Genuine Linux VS Code runs fullscreen in a disposable non-root container. Its
RDP-decoded framebuffer displays inside an AppKit window, without noVNC, TigerVNC
or a browser-based display client. The existing VSPod runtime is unchanged.

This is a feasibility experiment, not a production remote-desktop backend, a
licence opinion, a latency benchmark, or an official Copilot acceptance test.

For the connected **IronRDP + direct native Metal** follow-up, see
[ironrdp-native](../ironrdp-native/README.md). It replaces the file-based rendering
path and removes the server's 25 FPS capture cap in a separate image.

## Interactive playground

After building the native FreeRDP prefix and experimental seccomp profile below:

```sh
node experiments/rdp-spike/play.mjs \
  --seccomp "$scratch/desktop-seccomp.json" \
  --freerdp-prefix "$scratch/freerdp/install"
```

The window remains open until you close it or press **Cmd+Q**. You can click,
type, select/drag, scroll, use right-click menus and resize the native window.
Mouse and keyboard events travel through RDP, not synthetic X input. Cmd
shortcuts map to Linux Ctrl (for example Cmd+S saves). Cmd+C/Cmd+V operate on the
**remote clipboard only**; they do not synchronize with macOS. No host clipboard,
repository, credentials or persistent volumes are supplied. Everything saved
inside this playground is **discarded when the window closes**.

The keyboard uses a US physical-scancode mapping. International layouts, IME,
dead keys and macOS Option-character composition are not implemented. xrdp does
not advertise Unicode keyboard events on this connection, so those cannot be
used as a drop-in text-input solution. Clipboard Unicode support is independent.

Native resize is debounced and updates the actual remote framebuffer. While it
settles, input coordinates map to the currently decoded dimensions. Input waits
for RDP activation during resize renegotiation. Focus loss releases modifiers
and mouse buttons. The interactive viewer samples changed frame files at up to
60 Hz; it is still a diagnostic file-copy path, not the proposed direct-texture
renderer or a latency-optimized product implementation.

For bounded automation, set `VSPOD_RDP_SELFTEST=1` on the same command. It invokes
the native click/key handlers, replaces and saves the open file using Cmd+A,
typing/Return and Cmd+S, changes the native window to 1000x680, and closes it.
The launcher asserts actual saved contents, X framebuffer dimensions and decoded
frame dimensions, then removes the container. This tests the shared handlers,
not real WindowServer event dispatch or all input combinations.

## What actually passed

| Test | Result |
|---|---|
| Native FreeRDP connection | TLS with the container certificate's SHA-256 fingerprint pinned |
| Fullscreen editor geometry | X framebuffer **and actual editor bounds** match 1100x750, 900x600 and 1200x800 at (0,0) |
| Decoded framebuffer | FreeRDP resize callbacks and final 1200x800 RGB frame checked |
| Native embedding | RDP frames displayed by an AppKit `NSImageView` in our own `NSWindow` |
| Rendering fidelity | Native snapshot compared with a direct X screenshot; at most 0.5% of pixels may differ by more than 3/255 per RGB channel |
| Text clipboard | 5,000 records, accented text, Japanese, emoji, Greek, tabs and blank lines cross actual RDP CLIPRDR |
| Actual application paste | VS Code pastes and saves the text; saved bytes match after explicit CRLF/LF normalization |
| Actual application copy | VS Code Select All/Copy crosses CLIPRDR back to the native client with matching text |
| Bitmap clipboard | A 17x13 24-bit CF_DIB becomes byte-exact X11 `image/bmp`; a different BMP returns byte-exact through CLIPRDR |
| IronRDP alternative | Pinned Rust API probe compiles graphics/session/clipboard/display-control support and encodes all three resize layouts; invalid dimensions rejected |

Both bitmap and text runs achieved **0/960,000 pixels** outside the rendering
tolerance on the recorded final snapshots. Small cursor/animation differences
are allowed by the gate; it is not a claim that arbitrary workloads are lossless.

The macOS **general clipboard is never read or written**. Native fixture buffers
stand in for a future AppKit pasteboard adapter. This is stronger evidence about
the RDP channel than the previous experiment's out-of-band clipboard bridge, but
does not prove native Cmd+C/Cmd+V integration.

## Reproduce

Requires macOS with Swift/AppKit and a C compiler, Docker, Node.js 22, CMake and
OpenSSL 3 development files. Rust is only needed for the separate IronRDP probe.
Network access is required for Debian packages and Microsoft's official download
service. Only Intel macOS with an x86_64 Docker engine has been tested.

Create the same explicitly approved experimental namespace profile as the
[previous desktop experiment](../desktop-spike/README.md):

```sh
scratch=$(mktemp -d)
curl --fail --location \
  https://raw.githubusercontent.com/moby/profiles/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json \
  -o "$scratch/default.json"
node experiments/desktop-spike/namespace-profile.mjs \
  "$scratch/default.json" "$scratch/desktop-seccomp.json"
```

Build a minimal native FreeRDP in a **user-owned** directory:

```sh
bash experiments/rdp-spike/build-freerdp.sh "$scratch/freerdp" \
  /absolute/path/to/cmake /usr/local/opt/openssl@3
```

The last two arguments default to `cmake` and `/usr/local/opt/openssl@3`. On Apple
Silicon the usual OpenSSL prefix is `/opt/homebrew/opt/openssl@3`, but that host
architecture is not verified here. CMake 3.31.6 and FreeRDP 3.20.2 were tested.
The FreeRDP tag archive is SHA-256 checked before extraction:
`0b4f794845ece598ee3665847eeecba9deb56647000959529492152336a6253a`.
No global Homebrew installation or permission changes are required.

Run text/application acceptance, then bitmap acceptance:

```sh
VSPOD_RDP_SNAPSHOT="$scratch/text.png" \
node experiments/rdp-spike/run.mjs \
  --seccomp "$scratch/desktop-seccomp.json" \
  --freerdp-prefix "$scratch/freerdp/install"

VSPOD_RDP_CLIPBOARD=dib VSPOD_RDP_SNAPSHOT="$scratch/bitmap.png" \
node experiments/rdp-spike/run.mjs \
  --seccomp "$scratch/desktop-seccomp.json" \
  --freerdp-prefix "$scratch/freerdp/install"
```

The optional snapshot path receives the native rendered content; its
`.source.png` companion is the direct Linux screenshot. These do not capture
macOS window chrome. Requested files may be overwritten. The window closes
automatically. Each run removes its unique container and temporary host runtime
directory, including clipboard fixtures, native binaries and ephemeral TLS key.
Ctrl+C/SIGTERM triggers cleanup. Docker image/build cache, the explicitly chosen
FreeRDP build directory, Cargo build cache and requested snapshots remain.

Run acceptance sequentially, without a concurrent native dependency build: a
parallel compiler-heavy run exceeded the bounded clipboard request timeout.
Timeouts are failures, not silently retried successes.

## Transport and isolation

```text
AppKit NSWindow / NSImageView
  <- atomic local RGB frame snapshots (diagnostic, not production rendering)
  <- native C FreeRDP software GDI / CLIPRDR / display-control
  <- single-connection ephemeral host IPv4 loopback listener
  <- docker exec stdin/stdout tunnel
  <- container-loopback TLS xrdp
  <- direct xorgxrdp backend + private xrdp-chansrv
  <- Openbox + fullscreen genuine VS Code
```

- UID 1000, all outer capabilities dropped, no-new-privileges, read-only root.
- Same explicit namespace/seccomp profile as the prior sandboxed desktop spike;
  no privileged mode, unconfined seccomp or Electron `--no-sandbox`.
- 2 GiB memory, 2 CPUs, 512 PID/thread limit, 128 MiB shared memory, private
  executable/nodev/nosuid tmpfs. No host paths, Docker socket or persistent mounts.
- **No Docker ports published.** The host listener closes after its first
  connection; traffic is carried through a Docker-exec tunnel.
- **Direct mode has no session username/password authentication.** The dummy
  FreeRDP password is not a secret or an access-control mechanism. Docker-daemon
  access is the experimental boundary, with a residual local first-connection
  race on the loopback listener. Certificate pinning authenticates the server,
  not the connecting client. Do not expose this service as a production endpoint.
- Only display-control and clipboard channels are needed; drive, sound and USB
  redirection are not enabled. FUSE/device access is not granted.
- No real repository, account login or host credentials are supplied. Outbound
  networking is enabled for downloads.
- Workspace trust is disabled **only for this owned synthetic test workspace**
  so automated application copy/paste is possible. Third-party extensions are
  disabled. These are not defaults proposed for VSPod.

## Implementation findings

- FreeRDP 3 loads channels after its PreConnect callback. Set `LoadChannels` to
  `freerdp_client_load_channels`; loading add-ins only inside PreConnect leaves
  the reinitialized channel set empty.
- A direct xorgxrdp connection still needs a separately started, private
  `xrdp-chansrv` for clipboard. The newer package uses a per-UID socket directory.
  No root/PAM/sesman process was necessary for this experiment.
- Debian bookworm's xrdp 0.9.21.1 / xorgxrdp 0.9.19 rendered and resized, but the
  Unicode acceptance failed with corrupted text. The final image uses Debian
  trixie: xrdp **0.10.1-3.1+deb13u2**, xorgxrdp **1:0.10.2-1** when tested.
  These are observed package versions, not a frozen apt snapshot.
- Use BGRA32 for FreeRDP software GDI and explicitly convert to the RGB viewer
  buffer. The earlier RGBX32 path corrupted narrow bitmap regions despite
  plausible frame counts and geometry. Comparison against a direct server
  screenshot caught this; the final renderer passes that comparison.
- Graphics-pipeline negotiation is disabled in this minimal client. Its GDI
  callbacks implement the classic bitmap path, not an RDPGFX surface pipeline.
  H.264/FFmpeg are not required for this proof.
- The client sometimes logs transient finalization/synchronization warnings
  during resize; the final frame and direct-source comparison still pass. This
  is not reconnect/long-running stability acceptance.
- The diagnostic viewer samples atomic frame files at 10 Hz; it is intentionally
  not a high-performance renderer. In the automated `run.mjs` suite, resize requests are **scripted in the RDP
  client**; the AppKit content size follows the decoded image. Dragging the native
  window border sends live resize requests only in the interactive playground.
- Automated clipboard-suite shortcuts use synthetic X input, not the native
  input adapter exercised separately by the playground self-test. An IME adapter
  is not implemented. The editor's Linux menu remains visible inside the streamed image;
  no native macOS menu translation is implemented.

## FreeRDP versus IronRDP

```sh
cargo run --locked --manifest-path experiments/rdp-spike/ironrdp-probe/Cargo.toml
cargo metadata --locked --format-version 1 \
  --manifest-path experiments/rdp-spike/ironrdp-probe/Cargo.toml
```

The private probe pins `ironrdp = 0.17.0`, checks in its lockfile and opts into
only the protocol/session/graphics/input/clipboard/display-control features.
It does not enable the high-level client's platform clipboard, audio, video or
OpenH264 integrations.

| Area | FreeRDP | IronRDP |
|---|---|---|
| Upstream licence | Apache-2.0 | MIT OR Apache-2.0 |
| Embedding | C callbacks; direct AppKit/Swift or Rust FFI | Rust libraries fit Tauri's native backend |
| Resize | Actual server/editor/client resize verified here | Display-control layout encoding compiled and exercised |
| Clipboard | Actual Unicode/application and DIB transfers verified here | CLIPRDR backend interfaces compile; custom native clipboard backend still needed |
| Rendering | Runtime-tested software GDI buffer | Session/graphics crates compile; no connected rendering test here |
| Current evidence | Runnable macOS/container proof | API/dependency feasibility only, **not an equivalent runtime pass** |

The resolved IronRDP metadata graph contains permissive or permissive-choice
licence declarations, including Unicode-3.0 data licences. `r-efi` offers
`MIT OR Apache-2.0 OR LGPL-2.1-or-later`; its LGPL alternative need not be selected.
This is a declaration inventory, not a source-level legal audit. Review selected
features and transitive dependencies again before product integration.

**Recommendation:** use the verified FreeRDP client as the immediate reference
transport. Keep IronRDP as the Rust-native candidate, but require the same
connected resize, rendering and clipboard tests before choosing it.

## Licensing boundary

The selected remote-display components avoid GPL/MPL obligations:

- [xrdp](https://github.com/neutrinolabs/xrdp/blob/v0.10.1/COPYING): Apache-2.0.
- [xorgxrdp](https://github.com/neutrinolabs/xorgxrdp/blob/v0.10.2/COPYING):
  X11-style permissive licence.
- [FreeRDP](https://github.com/FreeRDP/FreeRDP/blob/3.20.2/LICENSE): Apache-2.0.
- [IronRDP](https://github.com/Devolutions/IronRDP): MIT OR Apache-2.0.

This **does not make the entire container GPL/LGPL-free**. Debian utilities,
Openbox, Electron dependencies and other packaged software have their own
licences and redistribution obligations. The minimal native FreeRDP build links
OpenSSL 3, zlib, its own WinPR libraries and Apple system libraries/frameworks;
the default Homebrew FFmpeg dependency tree was deliberately avoided.

VSPod's own code can remain permissively licensed while complying with bundled
third-party notices and terms. Review actual distribution/linkage, not just
top-level repository licences. Microsoft's VS Code binary is downloaded at
runtime rather than redistributed in this image, and its terms still apply.
The old 1.106.3 editor pin matches previous experiments, not a production version
recommendation or current Copilot certification.

## Still unverified / next acceptance

- Real native clipboard shortcuts/context menus and focus-based clipboard policy.
- PNG/TIFF/alpha/large-image conversion and actual Markdown/chat image paste over
  RDP. This spike proves only the tested CF_DIB/BMP transport.
- RDP file clipboard streams, Finder file promises and outbound drag/drop.
  Do not infer these from the earlier out-of-band file/XDND bridge. Both client
  libraries expose file-content hooks, but those are not runtime acceptance.
- Actual terminal selection/copy and safe multiline terminal paste over RDP.
  Editor text preserves tabs/blank lines; it does not prove terminal semantics.
- Broad native input/scrolling acceptance beyond the controlled playground
  self-test, IME, international layouts, Retina/scaling, GPU/Metal rendering,
  reconnect, suspend/resume, latency, throughput and resource-use benchmarks.
- Client authentication/capability transport, hostile-server payload hardening,
  clipboard bounds/format parsers and production permission UX.
- Official Copilot installation/login and genuine Marketplace/account terms.
- Any production Tauri integration or replacement of the current code-server path.
