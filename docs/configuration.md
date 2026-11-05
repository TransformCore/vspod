# Configuration And Profile Foundations

This release implements configuration resolution, profile management,
preview-first VS Code import and maintained-runtime settings activation.
Four repository volumes, native authentication and container identity are retained.
See the [implementation roadmap](roadmap.md) for the activation and identity gates.

## Commands Available Now

```sh
vspod profile
vspod profile --json
vspod profile create default
vspod profile create work --from default
vspod profile switch work             # This repository, or global outside Git
vspod profile switch default --global
vspod config explain /path/to/repo
vspod config explain /path/to/repo --json
vspod config explain /path/to/repo --compatibility --json
vspod migrate /path/to/repo           # Read-only preview
vspod migrate /path/to/repo --write   # Create once; runtime activation stays gated
```

These commands require Node.js 22 or newer but do not require Docker or the desktop app.
Creating a profile never overwrites an existing file. Switching validates the
target profile before atomically updating the host selection. Global selection
is the fallback; a repository selection takes precedence and remains independent.
Repository selections use the existing canonical repository ID, not its name.
Names contain 1-64 lowercase letters, digits or hyphens and start with a letter
or digit. At most 1000 repository selections are supported.

The empty `default` profile exists virtually until explicitly created. An existing
but malformed or incomplete default profile is an error, not an empty fallback.
Use `profile create default` to materialize it before editing.

Selecting a profile changes host metadata, not a running editor. Changes apply
when a stopped runtime starts. Configuration inspection returns
`activation: "supported-settings"`; inspection itself does not mutate the runtime.

`open` resolves configuration under the repository operation lock, before warm
focus. A running backend with a different or incomplete applied configuration
returns `CONFIG_RESTART_REQUIRED`; finish terminal work, stop, then reopen. There
is no automatic running-container replacement. Containers using the older image
require an explicit `vspod upgrade`.

The maintained image redirects its folder configuration source to generated
`/vspod/config/workspace/settings.json`, preserving remote URI authority. The
build fails if the pinned editor adapter anchor changes. Resolved supported
settings are also projected into editor user settings for non-resource scopes.
Native `.vscode/settings.json` cannot independently override this source.
Unmanaged user settings and keybindings are retained where compatible; malformed
existing editor JSON produces an explicit failure, not a reset.

Use `vspod config compatibility on|off [directory]` to persist a host-local
repository compatibility preference. `config explain --compatibility` enables
compatibility for that inspection only. Compatibility is initially off.

`vspod trust [directory]` displays selected extensions, profile keybindings,
startup tasks and their exact configuration fingerprint before approval.
Noninteractive approval requires `vspod trust --yes`; `open --yes` is only
onboarding consent. Changed configuration invalidates approval.
`vspod trust --revoke` removes future authorization but cannot undo code already
executed. Stop the runtime to end its active workloads.

Approved startup commands run sequentially as UID/GID 1000 in `/workspace`, through
stdin to `/bin/sh -es`, with a ten-minute per-command timeout and cancellation.
Failures stop activation; the applied marker is not advanced. Stop and reopen to
retry. Warm opens, new windows and focus never rerun startup commands.
Required account declarations remain fail-closed with
`ACCOUNT_RUNTIME_UNSUPPORTED` until authenticated runtime credential transport
is implemented and verified. Host login is not a container grant.

`vspod open --restricted` starts with supported safe settings, an empty user
extension directory and fresh tmpfs user state. It skips profile keybindings,
startup tasks and all account requirements/access. Built-in editor features remain.
Changing between normal and restricted mode requires stop/reopen. Restricted mode
does not undo earlier hook effects or sandbox terminal commands beyond the
existing non-root container boundary.

## Host Identity

```sh
npm run identity:build
vspod login github
vspod login azure --client-id <registered-public-client-id> --tenant-id <tenant-id>
vspod login github --no-browser
vspod accounts
vspod accounts --json
vspod logout <account-id>
vspod logout --all
```

GitHub defaults to VSPod's public OAuth App client ID `Ov23liDC7oUEtbmsxOVh`;
users do not need to register their own GitHub application. To use a different
registration, `--client-id` takes precedence over `VSPOD_GITHUB_CLIENT_ID`, which
takes precedence over the shipped default. An empty environment override uses
the default; an explicitly empty flag is rejected.
Azure still requires a registered client ID and tenant via flags or
`VSPOD_AZURE_CLIENT_ID` and `VSPOD_AZURE_TENANT_ID`. No client secret is embedded.
These are public identifiers,
not tokens. Login requires an interactive terminal and displays the provider's
verification URL, short code and expiry before opening the system browser.
Enter that code on the provider page and approve only a login you just requested
in VSPod. Do not share the code. No code is copied to the clipboard or appended to
the browser URL. VSPod polls for completion; there is no redirect callback.

Use `--no-browser` to open the displayed URL yourself, including on another device.
If the browser cannot be opened, VSPod warns and continues waiting with the same
code and manual instructions. This does not enable unattended authorization:
login still requires an interactive terminal and does not start OAuth in CI.
Enable **Device Flow** in VSPod's GitHub OAuth App registration. The app form may
require a callback URL, but device flow does not use it. Azure tenant policies can
block device authorization; VSPod reports that failure rather than bypassing it
or silently changing login flows.

The Swift helper is built at
`apps/keychain-helper/build/vspod-keychain-helper`. It uses macOS Security.framework,
bounded stdin requests and Keychain service `com.vspod.identity`, not token-bearing
command arguments or environment variables. Provider access/refresh records stay
in Keychain; account metadata is separate under the configured host root at
`identity/accounts.json`. Metadata is private, not an exportable trust grant.
Locked/inaccessible secure storage fails explicitly; no plaintext fallback exists.

`@vspod/identity` implements fixed-endpoint device flows, sanitized errors and
single-flight refresh with secure-record rotation where supported. Mocked
provider/secure-store tests validate polling, errors and refresh without accessing
the user's Keychain. Live OAuth requires actual provider application registrations
and interactive acceptance; those flows are not claimed verified by mocked tests.

Logout removes local VSPod credentials and denies future host use. This flow
reports upstream revocation as unsupported: revoke the app authorization at the
provider if remote invalidation is required. Local deletion cannot invalidate
tokens already copied by other software.

The package also defines grant/broker/runtime binding abstractions. **There is no
enabled host/container relay or generic token endpoint.** Required runtime accounts
fail closed. Host login and broad repository trust never authorize token delivery.

## Layout And Package Boundaries

```text
packages/config/
  schemas/config-v1.schema.json   # JSON Schema 2020-12, repository root schema
  src/model.ts                   # Public TypeScript contracts
  src/validate.ts                # Version, schema and non-secret policy checks
  src/load.ts                    # Bounded YAML and JSONC readers
  src/merge.ts                   # Defaults, resolution and fingerprints
  src/migration.ts               # Deterministic validated import plan
  src/index.ts                   # Public exports
  src/config.test.ts

packages/core/src/
  profiles.ts                    # Private host profile and selection persistence
  configuration.ts               # Inspection and runtime activation gate
  migration.ts                   # Locked, atomic no-clobber publication
  profiles.test.ts
  configuration.test.ts

apps/cli/src/index.ts             # Profile, configuration and migration commands
```

`@vspod/config` has no runtime, core, Docker or identity dependency. It exports
the models, loaders, validators and resolver, as well as `@vspod/config/schema`.
Profile persistence currently lives in core to reuse its private-file helpers
without introducing a package dependency cycle. Extract a profiles package only
when another host application needs an independent persistence interface.

## Inputs

Profiles are stored outside repositories:

```yaml
# ~/Library/Application Support/VSPod/profiles/work/profile.yml
schemaVersion: 1
name: work
theme: one-dark
settings:
  editor.fontSize: 14
extensions:
  - github.copilot
  - eamodio.gitlens
keybindings:
  - key: cmd+shift+f
    command: workbench.action.findInFiles
```

Themes are literal editor theme identifiers. The engine does not infer a theme
extension from a shorthand name, install it, or guarantee its availability.
Keybinding `args` and arbitrary command payloads are not supported in v1.

Repository definitions are parsed and validated for inspection:

```yaml
# .vspod/vspod.yml
schemaVersion: 1
name: vet-frontend
extensions:
  required:
    - dbaeumer.vscode-eslint
    - ms-playwright.playwright
  optional:
    - github.copilot
settings:
  editor.tabSize: 2
  editor.formatOnSave: true
accounts:
  required:
    - github
  optional:
    - azure
tasks:
  startup:
    - npm install
```

Accounts are provider identifiers only. No account is logged in, selected or
authorized by a declaration. Startup tasks execute only after explicit trust.
Future provider identifiers can be represented without implying runtime support.

Missing `schemaVersion` is `CONFIG_VERSION_MISSING`; any value other than the
number `1` is `CONFIG_VERSION_UNSUPPORTED`. There is no implicit upgrade.

## Merge Rules

From lowest to highest precedence:

1. Shipped `DEFAULT_SETTINGS`.
2. The selected profile; explicit profile theme settings beat its `theme` shorthand.
3. Explicitly enabled `.vscode` compatibility inputs.
4. Repository definition.

Each flattened editor setting key replaces its previous value in full. Arrays
replace; objects are not recursively merged. `null` is a value where allowed by
the schema, never an instruction to delete a setting. Inputs are not mutated.
The result includes setting-level source provenance and a SHA-256 fingerprint
of canonical normalized output. A fingerprint is a change detector, **not**
a signature or a trust grant.

The shipped defaults are tab size 4, spaces, format-on-save off,
autosave off and terminal scrollback 1000. They apply on maintained-runtime start.
Runtime security defaults stay in the host/runtime policy,
not in repository-overridable editor settings.

Compatibility is disabled by default. `config compatibility` persists the
repository preference; `config explain --compatibility` overrides inspection only.
Settings and extension recommendations accept JSONC comments/trailing commas.
An enabled malformed compatibility input fails rather than being ignored.

The maintained folder configuration adapter reads the generated source rather
than native `.vscode` settings/tasks/launch/MCP files. This release does not import
those executable compatibility surfaces. Extension recommendations are input to
VSPod's explicit selection flow, not authorization for automatic installation.

### Extension Intent

IDs are lowercase `publisher.name`, optionally followed by an exact version
such as `publisher.name@1.2.3`. Version ranges are not accepted.

- Profile extensions are selected desired extensions.
- Repository-required extensions are selected and required.
- Repository-optional extensions and compatibility recommendations are unselected.
- Required declarations cannot be removed by another layer.
- Two different explicit versions for an ID produce `EXTENSION_VERSION_CONFLICT`.
- An unversioned declaration can coexist with one explicit version.
- Compatibility `unwantedRecommendations` suppress compatibility recommendations
  by extension ID across pinned versions, never profile or required repository declarations.
- The engine records intent and sources; it does not resolve marketplace versions,
  download, install, cache or update extensions.

Required account declarations win over optional declarations. Provider lists and
extension intents are deduplicated and sorted for deterministic output.

## Validation And Diagnostics

The [schema](../packages/config/schemas/config-v1.schema.json) is authoritative for
the initial supported setting subset: indentation, formatting-on-save, fonts,
wrapping, rulers, minimap, whitespace, autosave, line endings, theme, terminal
font and scrollback. Unknown settings are rejected, including extension settings
and settings capable of injecting environment variables or disabling trust.
Expanding this allowlist requires tests and a policy decision.

Limits include 256 KiB per input, nesting depth 32, 256 extension/keybinding
entries and 32 startup commands of at most 4096 characters each. YAML duplicate
keys, alias expansion, unresolved/custom tags and non-JSON values are rejected.
JSONC duplicate keys are also rejected. File readers check containment within
the supplied root, reject escaping/dangling file symlinks, require regular files
and bound actual reads, not only reported file size.

Explicit credential fields and common GitHub-token/PEM material are rejected.
**This is defense in depth, not proof arbitrary text contains no secret.**
Never put credentials in any input, including task commands or setting strings.
No interpolation, includes, environment expansion or secret expansion is supported.

Errors contain stable reference codes and source locations when available;
parser source snippets and rejected values are not echoed. Common codes:

| Code | Recovery |
| --- | --- |
| `CONFIG_PARSE` | Correct YAML/JSONC syntax or duplicate keys. |
| `CONFIG_VERSION_MISSING` | Add `schemaVersion: 1` after checking the schema. |
| `CONFIG_VERSION_UNSUPPORTED` | Use a supported schema/application version. |
| `CONFIG_SCHEMA` / `CONFIG_POLICY_DENIED` | Use only supported fields/settings. |
| `CONFIG_SECRET_FORBIDDEN` | Remove credentials; rotate any exposed credential. |
| `CONFIG_LIMIT` | Reduce input size, nesting or collection counts. |
| `CONFIG_PATH_UNSAFE` | Keep configuration files inside their owning root. |
| `PROFILE_PATH_UNSAFE` | Restore private, owner-owned real files/directories. |
| `PROFILE_STATE_INVALID` | Repair/restore selection metadata; no automatic reset. |
| `CONFIG_RESTART_REQUIRED` | Stop and reopen to apply changed desired configuration. |
| `CONFIG_TRUST_REQUIRED` | Review and approve the executable snapshot using `vspod trust`. |
| `ACCOUNT_RUNTIME_UNSUPPORTED` | Runtime credential transport is not enabled. |

## Import Existing VS Code Configuration

```sh
vspod migrate [directory]                              # Preview only
vspod migrate [directory] --json                       # Structured preview
vspod migrate [directory] --recommendations-as-required # Explicit promotion
vspod migrate [directory] --write                      # Publish once
```

The directory may be a repository subfolder; import always uses the canonical
repository root. These commands do not require Docker, the desktop app, a profile
selection or account login. Preview creates no directories, host state or files.
It reads only `.vscode/settings.json` and `.vscode/extensions.json`, using the
same bounded readers and validation as configuration inspection.

For example:

```jsonc
// .vscode/settings.json
{
  "editor.tabSize": 2,
  "editor.formatOnSave": true,
}
```

```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "ms-playwright.playwright"
  ]
}
```

Produces:

```yaml
schemaVersion: 1
settings:
  editor.formatOnSave: true
  editor.tabSize: 2
extensions:
  optional:
    - dbaeumer.vscode-eslint
    - ms-playwright.playwright
```

Only explicitly declared settings are imported, not shipped defaults or user
profile values. Settings and extension lists are sorted for deterministic output.
Recommendations become optional unless `--recommendations-as-required` is passed.
`unwantedRecommendations` exclude matching extension IDs (including pinned
versions) during import. A `MIGRATION_IMPORT_EXCLUSIONS` notice explains that
these negative rules are **not preserved** in the generated definition; the
original source remains intact.

Unsupported settings/fields, invalid values, duplicate keys, detected credentials,
conflicting extension versions and unsafe sources fail the **whole** import.
There is no partial YAML output or silent omission of unsupported fields. Both
absent inputs produce `MIGRATION_NO_INPUT`; inputs with no settings or remaining
recommendations produce `MIGRATION_EMPTY_INPUT`. Comments and source formatting
are not copied. No tasks, debugging configuration, keybindings, accounts, hooks,
grants or arbitrary other `.vscode` files are inferred or imported.

`--write` builds a fresh plan, obtains the existing repository operation lock and
revalidates it. An in-progress open/upgrade/migration excludes another writer.
The writer compares SHA-256 snapshots of both source files, including their
absence and original bytes, before publishing. Any observed change invalidates
the plan with `MIGRATION_INPUT_CHANGED` (invalid new input can instead return its
configuration validation error). A separate preview invocation is not a saved
approval: rerunning with `--write` imports the inputs present in that invocation.

The destination is always `.vspod/vspod.yml`. A symlinked `.vspod` directory is
rejected even when it points inside the repository. Any existing destination,
including a dangling symlink or directory, produces `MIGRATION_DESTINATION_EXISTS`
in preview and write mode. There is no overwrite, force or implicit merge option.

Publication uses an exclusive 0600 staging file, file synchronization and an
atomic no-clobber hard link. Existing source files and destination content are
never rewritten. A newly created directory is 0700. Ordinary failures remove
staging files and remove a newly created directory only if it remains empty.
Existing directory contents are preserved. Cleanup failures are reported through
`MIGRATION_CLEANUP`, explicitly stating whether the definition was published.
SIGKILL/power loss can leave a named `.migration-*.pending` file; inspect it
manually, and never mistake it for a live operation or delete unrelated data.
This is not a transaction against a hostile concurrent same-user filesystem actor.

`--json` returns one structured result with `status: "preview"` or `"written"`,
the definition/YAML, source digests and notices. Migration operational failures
return `status: "error"` with sanitized `error.code`, `error.message` and
`error.hint`, exiting with code 1 and no generated YAML. CLI usage errors retain
Commander's normal behavior.

**Writing does not activate the definition.** Subsequent `open` resolves it and
requires trust for executable content and a restart for changed running settings.
Migration reports `activation: "not-activated"`. No token/state migration,
extension installation or credential access occurs during import.

## Managed Extensions

```sh
vspod trust                       # Review executable configuration first
vspod stop
vspod extensions sync             # Keep existing managed pins; review new artifacts
vspod extensions sync --include-optional
vspod extensions sync --exclude-optional
vspod extensions update           # Explicitly re-resolve unversioned managed choices
vspod extensions sync --approve   # Explicit unattended artifact approval
vspod open
```

Profile extensions and repository-required extensions are selected automatically;
repository optional extensions are not installed unless explicitly selected.
Optional selection is host-local and retained across syncs, not committed to the
repository. Required intent wins optional intent; incompatible exact pins fail
configuration validation. `extensions sync` does not silently advance a managed
pin. `extensions update` can advance unversioned choices but still requires new
artifact approval; exact version requests remain exact.

Reconciliation requires a stopped workspace. Artifacts are resolved from fixed
Open VSX endpoints, bounded, inspected for embedded identity/version/engine and
platform metadata, and cached immutably by SHA-256. Explicitly platform-specific
VSIX files are rejected for now. Approval identifies the exact extension/version/
digest, not merely a mutable extension ID. `--approve` is an explicit host action
to accept all exact artifacts printed by that invocation; omit it for interactive
review. Without approval, required artifacts fail and optional ones stay uninstalled.
SHA-256 detects changes; it is not publisher authentication or a malware scan.
Metadata redirects are denied. Artifact downloads permit only one HTTPS redirect
to `openvsx.eclipsecontent.org` with the exact requested artifact path; other hosts,
credentials/query/fragment additions and chained redirects are rejected.

The Docker installer mounts only the repository's extensions volume and one
read-only cached VSIX. It runs the maintained editor CLI as UID 1000 with no
network, no repository/host identity mounts, dropped capabilities, read-only root
and bounded tmpfs scratch. It never starts the workspace or runs startup tasks.
Installed extension state remains repository-specific; artifacts can be reused
across repositories. Manually installed extensions are preserved, and a conflicting
same-ID version is not silently taken over.

`open` verifies the reconciled extension intent and exact required installed
versions before reusing a window. Missing/drifted required extensions fail
explicitly; missing optional extensions are not a required-account-style gate.
Editor automatic extension updates are disabled. Updating a managed extension
requires explicit stop/update/open. A partial failed sync is retryable, but it is
not transactional whole-volume rollback. Pins record successful individual changes.
Do not delete extension-cache entries or edit manifests during an operation.

Copilot is not available from the checked Open VSX endpoint; no marketplace
fallback, licensing bypass or Copilot entitlement is implemented. Registry metadata
and mocked tests do not certify every extension. See the roadmap for the current
ESLint, Playwright and GitLens compatibility findings.

## Persistence

| Location | Data | Portability |
| --- | --- | --- |
| `~/Library/Application Support/VSPod/profiles/<name>/profile.yml` | Validated profiles | Portable, non-secret |
| `~/Library/Application Support/VSPod/profile-selections.json` | Default and repository profile selections | Machine-specific, non-secret |
| `.vspod/vspod.yml` | Repository definition | Portable, non-secret |
| `<configuration root>/trust/<workspace-id>.json` | Exact executable-configuration grants | Machine-specific, non-secret |
| `<configuration root>/workspace-preferences/<workspace-id>.json` | Compatibility preference | Machine-specific, non-secret |
| `<configuration root>/identity/accounts.json` | Account identifiers and public provider configuration | Machine-specific, private non-secret |
| macOS Keychain, `com.vspod.identity` | Provider access and refresh credentials | Machine-specific secrets |
| `<configuration root>/cache/extensions/artifacts/<sha256>.vsix` | Immutable extension downloads | Disposable machine cache |
| Existing `~/Library/Application Support/VSPod/spike` | Live sessions, locks and history | Unchanged, machine-specific |
| `<state root>/<workspace-id>/{configuration,extensions-applied,managed-extensions}.json` | Applied snapshots and managed extension pins | Machine-specific, non-secret |
| Existing four Docker volumes | Repository editor state | Unchanged, machine-specific |

Profiles and metadata require owner-only directories/files (0700/0600), not
symlinks. Profile create uses atomic no-clobber publication; selection writes use
atomic replacement under a heartbeat lock. Reads do not take exclusive locks.
Do not edit profiles while a create/copy operation is in progress.

`VSPOD_CONFIG_DIR` overrides the host configuration root. When only
`VSPOD_STATE_DIR` is set, configuration is isolated beneath its `configuration`
subdirectory, preventing test runs from reading/writing real user profiles.
No existing state, runtime IDs or volumes are moved.

Provider registrations require externally registered public-client IDs. Runtime
credential injection and legacy runtime-state migration remain gated, not
implemented storage surfaces. Logs remain the existing Docker-backed `vspod logs`
surface; no token-bearing provider request log is added. Broker grants can be
persisted separately by the identity package, but no runtime grants CLI/relay is
enabled. Repository import writes only `.vspod/vspod.yml` and existing host
operation-lock metadata.
