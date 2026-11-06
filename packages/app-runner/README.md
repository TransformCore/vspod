# Isolated application runner

Experimental macOS presentation of Linux Wayland applications in local Docker containers.
This package has no dependency on VSPod workspace identity, configuration, profiles, accounts or
editor extensions. VS Code is a consumer, not part of the runner.

## Components

- `src/`: TypeScript launch contract, hardened Docker arguments, ownership-checked lifecycle and host attachment.
- `guest/`: application-independent image, entrypoint and Rust/smithay compositor.
- `host/macos/`: Swift AppKit/Metal host, input handling and permission-gated clipboard, file and URL integration.
- `tests/`: non-Electron GTK notes fixture and real Docker/native lifecycle acceptance.

The generic image contains no editor, Git repository fixtures, RDP server or X11 window manager.
Application images derive from it and install their own executable. Applications must use Wayland and
run without root; this is not yet a compatibility promise for every GTK/Qt/Electron application.

## Build and validate

From the repository root, using Node.js 22 or newer, Docker, Rust and Xcode command-line tools:

```sh
npm run build --workspace @vspod/app-runner
npm run build:host --workspace @vspod/app-runner
npm test --workspace @vspod/app-runner
docker build -t vspod-app-runner:dev \
  -f packages/app-runner/guest/Dockerfile packages/app-runner
node packages/app-runner/tests/runtime.mjs --seccomp /absolute/path/to/renderer-seccomp.json
```

The seccomp policy must permit the application's renderer sandbox. Never use unconfined seccomp.
The native binary is built into `dist/app-host`; compilation is a build step, not an attachment step.
Consumers can package that binary in their own macOS app bundle. The host uses its bundle's
`CFBundleName` for the application menu and `CFBundleIconFile` for its Dock icon; unbundled launches
retain the generic `Isolated App` menu. VSPod branding belongs to the editor adapter, not this runner.
The VS Code fixture/playground in [experiments](../../experiments/wayland-capture/README.md) consumes this package
and retains the pixel, menu, terminal and host-integration regression suites. X11 is supported only by
the historical experiment adapter, not by the generic application image.

## API

`AppLaunchSpec` takes an application image, absolute executable plus argument array, explicit mounts,
resource limits, scale, file-export roots and host permissions. It deliberately takes neither a
repository path nor a VSPod configuration object. Commands are never concatenated into a shell.

```ts
const runner = new DockerAppRunner();
await runner.create(spec); // spec: AppLaunchSpec, image already built
await runner.start(spec.id); // waits for a mapped application window, not merely a running container
const host = await runner.attach('/path/to/app-host', privateSessionDirectory, {
  container: spec.id,
  protocol: 'wayland',
  integrations: spec.integrations,
});
host.stdout?.on('data', handleHostEvents);
host.on('error', handleHostError);
// Closing the host detaches by default; the guest keeps running.
await runner.stop(spec.id); // retains mounts and volumes
await runner.remove(spec.id); // stopped containers only; never deletes volumes
```

Create a fresh, mode-0700 host attachment directory on each attach. `host.json` is created exclusively
with mode 0600; the native host checks ownership, permissions and the bridge command allowlist.
The caller owns child-process supervision, host readiness (`WINDOW_FRAME`), attachment directory
retention, volume provisioning and cleanup. Keep exported clipboard files alive as long as they may
be pasted; deleting an attachment directory invalidates its exported file URLs.
Attachment stderr is inherited by default; pass a fourth argument `{ stderr: 'pipe' }` to capture it
in a private supervisor log. Keep stdin open for host controls; EOF detaches the host without stopping
the guest. `{"action":"focus"}` raises the live application windows and emits `WINDOW_FOCUSED`.

`stopGuestOnQuit: true` opts into stopping the compositor on host quit for disposable tests.
Default detach does not send a guest quit. Closing the application's own final window can still end
the application/container; detach does not override the application's lifecycle.

`HostIntegrations` requires explicit `clipboard`, `files` and `externalUrls` booleans. Clipboard import
is paste-gesture-only; export and URLs also require recent guest input. File transfer needs its own
permission, and clipboard files require both clipboard and file permissions. Export roots are
container paths, not host paths; no export root is implied by a workspace convention. The private
guest staging directory is also exportable. Existing size, path and URL checks still apply.

Launch specifications and attachment permissions are trusted host inputs, never repository-provided
commands or grants. Mounts and environment variables are not a secret broker. VSPod must resolve trust
and credential policy before invoking the runner.

The Electron menu-pointer nudge is off by default; an Electron application adapter may opt in through
`electronMenuNudge`. It is not generic pointer behaviour.

## Protocol and lifecycle

Guest-to-host messages are a 4-byte big-endian JSON-header length, a UTF-8 JSON header and exactly
`header.bytes` payload bytes. Host-to-guest commands are newline-delimited JSON.
The first Wayland message is `{"type":"ready","version":1,"wayland":true,"bytes":0}`; unsupported versions
fail explicitly before presentation. Window metadata, damage frames, cursors, destruction and host
integrations retain the tested spike wire format. An attachment replays every live window and a full
frame before subsequent damage. Never drop partial-damage messages when coalescing draws.

Window `x`, `y`, `width` and `height` describe the captured surface in logical coordinates.
The additive `geometry: [x, y, width, height]` field identifies the window body within that capture.
Toplevels remain cropped to xdg window geometry; popups retain the complete surface, including
client-drawn shadows outside the body. Popup placement and pointer translation use the capture
origin, while hit-testing uses the body. ARGB popup alpha is preserved through Metal presentation
and snapshot PNGs; transparent popup panels disable AppKit's extra shadow to avoid doubling it.

## Integration boundary and remaining work

VSPod's opt-in `vspod open --backend desktop` uses this runner through the separate
[desktop editor adapter](../editor-backends/README.md), with persistent repository volumes,
configuration, extensions, trust and native lifecycle supervision. Code-server remains VSPod's default.
Account management does not belong in this package; VSPod runtime credential transport remains gated.

The host remains macOS-only and software-rendered, with one fixed output. Menu-based clipboard import,
drag-out, full cursor surfaces, multi-monitor scaling, signed native helper
distribution and authenticated VSPod credential transport remain follow-up work. See the
[spike limitations](../../experiments/wayland-capture/README.md#known-limitations).
VSPod's desktop adapter bundles its own validated renderer policy; the generic runner deliberately
keeps policy selection explicit for other application consumers.
