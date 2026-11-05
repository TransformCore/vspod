#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHostIdentity, IdentityError, MacKeychainSecureStore } from '@vspod/identity';
import { Command, Option } from 'commander';
import * as prompt from '@clack/prompts';
import { CodeServerBackend, DesktopBackend, presentNative } from '@vspod/editor-backends';
import { openWorkspace, stopWorkspace, recentFolders, restorableFolders,
  completeOnboarding, readCatalog, explainError, VspodError, upgradeWorkspace, closeWindows,
  configurationDirectory, createProfile, listProfiles, selectedProfile, switchProfile, inspectConfiguration,
  migrateWorkspace, syncWorkspaceExtensions } from '@vspod/core';
import { trustConfiguration, revokeConfigurationTrust, setCompatibility } from '@vspod/core';
import type { EditorBackend, OpenOptions, StartupProgress } from '@vspod/core';
import { execute } from '@vspod/core/process';
import { desktopBinary, installationRoot } from '@vspod/core/installation';
import { resolveWorkspace } from '@vspod/workspace';
import { deviceChallengePresenter, loginClientId } from './device-login.ts';

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
const program = new Command().name('vspod').version('0.1.0').description('Your repository. Your environment. One native window.');
program.addOption(new Option('--backend <backend>', 'Host-owned editor choice (or VSPOD_EDITOR_BACKEND); default code-server')
  .choices(['code-server', 'desktop']));
function selectedBackend(fallback = 'code-server'): EditorBackend {
  const choice = program.opts<{ backend?: string }>().backend ?? process.env.VSPOD_EDITOR_BACKEND ?? fallback;
  if (choice === 'code-server') return new CodeServerBackend();
  if (choice === 'desktop') return new DesktopBackend();
  throw new VspodError('BACKEND_UNSUPPORTED', `Unknown editor backend: ${choice}`, 'Choose code-server or desktop. No fallback was started.');
}
program.command('__present-native', { hidden: true }).argument('<directory>')
  .action(async (directory: string) => { await presentNative(directory); });
const info = (message: string) => interactive ? prompt.log.info(message) : console.log(message);

const extensions = program.command('extensions').description('Reconcile approved extensions while the workspace is stopped');
for (const name of ['sync', 'update'] as const) {
  extensions.command(name).argument('[directory]', 'Repository directory', '.')
    .option('--approve', 'Explicitly approve the exact resolved artifacts reported by this operation')
    .option('--include-optional', 'Select all repository optional extensions as well')
    .option('--exclude-optional', 'Clear the previous selection of repository optional extensions')
    .action(async (directory: string, options: { approve?: boolean; includeOptional?: boolean; excludeOptional?: boolean }) => {
      if (options.includeOptional && options.excludeOptional) throw new VspodError('EXTENSIONS_USAGE', 'Choose include or exclude optional extensions, not both.', 'Use vspod extensions sync --help.');
      const workspace = await resolveWorkspace(directory);
      const backend = selectedBackend();
      const outcomes = await syncWorkspaceExtensions(backend, workspace, {
        refresh: name === 'update',
        includeOptional: options.includeOptional ? true : options.excludeOptional ? false : undefined,
        approveArtifacts: async (artifacts) => {
          for (const artifact of artifacts) info(`Review executable artifact: ${artifact.id}@${artifact.version} sha256:${artifact.sha256}${artifact.required ? ' (required)' : ''}`);
          const approved = options.approve || (interactive && cancelled(await prompt.confirm({
            message: 'Install these exact executable artifacts into this repository’s extension volume?', initialValue: false,
          })));
          return approved ? artifacts.map(({ id, version, sha256 }) => ({ id, version, sha256 })) : [];
        },
      });
      for (const outcome of outcomes) info(`${outcome.id}${outcome.version ? `@${outcome.version}` : ''}: ${outcome.status}${outcome.message ? ` — ${outcome.message}` : ''}`);
      info('No running editor was changed. Open the workspace after reviewing these results.');
    });
}

const keychainHelper = () => join(installationRoot(), 'apps/keychain-helper/build/vspod-keychain-helper');
const identityService = () => createHostIdentity({
  secureStore: new MacKeychainSecureStore(keychainHelper()),
  rootDirectory: configurationDirectory(),
});

program.command('login').argument('<provider>', 'github or azure')
  .option('--client-id <id>', 'Override the public OAuth application client ID (GitHub defaults to VSPod)')
  .option('--tenant-id <tenant>', 'Azure tenant ID')
  .option('--no-browser', 'Display the device code and URL without opening the system browser')
  .action(async (provider: string, options: { clientId?: string; tenantId?: string; browser: boolean }) => {
    if (provider !== 'github' && provider !== 'azure') {
      throw new VspodError('ACCOUNT_PROVIDER_UNSUPPORTED', 'Only GitHub and Azure login are supported.', 'Use vspod login github|azure.');
    }
    const clientId = loginClientId(provider, options.clientId, process.env);
    const tenantId = options.tenantId ?? process.env.VSPOD_AZURE_TENANT_ID;
    if (!clientId || (provider === 'azure' && !tenantId)) {
      throw new VspodError('ACCOUNT_CLIENT_CONFIGURATION', 'Public-client registration is required before login.',
        'Pass --client-id (and --tenant-id for Azure), or configure VSPOD_GITHUB_CLIENT_ID / VSPOD_AZURE_CLIENT_ID / VSPOD_AZURE_TENANT_ID. Client IDs are public identifiers, not OAuth secrets.');
    }
    if (!interactive) throw new VspodError('ACCOUNT_INTERACTIVE_REQUIRED', 'Device login requires an interactive terminal.', 'Run vspod login in a terminal. No browser or authorization flow was started.');
    try { await access(keychainHelper()); } catch {
      throw new VspodError('KEYCHAIN_HELPER_MISSING', 'The native Keychain helper is not built.', 'Run npm run identity:build on macOS, then retry login.');
    }
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      const account = await identityService().login(provider, {
        clientId, ...(provider === 'azure' ? { tenantId } : {}),
        signal: cancellation.signal,
        onDeviceChallenge: deviceChallengePresenter(provider, {
          browser: options.browser, signal: cancellation.signal, info,
          warn: (message) => interactive ? prompt.log.warn(message) : console.error(message),
        }),
      });
      info(`Signed in: ${account.metadata.id} (${account.metadata.provider}). Credentials are in Keychain; no repository or container grant was created.`);
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  });

program.command('accounts').description('List host identity metadata; never display tokens')
  .option('--json', 'Output account metadata as JSON')
  .action(async (options: { json?: boolean }) => {
    const accounts = await identityService().list();
    if (options.json) { console.log(JSON.stringify(accounts, null, 2)); return; }
    if (!accounts.length) { info('No accounts connected. Use vspod login github, or vspod login azure with your public-client registration.'); return; }
    for (const { metadata } of accounts) console.log(`${metadata.id}  ${metadata.provider}  ${metadata.displayName ?? metadata.subject}`);
  });

program.command('logout').argument('[account]', 'Account ID shown by vspod accounts')
  .option('--all', 'Explicitly remove every VSPod account from this host')
  .action(async (account: string | undefined, options: { all?: boolean }) => {
    if (account && options.all) throw new VspodError('ACCOUNT_USAGE', 'Choose an account ID or --all, not both.', 'Use vspod accounts to inspect account IDs.');
    const service = identityService();
    const accounts = await service.list();
    if (!accounts.length) { info('No VSPod accounts are connected.'); return; }
    let ids: string[];
    if (options.all) ids = accounts.map(({ metadata }) => metadata.id);
    else if (account) {
      if (!accounts.some(({ metadata }) => metadata.id === account)) throw new VspodError('ACCOUNT_NOT_FOUND', 'Account ID was not found.', 'Use vspod accounts, then vspod logout <account-id>.');
      ids = [account];
    } else {
      if (!interactive) throw new VspodError('ACCOUNT_SELECTION_REQUIRED', 'Select an account explicitly.', 'Use vspod logout <account-id>, or --all.');
      ids = [cancelled(await prompt.select({
        message: 'Remove which VSPod account?',
        options: accounts.map(({ metadata }) => ({ value: metadata.id, label: `${metadata.provider}: ${metadata.displayName ?? metadata.subject}` })),
      }))];
    }
    for (const id of ids) await service.logout(id);
    info('Local credentials and future VSPod access removed. Upstream revocation is not supported by this flow: revoke authorization with the provider if needed. Copies already exposed to other processes cannot be erased.');
  });

async function currentWorkspace() {
  try { return await resolveWorkspace('.'); } catch (error) {
    if (explainError(error).code === 'NOT_A_REPOSITORY') return undefined;
    throw error;
  }
}

const profile = program.command('profile').description('Manage host profiles; changes apply on the next stopped-runtime start')
  .option('--json', 'Output structured JSON')
  .action(async (options: { json?: boolean }) => {
    const workspace = await currentWorkspace();
    const [names, selection] = await Promise.all([listProfiles(), selectedProfile(workspace?.id)]);
    const result = {
      profiles: names, selected: selection.name, scope: selection.scope,
      directory: configurationDirectory(), activation: 'supported-settings',
    };
    if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
    for (const name of names) console.log(`${name === selection.name ? '*' : ' '} ${name}`);
    info(`Selected ${selection.name} (${selection.scope}). Stop and reopen an active editor to apply changed settings.`);
  });

profile.command('create').argument('<name>', 'Lowercase profile name')
  .option('--from <profile>', 'Copy an existing profile')
  .action(async (name: string, options: { from?: string }) => {
    await createProfile(name, options.from);
    info(`Created profile ${name}. Edit ${configurationDirectory()}/profiles/${name}/profile.yml; keep it private and credential-free.`);
  });

profile.command('switch').argument('<name>', 'Existing profile')
  .option('--global', 'Change the default instead of the current repository selection')
  .action(async (name: string, options: { global?: boolean }) => {
    const workspace = options.global ? undefined : await currentWorkspace();
    await switchProfile(name, workspace?.id);
    info(`Selected ${name} for ${workspace ? 'this repository' : 'the global default'}. No running editor was modified. Stop and reopen to apply; use vspod config explain to review.`);
  });

const configCommand = program.command('config').description('Manage host configuration preferences');
configCommand.command('explain').argument('[directory]', 'Git repository', '.')
  .option('--compatibility', 'Explicitly include supported .vscode settings and recommendations in this preview')
  .option('--json', 'Output structured JSON')
  .action(async (directory: string, options: { compatibility?: boolean; json?: boolean }) => {
    const result = await inspectConfiguration(await resolveWorkspace(directory), options.compatibility);
    if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
    info(`Resolved configuration · profile ${result.profile.name} (${result.profile.scope})`);
    info(`VS Code compatibility inputs: ${result.compatibility ? 'enabled' : 'disabled'}`);
    for (const [key, value] of Object.entries(result.resolved.settings)) {
      console.log(`${key}: ${JSON.stringify(value)} [${result.resolved.provenance[key]}]`);
    }
    console.log(JSON.stringify({
      extensions: result.resolved.extensions, accounts: result.resolved.accounts,
      keybindings: result.resolved.keybindings, startupTasks: result.resolved.startupTasks,
      fingerprint: result.resolved.fingerprint,
    }, null, 2));
    info('No settings, extensions, hooks or account access were activated.');
  });

configCommand.command('compatibility').argument('<mode>', 'on or off')
  .argument('[directory]', 'Git repository', '.')
  .action(async (mode: string, directory: string) => {
    if (!['on', 'off'].includes(mode)) throw new VspodError('CONFIG_USAGE', 'Compatibility must be on or off.', 'Use vspod config compatibility on|off [directory].');
    await setCompatibility(await resolveWorkspace(directory), mode === 'on');
    info(`Compatibility ${mode} for this canonical repository. Stop and reopen an active editor to apply changed settings.`);
  });
program.command('migrate').description('Preview an import of supported .vscode inputs; never overwrite a definition')
  .argument('[directory]', 'Git repository', '.')
  .option('--write', 'Publish the validated definition; does not activate runtime configuration')
  .option('--recommendations-as-required', 'Explicitly promote recommended extensions to required')
  .option('--json', 'Output structured JSON, including structured errors')
  .action(async (directory: string, options: { write?: boolean; recommendationsAsRequired?: boolean; json?: boolean }) => {
    try {
      const result = await migrateWorkspace(await resolveWorkspace(directory), options);
      if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
      info(`${result.status === 'written' ? 'Created' : 'Preview for'} ${result.destination}`);
      for (const notice of result.notices) info(`${notice.code}: ${notice.message}`);
      console.log(result.yaml);
      if (result.status === 'preview') info('Nothing changed. Review the YAML, then pass --write to create the definition.');
      info('Migration never activates a runtime. Review configuration and executable trust before opening; no account access is granted.');
    } catch (error) {
      if (!options.json) throw error;
      const failure = explainError(error);
      console.log(JSON.stringify({ status: 'error', error: { code: failure.code, message: failure.title, hint: failure.hint } }, null, 2));
      process.exitCode = 1;
    }
  });

program.command('trust').description('Review and explicitly approve executable configuration for this canonical repository')
  .argument('[directory]', 'Git repository', '.')
  .option('--yes', 'Approve the displayed snapshot without an interactive prompt')
  .option('--revoke', 'Revoke future activation; does not undo already executed code')
  .action(async (directory: string, options: { yes?: boolean; revoke?: boolean }) => {
    const workspace = await resolveWorkspace(directory);
    if (options.revoke) {
      await revokeConfigurationTrust(workspace);
      info('Trust revoked for future activation. Stop the workspace to end already running code; revocation cannot undo previous commands.');
      return;
    }
    const snapshot = (await inspectConfiguration(workspace)).resolved;
    console.log(JSON.stringify({
      workspace: workspace.root, fingerprint: snapshot.fingerprint,
      extensions: snapshot.extensions.filter((extension) => extension.selected),
      keybindings: snapshot.keybindings, startupTasks: snapshot.startupTasks,
    }, null, 2));
    const consent = options.yes || (interactive && cancelled(await prompt.confirm({
      message: 'Trust this repository and these executable settings? Approved commands can execute repository code. This does not grant account access.',
      initialValue: false,
    })));
    if (!consent) throw new VspodError('CONFIG_TRUST_REQUIRED', 'No trust grant was saved.', 'Review vspod trust interactively, or explicitly approve this snapshot with vspod trust --yes.');
    await trustConfiguration(workspace, snapshot);
    info('Trust saved for this exact configuration snapshot. Changes require renewed approval.');
  });

function cancelled<T>(value: T | symbol): T {
  if (prompt.isCancel(value)) throw new VspodError('CANCELLED', 'Nothing changed.', 'Open a folder whenever you are ready with vspod open <path>.');
  return value as T;
}

async function welcome(yes = false): Promise<void> {
  if ((await readCatalog()).onboardingComplete) return;
  const message = 'Only your repository is shared with the environment. Your home, SSH keys and host extensions stay on your Mac.';
  if (interactive) {
    prompt.intro('Welcome to VSPod');
    prompt.note(message, 'A workspace of its own');
    if (!yes && !cancelled(await prompt.confirm({ message: 'Open your repository in an isolated workspace?', initialValue: true }))) {
      throw new VspodError('CANCELLED', 'Your workspace has not been started.', 'Run vspod open when you are ready.');
    }
  } else info(`Welcome to VSPod. ${message}`);
  await completeOnboarding();
}

async function chooseFolder(directory?: string, recent = false): Promise<{ folder: string; backend?: string }> {
  if (directory && !recent) return { folder: directory };
  if (!recent) {
    try { await resolveWorkspace('.'); return { folder: '.' }; } catch (error) {
      if (explainError(error).code !== 'NOT_A_REPOSITORY') throw error;
    }
  }
  const entries = await recentFolders();
  if (!entries.length) throw new VspodError('NO_RECENT_FOLDERS', 'No remembered folders yet.', 'Run vspod open /path/to/your/git/repository to open your first workspace.');
  if (!interactive) return { folder: entries[0].folder, backend: entries[0].backend };
  const index = cancelled(await prompt.select({
    message: 'Where would you like to pick up?',
    options: entries.map((entry, value) => ({ value, label: `${entry.name} (${entry.backend ?? 'code-server'})`, hint: entry.folder })),
  }));
  return { folder: entries[index].folder, backend: entries[index].backend };
}

async function openFolder(directory: string, options: OpenOptions = {}, backendId?: string): Promise<void> {
  const backend = selectedBackend(backendId);
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const busy = interactive ? prompt.spinner() : undefined;
  let running = false;
  let lastStep = -1;
  const progress = (event: StartupProgress) => {
    const text = `${event.title}  ${event.detail}`;
    if (busy) {
      if (event.state === 'done') { busy.stop(text); running = false; }
      else if (!running) { busy.start(text); running = true; }
      else busy.message(text);
    } else if (event.step !== lastStep || event.state === 'done') console.log(`${event.title} · ${event.detail}`);
    lastStep = event.step;
  };
  try { await openWorkspace(backend, directory, { ...options, onProgress: progress, signal: cancellation.signal }); }
  finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (running) busy?.stop('Startup interrupted');
  }
}

program.command('open').argument('[directory]', 'Repository folder; defaults to current or recent')
  .option('--recent', 'Choose from remembered folders')
  .option('-n, --new-window', 'Open a separate window instead of focusing an existing one')
  .option('-y, --yes', 'Accept first-run onboarding without a prompt')
  .option('--smoke', 'Verify native editor startup, then close only the new window')
  .option('--restricted', 'Use safe settings with no user extensions, profile keybindings, startup hooks or account access; requires a stopped runtime when changing mode')
  .action(async (directory: string | undefined, options: OpenOptions & { recent?: boolean; yes?: boolean }) => {
    const choice = await chooseFolder(directory, options.recent);
    await welcome(options.yes);
    await openFolder(choice.folder, options, choice.backend);
  });

program.command('recent').description('List remembered folders').option('--json', 'Output structured JSON')
  .action(async (options: { json?: boolean }) => {
    const entries = await recentFolders();
    if (options.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (!entries.length) { info('No recent folders yet. Open a repository with vspod open <path>.'); return; }
    for (const [index, entry] of entries.entries()) console.log(`${index + 1}. ${entry.name} (${entry.backend ?? 'code-server'})\n   ${entry.folder}`);
  });

program.command('reopen').description('Reopen the most recently used folder').option('-n, --new-window', 'Always create a new window')
  .action(async (options: OpenOptions) => {
    const entries = await recentFolders();
    if (!entries.length) throw new VspodError('NO_RECENT_FOLDERS', 'There is nothing to reopen yet.', 'Open your first repository with vspod open <path>.');
    await welcome();
    await openFolder(entries[0].folder, options, entries[0].backend);
  });

program.command('restore').description('Reopen the folders from your last active windows')
  .action(async () => {
    const entries = await restorableFolders();
    if (!entries.length) { info('No windows to restore. Use vspod reopen to open your most recent folder.'); return; }
    await welcome();
    let restored = 0;
    for (const entry of entries.slice(0, 8)) {
      try { await openFolder(entry.folder, {}, entry.backend); restored++; }
      catch (error) {
        if (error instanceof VspodError && error.code === 'OPEN_CANCELLED') throw error;
        const result = explainError(error); console.error(`${entry.name}: ${result.title}\n  ${result.hint}`); process.exitCode = 1;
      }
    }
    info(`Restored ${restored} folder${restored === 1 ? '' : 's'}.`);
  });

program.command('quit').description('Remember and close VSPod windows, keeping environments warm')
  .action(async () => { const count = await closeWindows(); info(`Closed ${count} window${count === 1 ? '' : 's'}. Environments stay warm; use vspod restore to return.`); });

program.command('stop').argument('[directory]', 'Git repository', '.').action(async (directory: string) => {
  await stopWorkspace(selectedBackend(), directory);
  info('Workspace stopped. Your settings, extensions and files are retained.');
});
program.command('logs').argument('[directory]', 'Git repository', '.').option('-f, --follow', 'Stream editor logs').action(async (directory: string, options: { follow?: boolean }) => {
  const runtime = selectedBackend().runtime;
  await runtime.ensureAvailable();
  process.exitCode = await runtime.logs(await resolveWorkspace(directory), options.follow);
});
program.command('shell').argument('[directory]', 'Git repository', '.').action(async (directory: string) => {
  const runtime = selectedBackend().runtime;
  await runtime.ensureAvailable();
  process.exitCode = await runtime.exec(await resolveWorkspace(directory), ['/bin/bash'], true);
});
async function checkInstallation(directory?: string): Promise<boolean> {
  const backend = selectedBackend();
  const runtime = backend.runtime;
  let healthy = true;
  const checks: [string, () => Promise<unknown>][] = [
    ['Node.js 22+', async () => { if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Found ${process.version}; select Node.js 22 or newer.`); }],
    ['npm', () => execute('npm', ['--version'])],
    ['Git', () => execute('git', ['--version'])],
    ['Local Docker', () => runtime.ensureAvailable()],
    ['Desktop', () => backend.nativePresenter ? backend.nativePresenter.check() : access(desktopBinary())],
  ];
  for (const [name, check] of checks) {
    try { await check(); console.log(`OK    ${name}`); }
    catch (error) { const result = explainError(error); console.error(`NEEDS ATTENTION  ${name}: ${result.title}\n  ${result.hint}`); healthy = false; }
  }
  if (backend.diagnose) {
    let workspace;
    try { workspace = await resolveWorkspace(directory ?? '.'); } catch (error) {
      if (directory || explainError(error).code !== 'NOT_A_REPOSITORY') throw error;
    }
    if (workspace) {
      try {
        for (const result of await backend.diagnose(workspace)) {
          console.log(`${result.healthy ? 'OK' : 'NEEDS ATTENTION'}    ${result.name}: ${result.detail}`);
          if (!result.healthy) healthy = false;
        }
      } catch (error) { const result = explainError(error); console.error(`NEEDS ATTENTION  Workspace: ${result.title}\n  ${result.hint}`); healthy = false; }
    }
  }
  return healthy;
}

program.command('doctor').argument('[directory]', 'Inspect this repository as well as the installation').description('Check the local installation without changing it').action(async (directory?: string) => {
  if (!await checkInstallation(directory)) process.exitCode = 1;
});

program.command('setup').description('First-run checks and native app setup')
  .option('-y, --yes', 'Build the native app and start installed Docker Desktop without prompting')
  .option('--check', 'Only check prerequisites; do not make changes')
  .action(async (options: { yes?: boolean; check?: boolean }) => {
    const backend = selectedBackend();
    const runtime = backend.runtime;
    if (options.check) { if (!await checkInstallation()) process.exitCode = 1; return; }
    info('VSPod setup · Node.js 22+, Git, Docker Desktop and the native app');
    if (process.platform !== 'darwin') throw new VspodError('PLATFORM_UNSUPPORTED', 'This release supports macOS.', 'Run the native app on a Mac with Docker Desktop installed.');
    await execute('git', ['--version']);
    const consent = options.yes || (interactive && cancelled(await prompt.confirm({ message: 'Check Docker Desktop and build the native app if needed?', initialValue: true })));
    if (!consent) throw new VspodError('SETUP_CONSENT', 'Setup requires your confirmation.', 'Run vspod setup in an interactive terminal, or pass --yes.');
    await runtime.ensureAvailable(true);
    try { await (backend.nativePresenter ? backend.nativePresenter.check() : access(desktopBinary())); } catch {
      info('Building the native app. The first build may take a few minutes.');
      await execute('npm', ['--prefix', installationRoot(), 'run',
        ...(backend.nativePresenter ? ['build:host', '--workspace', '@vspod/app-runner'] : ['desktop:package'])],
      { inherit: true, timeout: 900_000 });
    }
    if (!await checkInstallation()) { process.exitCode = 1; return; }
    await completeOnboarding();
    info('You are ready. Open a Git repository with vspod open <path>.');
  });

program.command('upgrade').description('Upgrade this repository environment while retaining its volumes')
  .argument('[directory]', 'Git repository', '.')
  .option('-y, --yes', 'Confirm replacement without a prompt')
  .option('--rebuild', 'Rebuild the maintained image even when already current')
  .action(async (directory: string, options: { yes?: boolean; rebuild?: boolean }) => {
    const backend = selectedBackend();
    const runtime = backend.runtime;
    const workspace = await resolveWorkspace(directory);
    await runtime.ensureAvailable(true);
    const current = await runtime.inspect(workspace);
    if (current?.compatible !== false && current && !options.rebuild) { info('Your workspace environment is already up to date.'); return; }
    const consent = options.yes || (interactive && cancelled(await prompt.confirm({
      message: `Replace the environment for ${workspace.name}? Finish terminal jobs first. Your volumes are retained; they are not snapshotted.`, initialValue: false,
    })));
    if (!consent) throw new VspodError('UPGRADE_CONSENT', 'The environment was not changed.', 'Run vspod upgrade interactively, or pass --yes after finishing running jobs.');
    info('Preparing the update. The previous container is kept until the new editor is healthy.');
    if (await upgradeWorkspace(backend, directory, options.rebuild)) info('Environment updated. Run vspod open to reconnect your window.');
});

try { await program.parseAsync(); }
catch (error) {
  const result = error instanceof IdentityError ? { title: error.message, hint: error.hint, code: error.code } : explainError(error);
  if (interactive) { prompt.log.error(result.title); prompt.note(result.hint, 'Next step'); }
  else console.error(`VSPod · ${result.title}\n\n  ${result.hint}\n  Reference: ${result.code}`);
  process.exitCode = result.code === 'CANCELLED' ? 0 : result.code === 'OPEN_CANCELLED' ? 130 : 1;
}