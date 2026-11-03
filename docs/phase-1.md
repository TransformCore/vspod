# Phase 1: Bootstrap And Opening Experience

The working spike has moved into the requested five-package npm workspace.
The native source changes already in the checkout were preserved during the move.
Repository/container IDs, the existing maintained image tag and the private
state directory remain unchanged; reorganizing source does not replace a runtime.

## Implemented

- Workspace-owned imports, strict TypeScript checks and an esbuild CLI bundle.
- A native loading view with startup stages, responsive layout and reduced-motion
  support; terminal progress is interactive when attached to a TTY and readable
  in CI/log output otherwise.
- First-run privacy explanation, setup checks and a consented native build path.
- Owner-only recent-folder history with exact subfolder paths, recent selection,
  reopen and bounded window-set restoration.
- Existing-window focus via a native live challenge, rather than a saved PID;
  `--new-window` creates an additional window intentionally.
- Warm opens reuse the container and session without image preparation. Closing
  windows does not stop environments; `quit` preserves the last active set.
- Explicit maintained-environment upgrades, retained volumes and old-container
  rollback if a replacement fails. Rebuild is optional; no silent updates.
- Actionable error messages with stable reference codes and recovery guidance.

## Verification

- Unit/CLI checks: history serialization and bounds, concurrent updates, private
  state, upgrade credential preservation, first-run recent/reopen/restore errors,
  runtime locality and safe mount arguments.
- Native integration: real Tauri/WKWebView authentication, test extension execution
  as UID 1000, editing through VS Code's API, integrated terminal, warm focus without
  another window, exact subfolder selection and CLI restore of two folders in the
  same container.
- Docker integration: real login, stale-cookie rejection, all four volume
  categories surviving restart/replacement, and a deliberately failed replacement
  restoring the previous running container without deleting volumes.
- Native Rust tests, formatting and Clippy. Desktop and compact startup screenshots
  inspected at 1200x800 and 375x700; first-frame opacity and label wrapping fixed.
- The newly introduced esbuild advisory was corrected by moving to 0.28.2; npm
  audit is clean. This does not resolve the separately documented image warnings.

## Deliberate Limits

The app remains a developer build, not a signed `.app` distribution. Full packaging,
launch-services routing and self-updates are not claimed. Interactive setup uses
the terminal; there is no separate desktop onboarding wizard.

Restore reopens each remembered folder once, up to eight; it does not reconstruct
multiple copies of the same folder or restore terminal process contents. VS Code's
own storage and the native window-state plugin handle editor/native persistence.
Recent-folder history is not a credential store, and failed/cancelled opens do not
become successful recent entries. Stale-lock recovery and complete startup
cancellation remain follow-up work.

After the workspace move, the VS Code diagnostic provider continued to report
missing Node types and `.ts` import-option errors even though root and all four
explicit workspace `tsc` projects pass. Shared/per-package configs are present;
restarting the TypeScript service did not clear the reported diagnostics in this
session. This editor integration mismatch remains unresolved. Reload the VS Code
window and inspect its selected TypeScript project/version if it persists; do
not treat command-line success as proof the editor diagnostics are cleared.

Upgrade rollback restores a container, not changes that the replacement may have
made in shared volumes. Configuration/extension compatibility migration and
volume snapshots are not implemented. Repository-defined hooks and devcontainer
compatibility remain Phase 4 work. The original security and cold-start validation
gaps in the spike report still apply unless explicitly covered here.