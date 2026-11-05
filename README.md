# VSPod

A native macOS workspace for a repository-isolated editor: code-server by default,
or experimental desktop VS Code over Wayland.

## Status

The runtime and native paths are implemented, including a local
macOS app bundle, cancellable startup, recoverable operation locks, staged
progress, remembered folders, warm-window reuse and explicit environment upgrades.
Real native tests cover authentication, editing, extensions, terminal operation,
concurrent opens, quit/restore and cancellation. This is not a notarized release
or the full MVP. The host configuration engine and profile management are now
implemented, together with preview-first VS Code import, authoritative maintained
runtime settings, executable trust, restricted mode and container startup tasks.
Host GitHub/Azure login uses a native Keychain helper. Managed extensions support
exact-artifact approval, immutable caching and explicit stopped-runtime updates.
Provider credential
transport remains gated; host login does not authorize containers. The new
[implementation roadmap](docs/roadmap.md) replaces historical phase numbering.

```text
apps/cli            Commander commands and terminal experience
apps/desktop        Native Tauri window and bundled loading screen
apps/keychain-helper Native macOS secure-storage helper
packages/core       Startup, history, sessions and runtime contracts
packages/config     Versioned configuration loading, validation and resolution
packages/identity   Provider login, secure storage, refresh and broker policy
packages/extensions Open VSX artifacts, approval, caching and managed pins
packages/docker     Local container lifecycle and volume ownership
packages/workspace  Canonical repository identity
packages/app-runner Generic Wayland guest + macOS host (experimental)
packages/editor-backends Editor activation, sessions, readiness and extension adapters
```

The [isolated application runner](packages/app-runner/README.md) has been extracted from the Wayland
spike. Both a non-Electron GTK app and the VS Code playground consume it. VSPod's CLI now uses the
[editor backend adapters](packages/editor-backends/README.md), separate from generic container
operations. Desktop/Wayland is opt-in; code-server remains the default.

## Run

Runtime requirements: macOS, Node.js 22 or newer, npm, Git and Docker Desktop. Building the
native app also requires Rust 1.90 or newer and the Xcode Command Line Tools.
Docker Desktop must already be installed. The CLI
can request that Docker Desktop start, but never installs a runtime or uses sudo.

```sh
nvm use 22
npm ci
npm link
vspod setup
vspod open /path/to/your/git/repository
```

Node.js 22 and 24 are tested host runtimes; newer versions are not blocked.
If you do not use nvm, select Node.js 22 or newer through your normal installation method.
Instead of linking globally, run `npm run vspod -- open /path/to/repository` from
this checkout. The `--` is required to forward options such as `--backend desktop`
to VSPod rather than npm. This entry point enforces a Node.js 22 minimum before starting any
workspace or native helper. Setup can build the native app and request that the installed
Docker Desktop start, with your confirmation. Use `vspod setup --check` for
read-only checks or `vspod setup --yes` for noninteractive setup.
The first open builds the maintained VSPod image and can take
several minutes. Subsequent opens reuse that image and the repository container.

```sh
vspod open                  # Current folder; outside Git, select a recent folder
vspod open --recent         # Choose a remembered folder (latest in noninteractive mode)
vspod open --new-window     # Create a separate native window
vspod recent                # List remembered folders; --json for automation
vspod reopen                # Return to the most recently opened folder
vspod quit                  # Remember and close windows; keep environments warm
vspod restore               # Reopen the last saved window set
vspod stop                  # Stop this repository; retain its volumes
vspod logs --follow         # Stream the last 100 lines and subsequent output
vspod shell                 # Open a container bash session in /workspace
vspod doctor                # Check Node, npm, Git, local Docker and desktop
vspod open --smoke          # Verify startup and close its window without changing history
```

Opening the same folder again focuses its existing native window after a live
handshake. A warm open skips image building/preparation. Use `--new-window` to
override focus reuse. Subfolders reopen at their exact path while sharing the
repository container; only the repository root is mounted.

Closing a native window leaves its environment running. `quit` saves the active
folder set and closes tracked windows gracefully; `restore` reopens each saved
folder once, in up to eight folders, reusing any live window. It does not duplicate
multiple windows of the same folder. Recently opened folders are capped at 30,
with owner-only on-disk history containing paths but no credentials. Missing or
unavailable folders during restore are reported without blocking the others.

Use `vspod stop` to release container resources. Multiple windows share the same
backend session; restarting through VSPod generates new credentials. An old window
from a previous runtime session is not reused as an authenticated window.

## Native App Bundle

```sh
npm run desktop:package
vspod open
```

The bundle is generated at
`apps/desktop/src-tauri/target/release/bundle/macos/VSPod.app` for the build
machine's architecture. VSPod chooses the newest local app/executable build and
launches bundles through macOS Launch Services. It can also discover an existing
`/Applications/VSPod.app`. `VSPOD_DESKTOP_APP=/absolute/path/VSPod.app` selects an
explicit bundle; `VSPOD_DESKTOP_BINARY` takes precedence for development/testing.

Use `vspod open` to launch it; opening the app in Finder without a startup session
does not select a workspace. The bundle is locally built, not Developer ID signed
or notarized, and is not a standalone installer for the Node CLI/Docker assets.
Signing, notarization and self-updates remain outside this MVP slice.

`npm run desktop:build` remains available for a direct development executable.

## Experimental Desktop / Wayland Backend

This runs desktop VS Code inside the repository container, with individual macOS windows presented
by the generic Swift/Metal helper. It does not embed desktop pixels in Tauri or start the playground.
The maintained image installs pinned VS Code during image build, not on every workspace launch.

```sh
vspod setup --backend desktop
vspod open /path/to/repository --backend desktop
vspod shell --backend desktop
vspod logs --backend desktop
vspod stop --backend desktop
vspod extensions sync --backend desktop
vspod open --backend desktop --restricted
```

`--backend code-server|desktop` is a global option accepted on runtime commands. Alternatively set
`VSPOD_EDITOR_BACKEND=desktop` in your host shell. Unknown choices fail, with no silent fallback.
Repository configuration cannot choose the backend or grant host permissions. Recent selection, `reopen` and `restore`
remember the backend unless explicitly overridden by the flag or environment variable.

The two backends have independent containers, installed extensions, editor state, configuration
receipts and managed-extension pins. They share only the repository bind mount, host configuration,
trust policy and immutable VSIX download cache. Stop/shell/logs/upgrade target the selected backend,
not both; two simultaneously running backends can edit the same repository files.

Desktop applies resolved settings/keybindings, exact executable trust, approved startup tasks and
restricted mode through the same core flow. Native `.vscode` settings are redirected to the resolved
configuration source, not reapplied independently. Required accounts still fail closed: host login
does not inject credentials or provide editor OAuth callbacks.

Warm open focuses the existing helper; `--new-window` asks the guest editor for another window on
the same attachment. Subfolders use editor IPC and the same helper. `quit` detaches the helper and
keeps the guest warm; reopening reattaches to the live windows. Closing the guest application's final
window can end the application/container. `--smoke` creates and closes a fresh attachment without
changing history; detach an already attached desktop workspace with `quit` before smoke-testing it.
Cancellation stops a guest started by that open, not one that was already running.

Attachments have an exclusive, heartbeat-backed lease independent of recent-folder history.
A second supervisor cannot replace a live attachment. If the helper crashes, reopening attaches
to the existing guest. After a supervisor crash, allow five seconds for its lease to expire before
reopening. A stopped guest can be reopened; an externally restarted guest with a changed generation
requires explicit `stop` followed by `open`, rather than attaching with stale configuration.

```sh
npm run vspod -- doctor . --backend desktop
npm run vspod -- logs . --backend desktop
npm run vspod -- stop . --backend desktop
npm run vspod -- open . --backend desktop
```

Doctor reports the selected container, start generation, session match and native attachment,
including the private helper and supervisor log paths. Startup reports the native failure and
recovery hint instead of disguising a presenter crash as user cancellation.

Clipboard, Finder drops, file export from the workspace and recent-input browser handoff are
host-enabled for this opt-in adapter. Imported/exported files remain in private attachment directories
so pasted file URLs do not expire on detach. These directories and private host logs are under the
workspace's host state directory; do not clear them while their clipboard files are still needed.

The validated [renderer seccomp policy](packages/editor-backends/security/README.md) is bundled and
selected automatically. No environment variable is required. Advanced host configuration can set
`VSPOD_DESKTOP_SECCOMP` to an absolute profile path; an invalid override fails without fallback.
Unset a previous override to use the bundled default. Policy changes require explicit container
recreation/upgrade; stopping and starting an existing container does not change its Docker policy.

This is macOS-only, locally built and experimental. Neither
unconfined seccomp nor Chromium's `--no-sandbox` is used. Signed helper distribution,
multi-monitor/scaling polish, menu-based clipboard import, drag-out and full cursor surfaces remain
release gates. Microsoft's downloaded VS Code distribution retains its own license; this checkout
does not redistribute its binaries or promise proprietary extension support.

## Configuration And Profiles

```sh
vspod profile
vspod profile create work
vspod profile switch work            # This repository; global outside Git
vspod profile switch default --global
vspod config explain --json
vspod config explain --compatibility # Explicit .vscode inputs for this inspection
vspod config compatibility on        # Persist this repository's compatibility input
vspod trust                         # Review executable configuration before approval
vspod trust --revoke                 # Revoke future activation; stop to end workloads
```

Profiles live outside repositories under
`~/Library/Application Support/VSPod/profiles/<name>/profile.yml`. They and
`.vspod/vspod.yml` require `schemaVersion: 1`. Host resolution merges shipped
defaults, selected profile, explicitly enabled VS Code compatibility inputs, then
the repository definition. See [configuration documentation](docs/configuration.md)
for examples, the initial setting allowlist, storage and error handling.

These commands do not silently change running editors. Changed configuration
returns `CONFIG_RESTART_REQUIRED` on warm open: finish terminal work, stop, then
reopen. The new maintained image redirects folder settings to the resolved VSPod
source, so native `.vscode` settings do not independently override `.vspod`.
Old environments require explicit `vspod upgrade`. Selected extensions, profile
keybindings and startup commands require `vspod trust`; `open --yes` is not trust.
Required runtime accounts remain gated until credential transport is verified.

```sh
npm run identity:build
vspod login github
vspod login azure --client-id <your-public-client-id> --tenant-id <your-tenant>
vspod accounts --json
vspod logout <account-id>
vspod stop
vspod extensions sync             # Approve exact artifacts after vspod trust
vspod extensions update           # Explicit updates, never silent upgrades on open
vspod open --restricted           # Safe settings; skip user extensions/hooks/accounts
```

Login requires an interactive terminal. GitHub uses VSPod's public OAuth client
ID `Ov23liDC7oUEtbmsxOVh`; no application registration is needed for individual
users. Override it with `--client-id` or `VSPOD_GITHUB_CLIENT_ID` (flag wins).
Azure still requires your own public-client registration and tenant.
Device flow must be enabled in the GitHub OAuth App. Both providers open the system browser
and show a short code and expiry; enter the code and approve only a login you
requested. Use `--no-browser` for manual opening. Browser-launch failures leave
manual instructions and continue waiting. Device login needs no redirect URI or
client secret; Azure administrators may restrict this flow.
Tokens stay in Keychain; account listing is metadata only. Local logout does not
claim upstream token revocation. Extension installation uses Open VSX, not a
proprietary marketplace fallback. See [identity and extension behavior](docs/configuration.md)
for approval, optional selection, artifact limits and current provider/runtime gates.

### Import VS Code Configuration

```sh
vspod migrate                              # Read-only preview
vspod migrate --json                       # Structured preview
vspod migrate --recommendations-as-required # Explicit promotion
vspod migrate --write                      # Create .vspod/vspod.yml once
```

Imports supported `.vscode` settings and extension recommendations without
changing the source files. Recommendations become optional by default. Invalid,
unsupported or detected secret-bearing inputs block the import; existing
destinations are never overwritten. See the [migration guide](docs/configuration.md#import-existing-vs-code-configuration)
for exclusions, output and recovery.

Writing does not itself activate configuration. Subsequent `open` applies
supported settings on a stopped-runtime start and checks executable trust.
Migration itself performs no hooks, installs or account access.

## Environment Upgrades

```sh
vspod upgrade              # Replace an older maintained environment, with confirmation
vspod upgrade --rebuild    # Rebuild and replace even if already current
vspod upgrade --yes        # Explicit noninteractive consent
```

Opening a workspace never silently replaces its container. Upgrade prepares the
maintained image before stopping the old environment, preserves all four named
volumes, and retains the old container until the new editor is healthy. If startup
fails, it restores the previous container. Finish terminal jobs and back up
important data before upgrading: volumes are shared, not snapshotted, so this is
container rollback, not data rollback. Reopen afterward for a fresh native session.
Native attachments detach before replacement. Readiness or approved startup-task failures roll
back the container and reapply configuration, recording the restored start generation. Approved
startup tasks run again during recovery and should be safe to repeat. Cancellation cannot interrupt
the rollback; failed recovery is reported explicitly and unusable session/configuration receipts
are removed. This does not provide transactional rollback of startup-task side effects.

This command updates repository environments, not the VSPod application itself.
For application source updates, use your normal source-control update, then
`npm ci`, `npm run build`, and `npm run desktop:package`. Signed application updates
remain future work.

## Isolation And Persistence

Each canonical repository path has its own container, `/workspace` bind mount and
four named volumes:

| Volume suffix | Contents |
| --- | --- |
| `extensions` | Installed code-server extensions |
| `settings` | Editor profile settings |
| `state` | User data, workspaceStorage and globalStorage |
| `config` | Managed, non-secret code-server configuration |

The container bootstraps the code-server storage layout with symlinks between
these volumes. Repository `.vscode` files remain in the repository itself.
Settings, extension and storage paths never refer to host VS Code directories.
No volume is deleted by `stop`. Separate clones have separate identities; linked
worktrees whose Git metadata is outside the repository are rejected in the spike.

## Supported Scope

VSPod uses only its maintained image: code-server 4.106.3, Node.js 22.22.3,
npm and Git. It rejects repositories declaring devcontainer configuration rather
than silently ignoring it. Repository settings, profiles, trusted hooks and managed
universal extensions are implemented; Phase 4 host identity is available but its
container relay remains gated in the [current roadmap](docs/roadmap.md).
Arbitrary environment/credential injection is not supported.

Compose, compose-based devcontainers, devcontainer features, custom images/builds,
arbitrary mounts, remote runtimes and collaboration are not supported. Merely
having unused Compose files in a repository is not an error. Docker contexts must
use a local Unix socket; the CLI does not switch contexts. Colima provisioning and
non-Docker providers are not implemented.

code-server uses Open VSX; proprietary Microsoft extensions are not guaranteed to
be available or compatible. The native integration test uses a small known test
extension, not a claim that every VS Code extension works.

## Verify

```sh
npm test
npm run typecheck
npm run build
npm run desktop:test
npm run desktop:lint
npm run desktop:package
npm run test:docker
npm run test:registry
npm run test:native
```

Docker and native tests are opt-in. The native test opens its own temporary
windows and verifies extension activation, editing, a terminal command, warm focus,
subfolder reopening and CLI quit/restore. Docker tests cover credential rotation,
volume persistence, replacement/rollback and independent repositories. Startup
cancellation is checked against both newly started and already-running backends.
The registry test downloads ESLint 3.0.34 from Open VSX and verifies exact approval,
offline installation and managed-pin reuse; it needs network access and Docker.
The Docker suite also verifies a locally constructed VSIX without registry access.
Tests clean up only test resources. To explicitly exercise Launch Services:

```sh
VSPOD_DESKTOP_APP="$PWD/apps/desktop/src-tauri/target/release/bundle/macos/VSPod.app" npm run test:native
```

See [spike results](docs/spike-results.md) for measurements and verification gaps,
and [security notes](SECURITY.md) for the threat boundary.

## State And Recovery

VSPod stores owner-only session files under
`~/Library/Application Support/VSPod/spike`. This legacy directory is deliberately
retained so upgrading from the spike does not lose sessions or reset environments.
A running container without matching
session metadata is not silently restarted: use `vspod stop`, then `vspod open`.
New operation locks use heartbeats. A crashed lock can be reclaimed after 30
seconds without a heartbeat; active operations are never unlocked merely because
startup is slow. An older spike-era lock without the heartbeat format is not
automatically removed. If VSPod reports one, verify no older CLI operation is
running before removing the exact lock directory it identifies.

Ctrl-C, SIGTERM and early native-window closure cancel startup. VSPod waits for
cancelled child processes to exit, releases the operation lease and stops only a
backend started by that attempt. Existing running backends and all persistent
volumes are retained. The CLI returns exit code 130 for cancellation. SIGKILL and
power loss cannot run cleanup; the next attempt can reclaim an expired heartbeat
lock, but may still require `vspod stop` if a backend has no matching session.

`VSPOD_DESKTOP_BINARY` can select an explicit native executable for development;
`VSPOD_STATE_DIR` can isolate host session files during tests. Neither setting
adds a host mount or changes the local-only networking policy.

See [historical bootstrap results](docs/phase-1.md) for that verification scope.
See [runtime/native closeout](docs/runtime-native-closeout.md) for the latest work.
See the [current roadmap](docs/roadmap.md) and
[configuration foundations](docs/configuration.md) for the new architecture.