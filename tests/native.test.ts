import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DockerRuntime } from '@vspod/docker';
import { closeWindows, openWorkspace, recentFolders, restorableFolders, stopWorkspace, inspectConfiguration, trustConfiguration } from '@vspod/core';
import { execute } from '@vspod/core/process';
import { installationRoot } from '@vspod/core/installation';
import { resolveWorkspace } from '@vspod/workspace';

const extension = String.raw`
const fs = require('node:fs');
const vscode = require('vscode');
exports.activate = async function (context) {
  try {
    const uri = vscode.Uri.file('/workspace/editor-probe.txt');
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: true });
    edit.insert(uri, new vscode.Position(0, 0), 'saved through VS Code workspace API');
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Editor rejected workspace edit');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await document.save();
    const terminal = vscode.window.createTerminal({
      name: 'VSPod integration probe', shellPath: '/bin/sh',
      shellArgs: ['-c', "printf 'terminal-in-container' > /workspace/terminal-probe.txt"],
    });
    terminal.show();
    fs.writeFileSync('/workspace/extension-probe.json', JSON.stringify({
      uid: process.getuid(), path: context.extensionPath,
      workspace: vscode.workspace.workspaceFolders[0].uri.fsPath,
      tabSize: vscode.workspace.getConfiguration('editor', vscode.workspace.workspaceFolders[0].uri).get('tabSize'),
    }));
  } catch (error) {
    fs.writeFileSync('/workspace/probe-error.txt', String(error));
  }
};
`;

test('native webview runs a container extension, saves a file and starts an integrated terminal', {
  skip: process.env.VSPOD_NATIVE_TEST !== '1', timeout: 180_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vspod-test-native-'));
  const root = join(temporary, 'vspod-test-project');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet', root]);
  const workspace = await resolveWorkspace(root);
  const runtime = new DockerRuntime();
  const previous = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(temporary, 'host-state');
  let created = false;
  let desktopPid: number | undefined;
  try {
    await runtime.ensureAvailable();
    await runtime.ensureImage();
    await runtime.create(workspace);
    created = true;
    await runtime.start(workspace, randomBytes(32).toString('hex'));
    const manifest = {
      name: 'vspod-spike-probe', publisher: 'vspod', version: '0.0.1',
      engines: { vscode: '^1.106.0' }, activationEvents: ['*'],
      extensionKind: ['workspace'], main: './extension.cjs',
      capabilities: { untrustedWorkspaces: { supported: true } },
    };
    const install = `const fs=require('node:fs');const path='/vspod/extensions/vspod.vspod-spike-probe-0.0.1';fs.mkdirSync(path,{recursive:true});fs.writeFileSync(path+'/package.json',${JSON.stringify(JSON.stringify(manifest))});fs.writeFileSync(path+'/extension.cjs',${JSON.stringify(extension)});`;
    assert.equal(await runtime.exec(workspace, ['node', '-e', install]), 0);
    await runtime.stop(workspace);
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":9}');
    await mkdir(join(root, '.vspod'));
    await writeFile(join(root, '.vspod/vspod.yml'), 'schemaVersion: 1\nsettings:\n  editor.tabSize: 2\ntasks:\n  startup:\n    - printf x >> /workspace/startup-count.txt\n');
    await trustConfiguration(workspace, (await inspectConfiguration(workspace)).resolved);
    desktopPid = await openWorkspace(runtime, root);
    assert.ok(desktopPid);
    const deadline = Date.now() + 30_000;
    while (true) {
      const error = await readFile(join(root, 'probe-error.txt'), 'utf8').catch(() => undefined);
      assert.equal(error, undefined);
      try {
        const probe = JSON.parse(await readFile(join(root, 'extension-probe.json'), 'utf8'));
        assert.equal(probe.uid, 1000);
        assert.match(probe.path, /^\/vspod\/extensions\//);
        assert.equal(probe.workspace, '/workspace');
        assert.equal(probe.tabSize, 2, '.vspod must override conflicting native .vscode settings');
        assert.equal(await readFile(join(root, 'startup-count.txt'), 'utf8'), 'x');
        assert.equal(await readFile(join(root, 'editor-probe.txt'), 'utf8'), 'saved through VS Code workspace API');
        assert.equal(await readFile(join(root, 'terminal-probe.txt'), 'utf8'), 'terminal-in-container');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
      }
      await delay(200);
    }
    const containerId = (await runtime.inspect(workspace))!.id;
    runtime.ensureImage = async () => { throw new Error('Warm open must not prepare an image'); };
    assert.deepEqual(await Promise.all([openWorkspace(runtime, root), openWorkspace(runtime, root)]), [undefined, undefined]);
    assert.equal((await recentFolders()).length, 1);
    assert.equal((await runtime.inspect(workspace))!.id, containerId);
    assert.equal(await readFile(join(root, 'startup-count.txt'), 'utf8'), 'x', 'warm opens never rerun startup hooks');
    const definition = await readFile(join(root, '.vspod/vspod.yml'), 'utf8');
    await writeFile(join(root, '.vspod/vspod.yml'), definition.replace('editor.tabSize: 2', 'editor.tabSize: 3'));
    await assert.rejects(openWorkspace(runtime, root), (error: unknown) => (error as { code: string }).code === 'CONFIG_TRUST_REQUIRED');
    await trustConfiguration(workspace, (await inspectConfiguration(workspace)).resolved);
    await assert.rejects(openWorkspace(runtime, root), (error: unknown) => (error as { code: string }).code === 'CONFIG_RESTART_REQUIRED');
    assert.equal((await runtime.inspect(workspace))!.id, containerId);
    await writeFile(join(root, '.vspod/vspod.yml'), definition);
    await trustConfiguration(workspace, (await inspectConfiguration(workspace)).resolved);
    const subfolder = join(root, 'api');
    await mkdir(subfolder);
    assert.ok(await openWorkspace(runtime, subfolder));
    const folderDeadline = Date.now() + 30_000;
    while (true) {
      const probe = JSON.parse(await readFile(join(root, 'extension-probe.json'), 'utf8'));
      if (probe.workspace === '/workspace/api') {
        assert.equal(probe.tabSize, 2, 'subfolder windows share generated repository configuration');
        break;
      }
      if (Date.now() >= folderDeadline) assert.fail('Editor did not restore the requested subfolder');
      await delay(200);
    }
    assert.equal((await recentFolders()).length, 2);
    assert.equal(await closeWindows(), 2);
    assert.equal((await restorableFolders()).length, 2);
    const output = await execute(process.execPath, [join(installationRoot(), 'bin/vspod.mjs'), 'restore'], { timeout: 90_000 });
    assert.match(output, /Restored 2 folders/);
    assert.equal((await runtime.inspect(workspace))!.id, containerId);
    const interruptedExit = await new Promise<number | null>((resolve, reject) => {
      const command = spawn(process.execPath, [join(installationRoot(), 'bin/vspod.mjs'), 'open', root, '--new-window', '--yes'], {
        stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
      const timeout = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('CLI cancellation did not finish')); }, 20_000);
      let interrupted = false;
      command.stdout.on('data', (data: Buffer) => {
        if (!interrupted && data.toString().includes('Connecting securely')) {
          interrupted = true;
          command.kill('SIGINT');
        }
      });
      command.once('error', (error) => { clearTimeout(timeout); reject(error); });
      command.once('exit', (code) => { clearTimeout(timeout); resolve(code); });
    });
    assert.equal(interruptedExit, 130);
    assert.equal((await runtime.inspect(workspace))!.running, true);
    const warmCancellation = new AbortController();
    await assert.rejects(openWorkspace(runtime, root, {
      newWindow: true, signal: warmCancellation.signal,
      onProgress: (progress) => { if (progress.step === 2) warmCancellation.abort(); },
    }), (error: unknown) => (error as { code: string }).code === 'OPEN_CANCELLED');
    assert.equal((await runtime.inspect(workspace))!.running, true);
    await stopWorkspace(runtime, root);
    const start = runtime.start.bind(runtime);
    const coldCancellation = new AbortController();
    runtime.start = async (target, credential) => {
      const instance = await start(target, credential);
      coldCancellation.abort();
      return instance;
    };
    await assert.rejects(openWorkspace(runtime, root, { newWindow: true, signal: coldCancellation.signal }),
      (error: unknown) => (error as { code: string }).code === 'OPEN_CANCELLED');
    runtime.start = start;
    assert.equal((await runtime.inspect(workspace))!.running, false);
    assert.equal((await runtime.inspect(workspace))!.id, containerId);
    await writeFile(join(root, '.vspod/vspod.yml'), `${definition}accounts:\n  required: [github]\n`);
    await rm(join(root, 'extension-probe.json'));
    await openWorkspace(runtime, root, { restricted: true, smoke: true });
    assert.equal(await readFile(join(root, 'startup-count.txt'), 'utf8'), 'x');
    await assert.rejects(readFile(join(root, 'extension-probe.json')), { code: 'ENOENT' });
    const restrictedConfig = await execute('docker', ['exec', workspace.containerName, 'node', '-e',
      "console.log(require('node:fs').readFileSync('/vspod/config/config.json','utf8'))"]);
    assert.equal(JSON.parse(restrictedConfig)['extensions-dir'], '/run/vspod/restricted-extensions');
  } catch (error) {
    if (created) {
      const diagnostics = `const fs=require('node:fs');function scan(path){for(const item of fs.readdirSync(path,{withFileTypes:true})){const file=path+'/'+item.name;if(item.isDirectory())scan(file);else if(item.name.endsWith('.log')){const lines=fs.readFileSync(file,'utf8').split('\\n').filter(line=>/vspod-spike-probe|Extension host|extension host|Workspace Trust|Activating extension/i.test(line));if(lines.length)console.log(file+'\\n'+lines.slice(-15).join('\\n'));}}}scan('/vspod/state/user-data/logs');`;
      await runtime.exec(workspace, ['node', '-e', diagnostics]).catch(() => {});
    }
    throw error;
  } finally {
    await closeWindows().catch(() => {});
    if (desktopPid) {
      try { process.kill(desktopPid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (created) {
      await runtime.remove(workspace);
      await runtime.removeTestVolumes(workspace);
    }
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = previous;
    await rm(temporary, { recursive: true, force: true });
  }
});