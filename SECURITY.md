# Security Boundaries

## Current Controls

- Exactly one repository bind mount, at `/workspace`; never mount the host home,
  `~/.ssh`, host VS Code state or Docker socket.
- Editor and terminal processes run as UID/GID 1000, with all Linux capabilities
  dropped and `no-new-privileges`. The image's inherited passwordless sudo rule
  and setuid fixuid bit are removed.
- Container port 8080 is published only on host `127.0.0.1`, using an allocated
  port. Inside the container, code-server binds `0.0.0.0` so Docker can forward it.
- All engine operations go through the TypeScript runtime adapter. Remote
  SSH/TCP Docker endpoints are rejected, honoring Docker's context precedence.
- Authentication is VSPod-owned. A cryptographically random 256-bit password is
  generated on each repository runtime start. Opening another window reuses that
  running session rather than invalidating existing windows.
- Secrets never appear in URLs, process arguments, Docker environment variables,
  labels or repository files. Bootstrap data goes through stdin to container
  tmpfs. Code-server reads its secret configuration from that tmpfs.
- Host runtime metadata is stored in owner-only directories/files (0700/0600),
  keyed to the actual container ID and start timestamp. `stop` removes the host
  credential file. A successful native handoff removes its transient startup file.
- Native Rust authenticates and installs an HttpOnly cookie into an ephemeral
  WebView store. Passwords are not injected into page scripts. Old cookies are
  rejected after a runtime restart; the Docker integration test checks this.
- Editor content has no remote Tauri capabilities or privileged application
  invoke handlers. Navigation stays within the assigned loopback origin;
  arbitrary new windows and external navigation are denied in editor content.
- Recent-folder history stores paths, timestamps and opaque launch-directory
  names, never credentials. Existing-window focus and graceful close use a
  challenge/response in owner-only launch directories, not a browser-accessible
  control server. Requests permit only focus/close and do not accept executable
  paths or arbitrary native commands. Windows from older runtime sessions are
  not reused for new authenticated sessions.
- Environment upgrades require explicit consent. The previous container is
  retained until the replacement editor is healthy. Volumes are preserved and
  shared during rollback, not snapshotted; this is not data rollback. Application
  updates and unsigned source changes remain the developer's responsibility.
- Devcontainer configuration remains unsupported. Repository startup hooks require
  explicit VSPod trust. Normal VS Code Workspace Trust remains
  enabled; the native test explicitly declares its own known probe extension
  compatible with untrusted workspaces.
- Profile and repository configuration is validated before runtime activation.
  The maintained image's pinned adapter redirects folder configuration to the
  generated VSPod source; native `.vscode` settings cannot independently override
  it. Compatibility inputs are disabled by default and host-controlled.
- Executable settings, selected extensions and startup commands require a matching
  host-local trust fingerprint. Changed configuration requires renewed consent.
  Hooks run only as container UID 1000 with a ten-minute timeout; warm focus never
  reruns them. `open --yes` cannot approve executable configuration.
- A changed/incomplete applied configuration cannot reuse a warm editor silently;
  stop/reopen is explicit. Trust revocation governs future activation, not code
  that already ran. Required runtime accounts fail closed while relay is gated.
- Restricted open skips user extensions, profile keybindings, hooks and account
  access, using fresh tmpfs user state. It is not a clean repository snapshot and
  does not undo code that previously ran.
- Extension artifact approval is distinct from repository trust. Downloads use
  fixed registry endpoints, bounded archive/manifest inspection and digest-pinned
  cache entries. Required versions are checked before warm focus. Automatic editor
  updates are disabled; no publisher-signature or malware-free claim is made.
- Extension installation uses an isolated non-root offline helper with only the
  extension volume and read-only VSIX mounted. There is no repository or Keychain
  mount. Manual extensions remain the user's responsibility.
- Host provider credentials use the native Security.framework Keychain helper,
  never plaintext configuration or Docker environment. Device login needs an
  externally registered public-client application; GitHub currently requests
  `read:user`, and Azure requests `openid profile offline_access User.Read` for
  Microsoft Graph. Neither flow currently grants Git repository operations.
- Account metadata excludes credentials. Login creates no runtime grant; no broker
  service, relay, generic token endpoint or raw credential injection is enabled.
  Local logout denies future host use but cannot promise upstream revocation.
- Configuration readers bound actual input size, reject escaping/dangling file
  symlinks, duplicate keys, alias expansion, unsafe keys and unsupported settings.
  Detected credential fields and common token/PEM material fail without echoing
  rejected values. This does not prove arbitrary text contains no secret.
- Profiles and selection metadata are owner-only. Atomic no-clobber profile
  creation and locked atomic selection writes do not overwrite existing profiles
  or silently reset corrupt metadata. See [configuration behavior](docs/configuration.md).
- Repository migration is preview-only unless `--write` is explicit. It uses
  the production configuration policy, blocks detected credentials/unsupported
  inputs without partial YAML, and never imports accounts or executable hooks.
  Publication uses a private staged file and atomic no-clobber link under the
  repository operation lock. Symlinked output directories and existing
  destinations are refused. Source snapshots are rechecked before publication;
  original VS Code files are not changed. This does not activate configuration
  or protect against a hostile concurrent same-user filesystem actor.

## Not Protected Against

The container can read and modify the mounted repository. Extensions, terminals
and repository tooling can execute code and make outbound network connections.
Installed extensions must be trusted accordingly. Per-repository containers reduce
accidental cross-repository sharing; they are not VM-grade sandboxes, and no
outbound firewall is implemented.

Same-user host malware, root and users authorized to control Docker are outside
the protection boundary. They may inspect host session files or container
processes. Localhost is not itself authentication: VSPod still enforces a secret
session. Cookies are not port-scoped, so a separate ephemeral native cookie store
is used for each launched desktop process.

Power loss or forced termination can leave private host metadata. New operation
locks use heartbeat leases with a 30-second stale threshold; a compromised lease
cancels work rather than allowing cleanup to mutate a potentially newer operation.
Unknown legacy locks require manual verification and are never auto-deleted.
Startup cancellation stops only the backend started by that attempt and retains
volumes. SIGKILL/power loss cannot trigger cleanup. VSPod fails safely on session
mismatch rather than resetting a running backend. It does not yet implement
Developer ID signing/notarization, automatic updates, or a full
host-boundary audit. A local `.app` bundle is available but is not a security or
distribution sign-off.

## Outstanding Image Warning

The editor's container-image scanner reports 7 critical and 35 high findings for
the `node:22.22.3-bookworm-slim` builder stage. This is unresolved. Only Node and
npm are copied from that stage, so those counts cannot be treated as the final
runtime image's findings; a separate final-image scan is still required. The
code-server base image and copied runtime dependencies also need a current
vulnerability assessment before release. A clean host `npm` audit does not clear
container-image findings. Do not treat this prototype as security-hardened.

## Next Security Gates

Repository executable configuration requires explicit consent, renewed when
its fingerprint changes. Extension artifact approval and credential grants must
remain separate from broad repository trust. Hooks execute only inside the
container as its non-root user and have explicit failure/timeout behavior.

Phase 6 in the [current roadmap](docs/roadmap.md) reviews mounts, privileges, credentials, exception-path redaction,
networking, Tauri capabilities, extension threats and dependency/image pinning.
Security defects discovered earlier must be fixed immediately, not deferred.

Phase 4 has host Keychain-backed provider identity and tested broker policy
foundations; authenticated broker service/runtime leases remain disabled. Login is
not a repository authorization. Prefer
brokered operations; tokens exposed to a container process can also be stolen by
malicious extensions sharing its UID. A short broker lease does not shorten an
upstream token lifetime, and logout cannot erase arbitrary copies. Real Keychain
access-control prompts, live OAuth registrations and runtime transport require
further acceptance. No per-extension isolation is claimed.

Authentication is contained in the session/bootstrap boundary so stronger local
authentication can replace password/cookie bootstrapping later. SSH agent
forwarding is a future opt-in feature; copying or mounting private SSH keys is
not a fallback. Remote hosts and multi-user collaboration remain non-goals.