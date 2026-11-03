# Runtime And Native Reliability Closeout

Date: 2026-11-02. Scope: the next Phase 2/3 slice, not repository configuration
or security sign-off.

Historical phase numbering below is superseded by the
[configuration/identity roadmap](roadmap.md). The subsequent
[host configuration foundations](configuration.md) add validation, profile
management and preview commands, not runtime activation or identity brokering.

## Delivered

- Operation-scoped cancellation reaches child processes, health checks and Docker
  startup loops. Children receive SIGTERM and are forcibly terminated if needed;
  callers wait for exit before releasing resources.
- Ctrl-C/SIGTERM and closing an early native window cancel opening. Cancellation
  stops only an environment started by that attempt, never an existing running
  environment. No volumes are deleted. Cancellation exits with code 130.
- Project mutation uses proper-lockfile heartbeat leases. Stale heartbeat locks
  recover after 30 seconds; active leases remain exclusive; lease compromise
  cancels the operation. Unknown legacy locks are preserved for manual recovery.
- `npm run desktop:package` produces a local macOS `VSPod.app`. The CLI discovers
  local app/development builds and selects the newest, or honors explicit
  `VSPOD_DESKTOP_APP`/`VSPOD_DESKTOP_BINARY` overrides.
- Bundle launches go through `/usr/bin/open -n -W ... --args --session ...`.
  Only the private descriptor path is in arguments, not credentials. The native
  app has an independent owner-only control watcher, including during loading,
  so a packaged loading window can close without native-command access for editor
  content.
- Setup builds an app bundle when no native installation exists. Existing
  development executable builds remain supported.

## Verified Behavior

- Unit tests: subprocess termination, cancellation propagation, timeout and secret
  output suppression; live lock exclusion and stale/legacy lock handling; cancelled
  startup preserving existing credentials/backends; bundle discovery and safe
  argument handling, including paths with spaces.
- Real Docker tests: independent repositories have distinct containers, ports
  and settings data; stopping one does not stop the other. Prior authentication,
  persistence, replacement and rollback coverage continues to pass.
- Real packaged native flow: Launch Services delivery, authentication, extension
  execution as UID 1000, file save, integrated terminal, concurrent warm opens
  focusing one window, exact subfolder selection, quit/restore, and cancellation
  both during warm attach and after starting a stopped backend.
- Release `.app` build, TypeScript checks and native tests/Clippy succeeded.

The app build is architecture-specific and has no Developer ID signature or
notarization. The CLI/runtime assets still come from the checkout. This does not
claim a standalone installer or a supported distribution channel.

## Remaining Work

- Verify Docker Desktop auto-start from a stopped daemon and first-download
  performance without disrupting an active developer Docker session.
- Verify native clipboard shortcuts, geometry restoration and broader extension
  UI compatibility. Add deliberate safe external-link handling and richer retry
  UX; current editor navigation remains restricted.
- Complete stronger runtime compatibility/provenance checks, exception-path
  inspection and image vulnerability assessment.
- SIGKILL can still leave private metadata or an unmatched running backend.
  Heartbeat recovery does not itself reconcile Docker state or credentials.
- Upgrade/replacement is not advertised as cancellable or transactional across
  power loss. Shared volume contents are not rolled back with the container.
- Repository configuration and its explicit trust/hook model remain Phase 4.
  The editor diagnostic mismatch documented in the Phase 1 report was not part
  of this runtime/native slice.