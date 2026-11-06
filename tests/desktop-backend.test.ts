import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DesktopBackend, CodeServerBackend, desktopContainerName } from '@vspod/editor-backends';
import { openWorkspace, stopWorkspace, closeWindows, inspectConfiguration, trustConfiguration, recentFolders,
  createProfile, switchProfile } from '@vspod/core';
import { execute } from '@vspod/core/process';
import { readPrivate } from '@vspod/core/state';
import type { EditorSession } from '@vspod/core/backend';
import { installationRoot } from '@vspod/core/installation';
import { resolveWorkspace } from '@vspod/workspace';

async function waitFor<T>(read: () => Promise<T>, valid: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (valid(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

test('desktop opens a real repo with policy, native lifecycle, persistent state and no web credentials', {
  skip: process.env.VSPOD_DESKTOP_TEST !== '1', timeout: 240_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vspod-test-desktop-'));
  const repo = join(temporary, 'vspod-test-project');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const oldState = process.env.VSPOD_STATE_DIR, oldConfig = process.env.VSPOD_CONFIG_DIR;
  const oldBackend = process.env.VSPOD_EDITOR_BACKEND;
  const oldSeccomp = process.env.VSPOD_DESKTOP_SECCOMP;
  delete process.env.VSPOD_EDITOR_BACKEND;
  delete process.env.VSPOD_DESKTOP_SECCOMP;
  process.env.VSPOD_STATE_DIR = join(temporary, 'state');
  process.env.VSPOD_CONFIG_DIR = join(temporary, 'config');
  const workspace = await resolveWorkspace(repo);
  const backend = new DesktopBackend(), runtime = backend.runtime;
  const state = join(process.env.VSPOD_STATE_DIR, workspace.id);
  const name = desktopContainerName(workspace);
  try {
    await runtime.ensureAvailable();
    await runtime.ensureImage();
    await runtime.create(workspace);
    await mkdir(join(repo, '.vscode'));
    await mkdir(join(repo, '.vspod'));
    await mkdir(join(repo, 'subfolder'));
    await writeFile(join(repo, '.vscode/settings.json'), '{"editor.tabSize":9}');
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\nsettings:\n  editor.tabSize: 2\ntasks:\n  startup:\n    - printf x >> /workspace/startups.txt\n');
    await createProfile('desktop-profile');
    await writeFile(join(process.env.VSPOD_CONFIG_DIR, 'profiles/desktop-profile/profile.yml'),
      'schemaVersion: 1\nsettings:\n  editor.fontSize: 15\nkeybindings:\n  - key: ctrl+alt+p\n    command: workbench.action.showCommands\n', { mode: 0o600 });
    await switchProfile('desktop-profile', workspace.id);
    await trustConfiguration(workspace, (await inspectConfiguration(workspace)).resolved);
    const probe = String.raw`
const fs = require('fs'), vscode = require('vscode');
exports.activate = async () => {
  try {
    const record = () => {
      const folder = vscode.workspace.workspaceFolders[0].uri;
      fs.writeFileSync('/workspace/probe.json', JSON.stringify({
        uid: process.getuid(), folder: folder.fsPath,
        tabSize: vscode.workspace.getConfiguration('editor', folder).get('tabSize'),
      }));
    };
    record();
    vscode.workspace.onDidChangeWorkspaceFolders(record);
    const uri = vscode.Uri.file('/workspace/saved.txt');
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: true });
    edit.insert(uri, new vscode.Position(0, 0), 'saved through desktop VS Code');
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Editor rejected workspace edit');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await doc.save();
    const terminal = vscode.window.createTerminal({ name: 'Desktop probe', shellPath: '/bin/sh',
      shellArgs: ['-c', "printf desktop-terminal > /workspace/terminal.txt"] });
    terminal.show();
    fs.writeFileSync('/workspace/probe-ready.json', JSON.stringify({ folder: vscode.workspace.workspaceFolders[0].uri.fsPath }));
    let closing = false;
    setInterval(() => {
      const folder = vscode.workspace.workspaceFolders[0]?.uri.fsPath;
      const request = '/workspace/close-probe-window';
      if (!closing && fs.existsSync(request) && fs.readFileSync(request, 'utf8') === folder) {
        closing = true;
        fs.unlinkSync(request);
        vscode.commands.executeCommand('workbench.action.closeWindow');
      }
    }, 100);
  } catch (error) { fs.writeFileSync('/workspace/probe-error.txt', String(error)); }
};`;
    const manifest = { name: 'desktop-probe', publisher: 'vspod', version: '0.0.1',
      engines: { vscode: '^1.106.0' }, activationEvents: ['*'], main: './probe.cjs' };
    await execute('docker', ['run', '--rm', '--network', 'none', '--user', '1000:1000',
      '--mount', `type=volume,source=${name}-extensions,target=/extensions`,
      '--entrypoint', 'node', runtime.environment.image, '-e',
      `const fs=require('fs');const p='/extensions/vspod.desktop-probe-0.0.1';fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/package.json',${JSON.stringify(JSON.stringify(manifest))});fs.writeFileSync(p+'/probe.cjs',${JSON.stringify(probe)});`]);

    assert.ok(await openWorkspace(backend, repo));
    const probeText = await waitFor(() => optionalText(join(repo, 'probe.json')), Boolean, 'actual extension activation');
    assert.deepEqual(JSON.parse(probeText!), { uid: 1000, folder: '/workspace', tabSize: 2 });
    assert.equal(await optionalText(join(repo, 'probe-error.txt')), undefined);
    assert.equal(await waitFor(() => optionalText(join(repo, 'saved.txt')), Boolean, 'editor save'), 'saved through desktop VS Code');
    assert.equal(await waitFor(() => optionalText(join(repo, 'terminal.txt')), Boolean, 'integrated terminal'), 'desktop-terminal');
    await execute('docker', ['exec', name, 'node', '-e', `
const fs = require('fs'), crypto = require('crypto'), assert = require('assert/strict');
const root = '/opt/vscode/resources/app';
const product = JSON.parse(fs.readFileSync(root + '/product.json'));
assert.ok(Object.keys(product.checksums).length > 0, 'Installation integrity checking must remain enabled');
for (const [file, expected] of Object.entries(product.checksums)) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(root + '/out/' + file))
    .digest('base64').replace(/=+$/, '');
  assert.equal(actual, expected, 'Installation integrity mismatch: ' + file);
}
let logCount = 0;
function checkLogs(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) checkLogs(path);
    else if (entry.isFile() && entry.name.endsWith('.log')) {
      logCount++;
      assert.ok(!fs.readFileSync(path, 'utf8').includes('Installation has been modified on disk'),
        'VS Code reported a corrupt installation in ' + path);
    }
  }
}
checkLogs('/vspod/state/user-data/logs');
assert.ok(logCount > 0, 'Must inspect actual editor runtime logs');
`]);
    assert.equal(await optionalText(join(repo, 'startups.txt')), 'x');
    assert.deepEqual(JSON.parse(await execute('docker', ['exec', name, 'cat', '/vspod/settings/keybindings.json'])),
      [{ key: 'ctrl+alt+p', command: 'workbench.action.showCommands' }]);
    assert.equal(JSON.parse(await execute('docker', ['exec', name, 'cat', '/vspod/settings/settings.json']))['editor.fontSize'], 15);
    await execute('docker', ['exec', name, 'node', '-e',
      "require('fs').writeFileSync('/vspod/state/persistence','retained')"]);
    const first = await runtime.inspect(workspace);
    const session = await readPrivate<EditorSession>(join(state, 'desktop/runtime.json'));
    assert.equal(session?.presentation.kind, 'native');
    assert.ok(!JSON.stringify(session).includes('password'));
    assert.equal(await new CodeServerBackend().runtime.inspect(workspace), undefined, 'desktop never creates code-server containers');
    const [inspection] = JSON.parse(await execute('docker', ['inspect', name]));
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(inspection.HostConfig.PortBindings, {});
    assert.ok(inspection.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.ok(inspection.HostConfig.SecurityOpt.some((option: string) =>
      option.startsWith('seccomp=') && option.includes('"defaultAction":"SCMP_ACT_ERRNO"')),
    'Docker uses the bundled restrictive policy without an environment override');
    assert.equal(await openWorkspace(backend, repo), undefined, 'warm open focuses the existing native attachment');
    assert.equal((await readdir(state)).filter((entry) => entry.startsWith('launch-')).length, 1);
    assert.equal(await optionalText(join(repo, 'startups.txt')), 'x');
    const records = await recentFolders();
    assert.equal(records[0].backend, 'desktop');
    const launch = join(state, records[0].windows[0]);
    assert.match((await optionalText(join(launch, 'host.log'))) ?? '',
      /WINDOW_APP name=VSPod bundled=true icon=true identifier=dev\.vspod\.native-host/,
      'native presenter must launch the branded app bundle, not the generic executable');
    const bundledIcon = join(installationRoot(), 'packages/editor-backends/dist/VSPod.app/Contents/Resources/icon.icns');
    assert.deepEqual(await readFile(bundledIcon), await readFile(join(installationRoot(), 'apps/desktop/src-tauri/icons/icon.icns')),
      'desktop backend uses the same VSPod icon as Tauri');
    assert.equal((await readPrivate<{ stage: string }>(join(launch, 'ack.json')))?.stage, 'editor-ready');
    assert.equal(await closeWindows(), 1, 'quit waits for native host and container shutdown');
    assert.equal((await runtime.inspect(workspace))?.startedAt, first?.startedAt);
    assert.equal((await runtime.inspect(workspace))?.running, false);
    assert.equal(await readPrivate(join(state, 'desktop/runtime.json')), undefined);
    await rm(join(repo, 'probe-ready.json'), { force: true });
    assert.ok(await openWorkspace(backend, repo), 'reopen restarts the retained editor container');
    assert.notEqual((await runtime.inspect(workspace))?.startedAt, first?.startedAt);
    await waitFor(() => optionalText(join(repo, 'probe-ready.json')), Boolean, 'fixture editor save completes before folder switch');
    assert.equal(await openWorkspace(backend, join(repo, 'subfolder')), undefined, 'subfolder uses the same native host');
    await waitFor(() => optionalText(join(repo, 'probe.json')),
      (value) => !!value && JSON.parse(value).folder === '/workspace/subfolder', 'subfolder IPC');
    assert.equal(await openWorkspace(backend, repo, { newWindow: true }), undefined, 'new guest window uses the existing host');
    assert.equal((await readdir(state)).filter((entry) => entry.startsWith('launch-')).length, 2);
    const activeLaunch = join(state, (await recentFolders()).find((entry) => entry.backend === 'desktop')!.windows.at(-1)!);
    await waitFor(() => optionalText(join(activeLaunch, 'host.log')),
      (value) => (value?.match(/WINDOW_CREATED id=\d+ popup=false/g)?.length ?? 0) >= 2, 'second native guest window');

    await writeFile(join(repo, 'close-probe-window'), '/workspace/subfolder');
    await waitFor(() => optionalText(join(activeLaunch, 'host.log')),
      (value) => /WINDOW_DESTROYED id=\d+/.test(value ?? ''), 'one native window closes');
    assert.equal((await runtime.inspect(workspace))?.running, true, 'closing one of two native windows keeps the container running');
    await writeFile(join(repo, 'close-probe-window'), '/workspace');
    await waitFor(() => runtime.inspect(workspace), (instance) => instance?.running === false, 'last native window stops the container');
    await waitFor(() => readPrivate<{ stage: string }>(join(activeLaunch, 'lifetime-ack.json')),
      (value) => value?.stage === 'closed', 'native shutdown acknowledgement');
    assert.equal((await runtime.inspect(workspace))?.running, false);
    assert.equal(await readPrivate(join(state, 'desktop/runtime.json')), undefined);
    assert.ok(await openWorkspace(backend, repo, { smoke: true }));
    assert.equal(await execute('docker', ['exec', name, 'cat', '/vspod/state/persistence']), 'retained');
    assert.equal(await optionalText(join(repo, 'startups.txt')), 'xxx');
    assert.equal((await runtime.inspect(workspace))?.running, true, 'smoke detaches without stopping the guest');
    await stopWorkspace(backend, repo);
    await rm(join(repo, 'probe.json'), { force: true });
    await rm(join(repo, 'startups.txt'), { force: true });
    assert.ok(await openWorkspace(backend, repo, { restricted: true, smoke: true }));
    assert.equal(await optionalText(join(repo, 'probe.json')), undefined, 'restricted mode never loads persistent extensions');
    assert.equal(await optionalText(join(repo, 'startups.txt')), undefined, 'restricted mode never runs startup hooks');
    assert.equal((await runtime.inspect(workspace))?.running, true);
    await stopWorkspace(backend, repo);
    const cancellation = new AbortController();
    await assert.rejects(openWorkspace(backend, repo, {
      signal: cancellation.signal,
      onProgress: (progress) => { if (progress.step === 3) cancellation.abort(); },
    }), { code: 'OPEN_CANCELLED' });
    assert.equal((await runtime.inspect(workspace))?.running, false, 'cancelled cold startup stops only its guest');
    const definition = join(repo, '.vspod/vspod.yml');
    const originalDefinition = await readFile(definition, 'utf8');
    await writeFile(definition, 'schemaVersion: 1\naccounts:\n  required: [github]\n');
    await assert.rejects(openWorkspace(backend, repo), { code: 'ACCOUNT_RUNTIME_UNSUPPORTED' });
    assert.equal((await runtime.inspect(workspace))?.running, false, 'host login is not a desktop container grant');
    await writeFile(definition, originalDefinition);

    const cli = spawn(process.execPath, [join(installationRoot(), 'bin/vspod.mjs'), 'open', repo, '--backend', 'desktop', '--smoke', '--yes']);
    let output = '';
    cli.stdout.on('data', (data) => { output += data; });
    cli.stderr.on('data', (data) => { output += data; });
    const code = await new Promise<number | null>((resolve, reject) => {
      cli.once('error', reject); cli.once('exit', resolve);
    });
    assert.equal(code, 0, output);
    assert.equal((await runtime.inspect(workspace))?.running, true, 'actual CLI selects desktop');
    await stopWorkspace(backend, repo);
    await execute(process.execPath, [join(installationRoot(), 'bin/vspod.mjs'), 'open', '--recent', '--smoke', '--yes'],
      { timeout: 90_000 });
    assert.equal((await runtime.inspect(workspace))?.running, true, 'recent selection remembers desktop without a flag');
    assert.equal(await new CodeServerBackend().runtime.inspect(workspace), undefined);
  } catch (error) {
    if ((await runtime.inspect(workspace))?.running) {
      console.error(await execute('docker', ['exec', name, 'cat', '/tmp/application.log']));
      console.error(await execute('docker', ['exec', name, 'ls', '-la', '/tmp/runtime']));
      console.error(await optionalText(join(repo, 'probe.json')));
      console.error(await execute('docker', ['exec', name, '/opt/vscode/bin/code',
        '--ozone-platform=wayland', '--disable-gpu', '--user-data-dir', '/vspod/state/user-data', '--status']));
      for (const launch of (await readdir(state)).filter((entry) => entry.startsWith('launch-'))) {
        console.error((await optionalText(join(state, launch, 'host.log')))?.slice(-6000));
      }
    }
    throw error;
  } finally {
    await closeWindows({ id: workspace.id, backend: 'desktop' });
    if (await runtime.inspect(workspace)) { await runtime.remove(workspace); await runtime.removeTestVolumes(workspace); }
    if (oldState === undefined) delete process.env.VSPOD_STATE_DIR; else process.env.VSPOD_STATE_DIR = oldState;
    if (oldConfig === undefined) delete process.env.VSPOD_CONFIG_DIR; else process.env.VSPOD_CONFIG_DIR = oldConfig;
    if (oldBackend === undefined) delete process.env.VSPOD_EDITOR_BACKEND; else process.env.VSPOD_EDITOR_BACKEND = oldBackend;
    if (oldSeccomp === undefined) delete process.env.VSPOD_DESKTOP_SECCOMP; else process.env.VSPOD_DESKTOP_SECCOMP = oldSeccomp;
    await rm(temporary, { recursive: true, force: true });
  }
});
