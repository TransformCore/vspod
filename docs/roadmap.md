# Configuration, Identity And Secret-Management Roadmap

This roadmap supersedes forward-looking phase numbers in the historical spike,
bootstrap and native closeout reports. Phase 0 is complete; the existing Tauri,
code-server, Docker, authentication and repository-volume architecture is the
baseline. Historical reports remain evidence, not the current implementation plan.

## Current Delivery

- Phase 1 host engine: implemented and covered by configuration tests.
- Phase 2 profiles: implemented, including stopped-runtime settings/keybindings.
- Phase 3 repository activation: implemented for supported settings, exact trust,
  compatibility preferences, startup tasks and restricted mode.
- Phase 4 host identity: implemented Keychain helper, provider device flows,
  accounts CLI and broker policy foundations. **Not runtime-complete:** authenticated
  broker service/relay, account grants CLI and live provider acceptance remain gates.
- Phase 5 extension lifecycle: implemented stopped-runtime reconciliation,
  exact-artifact approval, immutable cache, explicit update and open-time required
  version checks. Universal VSIX only; proprietary extensions are not guaranteed.
- Phase 6 release/security hardening: not complete.
- Phase 7 repository import: implemented early as an independent host-only slice.
  Legacy runtime-state migration remains unimplemented.

See [configuration behavior](configuration.md) for exact shipped contracts and
limitations. A phase is not runtime-complete merely because its model parses.

## Dual Editor Backend Integration

The existing code-server backend remains the default. Integrate the native Wayland path in
independently validated batches, without making the generic runner depend on VSPod policy.

1. **Runner extraction - implemented.** [App runner](../packages/app-runner/README.md) owns the generic
   TypeScript launch contract, hardened container arguments, Rust compositor and Swift host.
   The guest image contains no editor or fixture workspace. Host capabilities and export roots are
   explicit; Electron's pointer workaround is opt-in. VS Code's playground consumes the package.
   Acceptance: existing Wayland/X11 suites, clipboard/drop/URL integration, and a non-Electron GTK
   app with keyboard input, denied host permissions, detach/reattach and mounted data retention.
2. **Editor backend boundary - implemented.** [Code-server adapter](../packages/editor-backends/README.md)
   separates Docker operations from editor activation, readiness, extensions and presentation.
   Sessions distinguish web/native presentation; passwords remain code-server-specific. Applied
   configuration and extension receipts identify their backend. CLI open/upgrade/extensions route
   through the adapter; stop/logs/shell use its container driver.
   Acceptance: code-server unit, real Docker and Tauri end-to-end lifecycle tests pass through the new
   boundary, including replacement activation failure and restored-session authentication.
3. **Desktop VSPod adapter - implemented, opt-in.** Host-owned `--backend` / `VSPOD_EDITOR_BACKEND`
   selection and backend-specific containers, volumes and receipts.
   Real repository mounts and persistent volumes, resolved settings,
   keybindings, managed extensions, startup-task trust and restricted mode reach desktop VS Code.
   Acceptance: `vspod open --backend desktop` and existing stop/logs/shell flows operate on a real
   repository, with no fixture downloads or generated files in it. The editor is installed at image
   build time; the validated renderer seccomp profile is bundled and selected automatically, with an
   optional host-only override. No session-directory artifact is required.
4. **Lifecycle and release gates - partially implemented.** A separate supervisor tracks native host
   attachment and readiness independently of guest lifetime. Warm focus, subfolder IPC, extra windows,
   detach/reattach, stop, smoke and cancellation are wired; history restores the selected backend.
   Exclusive heartbeat leases prevent duplicate attachment and permit stale-supervisor recovery.
   Container generations are checked before attachment and monitored afterward; explicit stop/open
   recovers external restarts without accepting stale configuration. Doctor exposes container/session
   state and private host/supervisor log paths; startup preserves actual presenter failure diagnostics.
   Acceptance: disposable native-host/supervisor crashes, container kill/restart, duplicate exclusion,
   volume retention, successful upgrade, readiness-failure rollback and cancelled-upgrade recovery.
   Restored configuration/session receipts match the recovered generation; failed recovery clears them.
   Rollback is cancellation-shielded, but shared data and startup-task effects are not transactional.
   Remaining: actual Docker Desktop/daemon-restart acceptance (only a scoped unavailable endpoint is
   simulated), intended identity flows, bundled/signed
   native binaries, signed policy distribution, clipboard-file cleanup, multi-monitor/scaling polish.
   Acceptance: dual-backend end-to-end coverage, explicit unsupported-platform errors and
   documented limitations before promoting desktop beyond opt-in experimental status.
5. **Menu rendering polish - implemented.** The runner retains full popup buffers and client shadows,
   with body geometry separate from capture bounds so placement and input remain aligned.
   Transparent panels do not add a second AppKit shadow. The maintained web image explicitly
   enables titlebar overflow and menu stacking for WKWebView, whose user agent omits Safari.
   Acceptance: native light/dark corner alpha, retained bottom-shadow pixels and real popup input;
   system WKWebView dropdown hit-testing over actual split editor panes. The intermittent old-image
   web occlusion was not reliably reproduced; its missing Safari-only workaround was confirmed.
   Existing environments require explicit backend upgrades; persistent volumes are retained.
   The desktop build validates the upstream workbench checksum before patching and records only
   the intentional transformation in the integrity manifest. Runtime checks remain enabled;
   acceptance verifies all protected files and absence of corruption diagnostics in editor logs.
6. **Last-window shutdown - implemented.** Normal final-window close and CLI/native quit stop the
   repository/backend container, retaining all volumes and restore history. Closing one of several
   windows keeps the shared environment running. Web windows have an independent lifetime supervisor;
   native shutdown follows clean final-window/host exit. Generation checks and repository locking
   serialize shutdown with opens/upgrades so stale close events cannot stop replacement guests.
   Presenter crashes retain recoverable guests; smoke remains a validation-only detach exception.
   Acceptance: one-of-many close, final close, quit/restore, generation/backend isolation, retained
   data and explicit shutdown diagnostics.
7. **Native app identity - implemented locally.** The editor adapter packages the generic host in
   `VSPod.app` with VSPod's shared icon, bundle name and `Quit VSPod` menu. Guest document/project
   window titles and supervised stdin/stdout remain intact. Setup builds the bundle; missing bundle
   assets fail explicitly. Acceptance: branded bundle identity and byte-identical icon in real desktop
   lifecycle/menu tests; unbundled GTK runner remains generic. Signing/notarization remain release gates.

**Dependencies:** configuration/trust and extension lifecycle above; identity broker transport before
claiming container account support. The runner receives resolved launches, not repository YAML or credentials.

**Risks:** desktop/code-server state formats, extension compatibility, native binary distribution,
clipboard-file retention, app-specific Wayland behaviour and single-output scaling. Do not silently
fall back between backends, share installed extension trees, or make the runner an identity broker.

## Phase 1 - Core Configuration Engine

**Deliverables**

- `packages/config`: TypeScript models, JSON Schema v1, YAML/JSONC loaders,
  bounded reads, semantic validation and explicit diagnostics.
- Defaults, deterministic merge, provenance and fingerprints.
- `vspod config explain [directory] [--compatibility] [--json]`.

**Acceptance criteria**

- Defaults < profile < enabled compatibility < repository, with arrays replaced.
- Invalid/missing versions, malformed files, duplicate keys, unsafe paths,
  unsupported settings and detected secrets fail explicitly without value echoes.
- Exact file-size limits and deterministic fingerprints are tested.
- Resolving configuration performs no Docker actions, installations or hooks.

**Dependencies:** existing workspace identity and CLI error conventions.

**Risks:** limited setting allowlist; parser differences from VS Code; confusing
fingerprints with trust. The schema and runtime validator must evolve together.

**Implementation evidence**

- [x] Add `packages/config/src/{model,load,validate,merge,index}.ts`.
- [x] Add `packages/config/schemas/config-v1.schema.json`.
- [x] Add configuration tests and CLI inspection integration.

## Phase 2 - Profiles

**Deliverables**

- Private portable profiles outside repositories.
- `profile`, `profile create [--from]`, `profile switch [--global]`.
- Host-local repository selection with global fallback.
- Core persistence module reusing existing private-file helpers.

**Acceptance criteria**

- Creation never overwrites, copying validates source, invalid switches preserve
  prior selections and concurrent writes do not lose unrelated repository choices.
- Profile path traversal/symlinks and public files fail.
- Virtual empty default is supported; corrupt existing data never falls back.
- Warm open checks the selected snapshot before focus. Changes require an explicit
  stop/reopen, never silent hot reload. Managed settings/keybindings reconcile
  without clearing unrelated editor data or manual extension state.

**Dependencies:** Phase 1.

**Risks:** two windows sharing one repository cannot have different active
profiles; profile themes/extensions may not exist in Open VSX.

**Implementation evidence**

- [x] Add `packages/core/src/profiles.ts` and persistence tests.
- [x] Add host CLI management and per-repository selection.
- [x] Activate profile settings/keybindings in the runtime as part of Phase 3.

## Phase 3 - Repository Definitions

**Deliverables**

- Authoritative `.vspod/vspod.yml` runtime configuration.
- Maintained code-server configuration-source adapter; host compatibility preference.
- Trusted executable-configuration review and restricted mode.
- Approved container-only startup tasks with cancellation and timeout behavior.
- Applied-versus-desired manifests and explicit reload/reconciliation.

**Acceptance criteria**

- A real-editor test proves `.vspod` beats conflicting `.vscode` settings.
- Compatibility disabled means native `.vscode` is not independently reapplied.
- Never rewrite repository `.vscode` files to simulate precedence.
- Resolve/reconcile before warm-window focus in `packages/core/src/open.ts`.
- Settings, keybindings and executable content receive policy review; changed
  executable configuration invalidates trust. Noninteractive open fails without
  an appropriate existing grant. `--yes` is not trust.
- Startup hooks run as UID 1000, in `/workspace`, once per newly started runtime,
  not per focus; sequential execution stops on failure, ten-minute per-task
  default timeout, no account capabilities by default.
- Failed activation never records success. No silent running-container replacement.
- Preserve cancellation, locking, native authentication and four-volume persistence.

**Dependencies:** Phases 1-2.

**Risks:** code-server patch maintenance, native workspace-configuration precedence,
executable keybindings, hook side effects and shared-volume rollback limitations.

**Tasks**

- [x] Validate and activate supported definitions, not preview-only parsing.
- [x] Extend `packages/core/src/runtime.ts` with non-secret configuration contracts.
- [x] Add pinned editor configuration adapter under `packages/editor-backends/images/code-server/`.
- [x] Add `packages/core/src/trust.ts` and fingerprint-bound host-local grants.
- [x] Add desired/applied fingerprint and container/start binding.
- [x] Wire open, cancellation and successful upgrade activation; changed/incomplete
  configurations (including restarted rollback sessions) require explicit restart.
- [x] Add real-editor precedence, subfolder, hook-once and restricted-mode tests.

The adapter intentionally redirects folder configuration resources away from
native `.vscode` task/launch/MCP files. Supported settings can be imported as
compatibility inputs; arbitrary native task/launch/MCP activation is not supported.

## Phase 4 - Identity Broker

**Deliverables**

- `packages/identity`: provider, secure-store, refresh, account, grant and lease contracts.
- `apps/broker`: per-user host service and authenticated private IPC.
- Native macOS Keychain helper using Security.framework; no plaintext fallback.
- GitHub and Azure public-client login; `login`, `logout`, `accounts`.
- `packages/runtime-agent`: authenticated reverse relay and approved tool adapters.

**Acceptance criteria**

- Keychain is the source of truth for provider tokens/caches. Repository
  declarations contain provider requirements only, never credentials.
- Provider registrations, redirects/scopes and Azure tenant policy are verified.
- GitHub device flow handles polling/slowdown/cancellation; do not assume every
  GitHub token expires or supports refresh. Azure uses MSAL with PKCE or an
  explicitly supported device flow and Keychain-backed cache persistence.
- Multiple accounts require explicit host-local mapping. Login is not a
  repository grant; requests check operation, account, resource and scopes.
- Refresh is single-flight, rotated records persist atomically, revoked grants
  require reauthentication, locked Keychain fails closed.
- A supervised `docker exec -i` reverse relay binds to workspace ID, container ID
  and start timestamp; stdin bootstrap capabilities never enter Docker metadata.
- Prefer constrained operations/Git helper over raw token delivery. Explicit file
  adapters use tmpfs/0600/atomic rotation; environment adapters target one managed
  child process only. No host credential directories or socket mounts.
- Runtime leases expire/rebind; stop/replacement/logout revoke access. Report
  upstream revocation failure honestly. A short broker lease does not shorten
  the lifetime of a copied upstream token.
- No provider tokens in the native WebView, startup descriptors, URLs, arguments,
  Docker environment, labels, repository configuration or persistent volumes.

**Dependencies:** Phase 3 trust and runtime lifecycle; OAuth application registrations;
native helper packaging/signing/access-control validation.

**Risks:** GitHub token breadth, Azure enterprise policies, credential-bearing
tools, revocation limitations and same-UID extension access. No per-extension
secret isolation is claimed.

**Tasks**

- [x] Implement provider/storage contracts and mocked GitHub/Azure flow tests.
- [x] Build native Security.framework helper without accessing user credentials.
- [ ] Verify live GitHub/Azure login with registered public-client IDs and user consent.
- [x] Add private account metadata, broker grants model and refresh locks.
- [ ] Expose reviewed account bindings/grants through the CLI and broker service.
- [ ] Add broker IPC, runtime relay and replay/cross-workspace denial tests.
- [ ] Wire open/stop/cancel/replace/rollback to lease lifecycle.
- [x] Remove local credentials on logout and explicitly report unsupported upstream
  revocation. No runtime credential delivery is enabled.
- [x] Reserve future Copilot, Salesforce and AWS provider IDs without pretending they work.

GitHub Copilot requires separate entitlement/editor integration. Salesforce must
bind identity to an approved org/instance. AWS should prefer Identity Center and
bounded STS sessions, not static keys.

## Phase 5 - Extension Lifecycle

**Deliverables**

- `packages/extensions`: registry adapter, exact-version planner, immutable artifact
  cache, managed-install manifest and staged reconciliation.
- Required/profile/optional extension approval and explicit update/reload commands.

**Acceptance criteria**

- Use Phase 1 intent semantics; resolve unversioned intent to a recorded version.
- Required unavailable/incompatible extensions fail activation clearly; optional
  failures remain visible. Never silently substitute a different extension.
- Cache immutable SHA-256 VSIX artifacts and record registry identity/version/digest
  in workspace-specific pins. Verify embedded manifest identity, version and engine.
  Reject explicitly platform-specific packages until a target-aware resolver ships.
- Shared downloads are immutable; writable installations remain repository-scoped.
- No silent upgrades on open. New executable versions/digests receive policy review.
- Preserve manual installations and all workspace state. Test partial installation.
- Verify registry availability and engine metadata separately from licensing,
  entitlement and real editor behavior. Never infer entitlement from a download.

**Dependencies:** Phases 1-3; Phase 4 only for identity-dependent integrations.

**Risks:** proprietary marketplace restrictions, engine/platform compatibility,
extension self-updates and extensions writing credentials into editor storage.

**Tasks**

- [x] Add fixed-registry resolver, bounded artifact cache and per-workspace manifest.
- [x] Add exact version/digest approval before offline, non-root isolated installation.
- [x] Preserve unmanaged installs; refuse their conflicting version takeover.
- [x] Add stopped-runtime `extensions sync` / `extensions update`, optional selection,
  required/optional failure tests and actual Docker VSIX installer acceptance.
- [x] Gate open on reconciled intent and required installed versions; disable editor
  automatic extension updates.
- [ ] Add target-specific packages, publisher authentication and transactional
  installation rollback. Partial installs retain accurate pins and require retry;
  no whole-volume rollback is promised.

Registry check: ESLint `3.0.34` and Playwright `1.1.19` were available with engine
ranges compatible with VS Code 1.106.3. `github.copilot` returned 404 from Open VSX.
GitLens metadata was available with an engine-compatible VS Code range but a
Node >=24 declaration and unresolved localized license text: it is **not certified**
against the maintained Node 22 runtime. Playwright licensing and editor behavior
also require release review; registry presence is not that review.
The real ESLint 3.0.34 acceptance test passed from registry resolution through
bounded VSIX validation, exact digest approval, offline Docker installation and
unchanged-pin reuse.

## Phase 6 - Security Hardening

**Deliverables**

- Final-image vulnerability/provenance assessment, broker/relay misuse tests,
  redaction review, crash recovery and native capability/signing checks.
- Updated threat boundary and release gates in `SECURITY.md`.

**Acceptance criteria**

- Malicious repository content cannot enable privileged containers, arbitrary host
  mounts, host hooks or arbitrary OAuth endpoints.
- Broker has no unauthenticated route, arbitrary URL proxy or unrestricted token API.
- Stale runtime/cross-workspace lease replay fails.
- Test malicious extensions, credential theft attempts, repository compromise,
  untrusted hooks, container escape mitigations and token leakage paths.
- Keep non-root, dropped capabilities, no-new-privileges and no Docker/home/SSH mounts.
- Final runtime image findings are assessed separately from builder-stage findings.
- Known release-blocking vulnerabilities prevent release; residual same-user-host,
  Docker-admin and extension/container risks are documented.

**Dependencies:** all enabled feature surfaces. Baseline controls ship with each
earlier feature; this phase is not permission to defer known security defects.

**Risks:** upstream image/editor defects, powerful approved workloads and
overclaiming isolation. Containers are not VM-grade sandboxes.

**Tasks**

- [ ] Audit credentials, OAuth endpoints, IPC, mounts, logs and native capabilities.
- [ ] Exercise broker crash, Keychain lock and unmatched backend recovery.
- [ ] Scan/pin final-image inputs and document release decisions.

## Phase 7 - Migration Tooling

**Deliverables**

- `vspod migrate`: preview by default, explicit `--write`.
- JSONC settings/recommendation import into schema-versioned `.vspod/vspod.yml`.
- Journaled stopped-workspace metadata migration without changing runtime IDs.

**Acceptance criteria**

- Preserve source `.vscode` files byte-for-byte; never overwrite existing destination
  implicitly; production loader validates generated output.
- Recommendations become optional unless explicitly promoted to required.
- Unsupported or detected secret-bearing input is reported without value leakage
  or silently dropping fields. Never infer accounts, hooks or grants.
- Repeat invocation is safe. Existing volumes, workspace IDs and live locks
  remain intact. Do not move active legacy session files.
- Add fresh-install, legacy-state and failed-write recovery fixtures.

**Dependencies:** Phases 1-3 and stable Phase 5 extension semantics; Phase 6 release gate.

The host-only repository importer is delivered against Phase 1's validated
declaration semantics without enabling runtime behavior. Full Phase 7 completion
still depends on the later activation, lifecycle and security work above.

**Risks:** sensitive legacy settings, ambiguous extension recommendations and
concurrent old/new CLI versions.

**Tasks**

- [x] Add importer, preview, validated no-clobber writer and explicit conflict UX.
- [ ] Add legacy-state migration journal and recovery tests.
- [x] Document repository import, exclusions, activation gate and recovery behavior.
- [ ] Complete fresh-install/legacy-state upgrade instructions after runtime migration.

## Storage Boundaries For Remaining Work

Implemented profiles and selection locations are in [configuration.md](configuration.md).
Planned storage:

| Data | Location | Classification |
| --- | --- | --- |
| User application preferences | Application Support/VSPod/settings.yml | Portable, non-secret |
| Identity metadata | Application Support/VSPod/identity/accounts.json | Machine-specific, private |
| Account bindings/configuration | Application Support/VSPod/accounts/ | Machine-specific; public-client IDs/endpoints are not secrets |
| Trust grants | Application Support/VSPod/trust/ | Machine-specific; never import trust automatically |
| Workspace applied state | Application Support/VSPod/state/workspaces/ | Machine-specific |
| Redacted bounded logs | ~/Library/Logs/VSPod/ | Machine-specific, privacy-sensitive |
| Immutable extension downloads | ~/Library/Caches/VSPod/extensions/ | Rebuildable |
| Tokens, refresh material, MSAL cache | macOS Keychain | Secret |
| Runtime credential adapters | Container /run/vspod tmpfs | Secret, ephemeral |

The existing `spike` state directory and repository Docker volumes stay where
they are until an explicit, journaled compatibility migration is delivered.
