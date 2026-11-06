# Editor backends

VSPod editor policy sits above container lifecycle. The CLI selects `CodeServerBackend` by default,
or the opt-in `DesktopBackend` through the host-only `--backend desktop` flag / `VSPOD_EDITOR_BACKEND`.

## Boundaries

- `@vspod/core/backend` defines `EditorBackend`, `EditorSession` and `EditorPresentation`.
- `@vspod/docker` implements container operations against a caller-supplied image, build directory,
  volume list and loopback port list. It does not create editor credentials, apply settings, install
  extensions or probe an editor's health endpoint.
- `CodeServerBackend` owns the maintained image specification, activation/configuration command,
  password generation, session validation, web readiness and isolated extension installer.
- `@vspod/core` retains configuration/trust resolution, startup tasks, locks, history, progress,
  cancellation and upgrade orchestration.
- `DesktopBackend` owns its pinned image, configuration activation, native readiness, extension CLI
  and presentation supervisor. `DesktopRuntime` reuses Docker's volume ownership and replacement
  lifecycle, and delegates hardened container creation to `DockerAppRunner`.
- `@vspod/app-runner` remains independent of VSPod policy, profiles, workspace identity and accounts.

```ts
const backend = new CodeServerBackend();
await openWorkspace(backend, repository);
await stopWorkspace(backend, repository);
await syncWorkspaceExtensions(backend, workspace, approvalOptions);
await upgradeWorkspace(backend, repository);
```

`EditorPresentation` is a discriminated union:

```ts
type EditorPresentation =
  | { kind: 'web'; origin: string; authentication: { kind: 'password'; password: string } }
  | { kind: 'native'; sessionId: string };
```

Native presentations need no URL or web password. The Tauri web presenter consumes only explicit web
presentations, with the existing literal-loopback validation and automatic cookie authentication.
It rejects native sessions explicitly rather than treating a runner ID as a URL.

## Session and extension state

Private runtime state records the backend ID, container ID, start generation and presentation.
Only the code-server adapter generates or validates its web password. Warm opens verify the backend
and generation, then reconstruct the origin from the inspected loopback binding. A stored origin is
not authority to navigate somewhere else.

Applied configuration and extension receipts also record the backend ID. Core uses the adapter's
VS Code engine version and extension installer rather than assuming a particular executable.
The immutable download cache remains shared. Code-server preserves its four-volume layout.
Desktop uses `vspod-<repository-id>-desktop` and four volumes suffixed
`-desktop-{extensions,settings,state,config}`. Its session, configuration, extension receipt and
managed pins live in the private `desktop/` subdirectory of the workspace's host state.
The common repository lock serializes changes across both backends; configuration and trust remain
repository-wide. Only the repository mount is shared by the containers.

This is an experimental internal format change: stop an environment opened by the old implementation
before reopening it. If managed extensions have an old untagged receipt, run `vspod extensions sync`
while stopped. No repository files or persistent volumes need to be removed.

## Upgrades and recovery

The container driver owns stop/rename/create/restore. Core supplies an activation callback that invokes
the selected backend and waits for editor readiness. The same callback runs when a previously running
container is restored, so recovery creates and records a usable session for its new start generation.
Failed recovery is reported explicitly. A replacement is not accepted merely because Docker started it.
Activation also runs approved startup tasks and writes a matching applied-configuration receipt,
including on rollback. Those tasks may therefore run twice and must tolerate retries; shared-volume
and external side effects are not rolled back. Replacement activation observes cancellation, but
container mutation and restoration are shielded from it so an interrupted upgrade cannot abandon the
renamed previous container. Failed recovery clears unusable session/configuration receipts.

The code-server image and configuration scripts live under `images/code-server`.
The menu fixes ship as `vspod:4.106.3-node22-config-v3` and
`vspod-desktop:1.106.3-node22-v3`; volume names and ownership are unchanged.
Use `vspod upgrade --backend code-server` or `vspod upgrade --backend desktop` explicitly.
Stop/open alone reuses an existing image rather than replacing its container.

The web image includes a scoped titlebar overflow/stacking override so dropdowns can paint over
editor panes. System WKWebView's default user agent lacks `Safari/`, so it misses VS Code's
Safari-only overflow workaround. The override uses the existing menubar level, not an arbitrary
maximum z-index, and does not change desktop VS Code styling. Its build-time patch validates the
pinned editor's configuration and CSS anchors before writing either asset; upstream drift fails
the image build. Desktop popups retain their full client-drawn shadows through the generic runner.

## Native presentation

`npm run desktop:host` builds the generic Swift host and packages a local
`dist/VSPod.app` with VSPod's application name, bundle identifier and existing Tauri icon.
The adapter executes its `Contents/MacOS/VSPod` directly to preserve supervised stdin/stdout IPC.
The generic runner remains unbranded; it reads app identity/icon from its containing bundle when
packaged by a consumer. Guest document/repository window titles are preserved, and the application
menu offers `Quit VSPod`. This local development bundle is not Developer ID signed or notarized.
The Dock context menu lists the host's live editor windows using their current guest titles.
Selecting an entry restores a minimized window and focuses it; popup menus and dialogs are excluded.

`EditorBackend.nativePresenter` is an optional presentation capability, not a web URL. Core launches
a separate CLI supervisor with a fresh private attachment directory and sends the typed native session
after backend readiness. The supervisor uses the runner to attach the built Swift helper, records a
private `host.log`, and acknowledges readiness only after `WINDOW_FRAME`. It translates the same
private focus/close request protocol used by history into generic host controls.

There is one host attachment per desktop workspace, presenting all guest windows. Focus, subfolder
reuse and new-window requests use the running editor's IPC (`XDG_RUNTIME_DIR=/tmp/runtime`), not a
second compositor bridge. Normal last-window close and native quit stop the selected environment,
retaining volumes. One-of-many window close keeps it running. Explicit stop first closes tracked
attachments, then stops the selected container. Smoke detaches only its fresh attachment. A live existing attachment
must be detached before smoke, so validation cannot accidentally steal its bridge.

Core's native attachment service uses a private, heartbeat-backed exclusive lease, separate from the
repository operation lock. The lifetime lease expires after five seconds without a supervisor
heartbeat. Independent attachment metadata lets open discover a live host without trusting history;
live duplicate or unresponsive owners are never replaced. Container ID and start generation are
checked before attachment and monitored afterward. Host errors preserve structured diagnostics;
both private `host.log` and `supervisor.log` paths are available through `doctor [directory]`.

Host EOF detaches if the supervisor crashes. After lease expiry, open can reattach, replaying live
guest windows. A helper crash releases the lease without removing the guest or volumes. Guest exit
detaches the host; reopening starts a stopped guest. An externally restarted guest is deliberately
rejected until explicit stop/open creates a matching session and applies configuration.
History records the backend, so reopen/restore can select the right adapter. An explicit host flag or
environment selection overrides history; repository YAML never does. Exported clipboard files and
attachment directories are retained. Cleanup/rotation and signed helper packaging remain release work.

Core records private, generation-bound window lifetimes independently of recent-folder history.
A separate web-window supervisor watches Tauri's close acknowledgement after the opening CLI exits;
the native supervisor handles clean host exit after its final guest window closes or native quit.
Shutdown is serialized with open and upgrade, counts only the selected backend/generation and cannot
stop a replacement container on a late close. Shutdown failures are recorded explicitly in private
lifecycle state/logs. Crashes without a clean close retain the guest for recovery; the generic runner's
detach-by-default contract is unchanged. Reopening after normal close reruns approved startup tasks.

The desktop image is built from `images/desktop/Dockerfile` with the checkout as context and a
file-specific allowlist, plus the generic runner image. VS Code is installed during image build.
The version-specific folder-configuration patch fails the build if its anchor changes, rather than
silently allowing `.vscode` to become authoritative. The patch validates the original workbench
checksum and updates only that checksum in
the product manifest for the intentional transformation; installation-integrity checks remain enabled.
Older desktop images can report a corrupt installation because they retained the original checksum.
An explicit desktop upgrade installs the corrected image; do not suppress the warning globally.
Configuration arrives over stdin before editor
launch; no passwords or tokens are injected. Restricted launches use temporary user/extension trees,
skip profile keybindings and hooks, and never activate persistent extensions.

See the root [desktop instructions](../../README.md#experimental-desktop--wayland-backend) for setup,
the [bundled renderer policy](security/README.md), optional host-owned `VSPOD_DESKTOP_SECCOMP`
override, permissions and remaining limitations. The adapter resolves the default from the installation
root, not the current repository. Missing defaults and invalid overrides fail explicitly.

## Verification

From the repository root with Node.js 22 or newer:

```sh
npm test --workspace @vspod/editor-backends
npm test
npm run typecheck
npm run test:docker
npm run desktop:build
npm run desktop:host
npm run desktop:test
npm run desktop:lint
npm run test:native
VSPOD_DESKTOP_TEST=1 \
  npx tsx --test --test-concurrency=1 tests/desktop-backend.test.ts tests/desktop-recovery.test.ts tests/desktop-menus.test.ts tests/extensions-container.test.ts
```

Docker tests verify real authentication, credential rotation, managed settings, isolated extension
installation, volume persistence, repository isolation and rollback before and after replacement
activation. Native acceptance exercises the actual Tauri webview, automatic authentication, editor
save, container extension/terminal, warm-window reuse, cancellation and restricted mode.
Desktop acceptance exercises the actual native helper and VS Code: repository configuration beating
`.vscode`, keybindings, extension activation, file save, integrated terminal, stopped VSIX installation,
warm focus, subfolder IPC, multiple windows, detach/reattach, persistence, stop, smoke, cancellation,
account gating and actual CLI selection.
Recovery acceptance kills only disposable hosts/supervisors/containers and verifies duplicate
exclusion, retained volume contents, changed-generation rejection, successful replacement,
readiness-failure and cancellation rollback, matching restored receipts and actionable doctor output.
It simulates unavailable Docker through a scoped missing socket; it does not restart Docker Desktop
or claim actual daemon-restart acceptance.
Menu acceptance verifies actual system WKWebView dropdown hit-testing over split editor panes,
including the non-Safari user agent. Native desktop menu acceptance checks light/dark themes,
transparent corners, retained bottom-shadow pixels, no duplicate AppKit shadow and aligned input.
The web overlap symptom was intermittent and not deterministically reproduced on the old image;
the acceptance verifies the resulting rendering contract rather than claiming a reliable baseline failure.
