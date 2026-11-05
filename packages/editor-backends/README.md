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

The code-server image and configuration scripts now live under `images/code-server`.
Its existing image tag, volume names and runtime behaviour are unchanged.

## Native presentation

`EditorBackend.nativePresenter` is an optional presentation capability, not a web URL. Core launches
a separate CLI supervisor with a fresh private attachment directory and sends the typed native session
after backend readiness. The supervisor uses the runner to attach the built Swift helper, records a
private `host.log`, and acknowledges readiness only after `WINDOW_FRAME`. It translates the same
private focus/close request protocol used by history into generic host controls.

There is one host attachment per desktop workspace, presenting all guest windows. Focus, subfolder
reuse and new-window requests use the running editor's IPC (`XDG_RUNTIME_DIR=/tmp/runtime`), not a
second compositor bridge. Native quit detaches; explicit stop first closes tracked attachments, then
stops the selected container. Smoke detaches only its fresh attachment. A live existing attachment
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

The desktop image is built from `images/desktop/Dockerfile` with the checkout as context and a
file-specific allowlist, plus the generic runner image. VS Code is installed during image build.
The version-specific folder-configuration patch fails the build if its anchor changes, rather than
silently allowing `.vscode` to become authoritative. Configuration arrives over stdin before editor
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
npm run desktop:test
npm run desktop:lint
npm run test:native
VSPOD_DESKTOP_TEST=1 \
  npx tsx --test tests/desktop-backend.test.ts tests/desktop-recovery.test.ts tests/extensions-container.test.ts
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
