# Phase 0 Architecture Spike

Date: 2026-11-02. Decision: proceed with the current architecture; retain the
working slice during the Phase 1 monorepo move. This is not completion of Phases
1-5 or a production security sign-off.

## Proven Path

`vspod open` resolves the Git root, starts/reuses its local container, launches a
native loading window, waits for code-server readiness, authenticates in Rust,
installs the session cookie, and navigates to the editor. The CLI waits for a
rendered editor acknowledgment rather than treating HTTP health as UI readiness.

A real native integration test loads a known container extension, verifies UID
1000 and the `/workspace` path, applies and saves a VS Code workspace edit, and
starts an integrated terminal that writes another file to the host-mounted
temporary repository. It does not use a browser as a substitute for WKWebView.

## Architecture Decisions And Lessons

1. Keep password authentication enabled, with VSPod-generated runtime-session
   credentials and native cookie handoff. No proxy or token URL was necessary.
2. Wry 0.57.1's macOS `cookies_for_url()` compares a cookie domain to
   `Url::domain()`, which returns `None` for IP literals. The initial prototype
   falsely reported failed cookie installation. Use the private native cookie
   store and explicitly match domain/name/value. A Rust regression test covers it.
3. Use Tauri 2.12.5 with a minimum Rust version of 1.90 and a committed Cargo
   lockfile. The earlier Tauri 2.10 pin did not compile against newly resolved
   supporting crates. The working local compiler is Rust 1.99.1.
4. Four simple named volumes work without a whole-home mount or nested Docker
   volume subpath dependency. Container-owned symlinks separate settings from
   workspaceStorage/globalStorage. Credentials remain in tmpfs, not these volumes.
5. Preserve VS Code Workspace Trust. The first custom-extension probe did not
   activate until that known probe declared untrusted-workspace compatibility.
   Globally disabling trust would have hidden a real behavior boundary.
6. Honor `DOCKER_CONTEXT` before `DOCKER_HOST`; validate the endpoint that the
   Docker CLI will actually use. The precedence case has a regression test.
7. Prefer a small runtime interface plus one adapter; do not build a provider
   framework or full devcontainer implementation before the editor flow works.

## Performance

Reference: MacBookPro16,1, Intel x86_64, 32 GiB RAM, macOS 26.7.1, Docker Engine
29.9.2, Node.js 22.22.3, npm 11.17.0, code-server 4.106.3, debug native build.
Docker was already running and the maintained image was cached for these runs.

| Scenario | Five samples (ms) | Median | Range |
| --- | --- | --- | --- |
| Running container, new native window | 7526, 7077, 7799, 7038, 6466 | 7077 | 6466-7799 |
| Stopped container, new native window | 9046, 8902, 8882, 10759, 9882 | 9046 | 8882-10759 |

Timings start inside the open command and end when the native page reports a
rendered `.monaco-workbench .part.editor`. They exclude Node CLI process startup
and are rendering measurements, not measurements of first successful user input.
The separate integration test proves file/extension/terminal functionality.
Container-only cached-image startup to health was approximately 1.9 seconds in
the Docker integration test.

The provisional 5-second warm-open target is missed; the 15-second cached-image
stopped-container target is met in these samples. Investigate editor loading and
native window startup before adding speculative orchestration optimizations.

Reproduce after `npm run desktop:build`:

```sh
vspod open --smoke
vspod stop
vspod open --smoke
```

## Runtime Validation Evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Local Docker and native executable availability | PASS, exit 0 | `vspod doctor` |
| TypeScript typecheck | PASS, exit 0 | `npm run typecheck` |
| Unit tests | PASS, exit 0 | `npm test`; Docker/native tests opt-in |
| Docker auth and persistence | PASS, exit 0 | `npm run test:docker` |
| Native edit/extension/terminal | PASS, exit 0 | `npm run test:native` |
| Rust session/origin tests | PASS, exit 0 | `npm run desktop:test` |
| Rust formatting and Clippy | PASS, exit 0 | `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`; `npm run desktop:lint` |

The Docker test confirms unauthenticated access is denied, login succeeds, stale
cookies fail after restart, volume content survives, and container identity is
reused. Integration tests create their own repository and resources and remove
only test-owned resources afterward. Browser automation is not the native
validation tier; the test uses the real Tauri/WKWebView application.

## Remaining Acceptance Work

- Docker Desktop launch from a stopped daemon is implemented but not exercised:
  the user started Docker before these measurements. Do not shut down their
  daemon merely to collect a benchmark.
- First-image pull/build and cold Docker startup timings remain unmeasured.
- Manual keyboard shortcuts, visual inspection, native window position/size
  restoration, and broader extension UI compatibility remain unverified.
- `.app` packaging, launch-services argument handling, external-link UX and
  complete startup cancellation/recovery belong to later phases.
- Image tags are pinned by version, not digest; finalize reproducible image
  provenance, dependency policies and a broader boundary audit before release.
- The editor scanner flags 7 critical and 35 high findings on the Node builder
   image. These remain unresolved; the final runtime image has not been separately
   assessed. See the security notes rather than interpreting npm audit as an
   image-security verdict.
- Configuration, trust consent for repository hooks, stale-lock recovery,
  supported-provider certification and non-Docker adapters are not implemented.

Overall: the central native-editor technical path is proven, with the remaining
Phase 0 acceptance items explicit. Proceed to bootstrap work without calling the
full MVP or complete spike acceptance finished.