import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { DockerRuntime } from '@vspod/docker';
import { resolveWorkspace, type Workspace } from '@vspod/workspace';
import { waitForReady } from '@vspod/core';
import { resolveConfiguration } from '@vspod/config';

test('real container enforces auth, rotates credentials and preserves all volumes', {
  skip: process.env.VSPOD_DOCKER_TEST !== '1', timeout: 240_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vspod-test-'));
  const root = join(temporary, 'vspod-test-project');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet', root]);
  const workspace = await resolveWorkspace(root);
  const runtime = new DockerRuntime();
  let created = false;
  try {
    await runtime.ensureAvailable();
    await runtime.ensureImage();
    await runtime.create(workspace);
    created = true;
    let start = performance.now();
    const first = await runtime.start(workspace, randomBytes(32).toString('hex'));
    await waitForReady(runtime, workspace, first.url!);
    console.log(`Cached-image container start to health: ${Math.round(performance.now() - start)}ms`);
    const denied = await fetch(first.url!, { redirect: 'manual' });
    assert.equal(denied.status, 302);
    assert.match(denied.headers.get('location')!, /login/);
    await denied.body?.cancel();
    assert.equal(await runtime.exec(workspace, ['node', '-e', `const fs=require('node:fs');fs.writeFileSync('/vspod/settings/settings.json',JSON.stringify({'editor.wordWrap':'on','editor.tabSize':9}));fs.writeFileSync('/vspod/settings/keybindings.json',JSON.stringify([{key:'ctrl+alt+m',command:'workbench.action.showCommands'}]));`]), 0);

    const secondCredential = randomBytes(32).toString('hex');
    await runtime.stop(workspace);
    const configuration = resolveConfiguration({ profile: {
      schemaVersion: 1, settings: { 'editor.tabSize': 8 },
      keybindings: [{ key: 'ctrl+alt+p', command: 'workbench.action.quickOpen' }],
    } });
    const second = await runtime.start(workspace, secondCredential, configuration);
    await waitForReady(runtime, workspace, second.url!);
    assert.equal(await runtime.exec(workspace, ['node', '-e', `const fs=require('node:fs');const s=JSON.parse(fs.readFileSync('/vspod/settings/settings.json'));const k=JSON.parse(fs.readFileSync('/vspod/settings/keybindings.json'));if(s['editor.tabSize']!==8||s['editor.wordWrap']!=='on'||k.length!==2||k[1].key!=='ctrl+alt+p'||s['extensions.autoUpdate']!==false)throw new Error('Managed settings/keybindings were not preserved and applied');`]), 0);
    const login = await fetch(`${second.url}/login`, {
      method: 'POST', body: new URLSearchParams({ password: secondCredential }), redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
    assert.ok(cookie);
    await login.body?.cancel();
    const allowed = await fetch(`${second.url}/?folder=/workspace`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /workbench/);

    const probe = 'const fs=require("fs");if(process.getuid()!==1000||!process.version.startsWith("v22."))process.exit(1);for(const kind of ["settings","extensions","state","config"])fs.writeFileSync("/vspod/"+kind+"/spike-marker","persisted");';
    assert.equal(await runtime.exec(workspace, ['node', '-e', probe]), 0);
    await runtime.stop(workspace);
    start = performance.now();
    const third = await runtime.start(workspace, randomBytes(32).toString('hex'));
    await waitForReady(runtime, workspace, third.url!);
    assert.equal(await runtime.exec(workspace, ['node', '-e', `const fs=require('node:fs');const s=JSON.parse(fs.readFileSync('/vspod/settings/settings.json'));const k=JSON.parse(fs.readFileSync('/vspod/settings/keybindings.json'));if(s['editor.tabSize']!==4||s['editor.wordWrap']!=='on'||k.length!==1||k[0].key!=='ctrl+alt+m')throw new Error('Prior managed configuration was not removed without losing manual changes');`]), 0);
    console.log(`Stopped-container start to health: ${Math.round(performance.now() - start)}ms`);
    const stale = await fetch(third.url!, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(stale.status, 302);
    await stale.body?.cancel();
    const persisted = 'const fs=require("fs");for(const kind of ["settings","extensions","state","config"])if(fs.readFileSync("/vspod/"+kind+"/spike-marker","utf8")!=="persisted")process.exit(1);';
    assert.equal(await runtime.exec(workspace, ['node', '-e', persisted]), 0);
    assert.equal((await runtime.inspect(workspace))?.id, first.id);
    const replacement = await runtime.replace(workspace, randomBytes(32).toString('hex'));
    assert.notEqual(replacement.id, first.id);
    assert.equal(await runtime.exec(workspace, ['node', '-e', persisted]), 0);
    const expired = await fetch(`${replacement.url}/?folder=/workspace`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(expired.status, 302);
    await expired.body?.cancel();
    const create = runtime.create.bind(runtime);
    runtime.create = async () => { throw new Error('Deliberate replacement failure'); };
    await assert.rejects(runtime.replace(workspace, randomBytes(32).toString('hex')), /previous container was restored/);
    runtime.create = create;
    const restored = await runtime.inspect(workspace);
    assert.equal(restored?.id, replacement.id);
    assert.equal(restored?.running, true);
    await waitForReady(runtime, workspace, restored!.url!);
    assert.equal(await runtime.exec(workspace, ['node', '-e', persisted]), 0);
  } finally {
    if (created) {
      await runtime.remove(workspace);
      await runtime.removeTestVolumes(workspace);
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

test('independent repositories have distinct running containers, ports and volume data', {
  skip: process.env.VSPOD_DOCKER_TEST !== '1', timeout: 120_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vspod-test-isolation-'));
  const runtime = new DockerRuntime();
  const workspaces: Workspace[] = [];
  try {
    await runtime.ensureAvailable();
    await runtime.ensureImage();
    for (const name of ['vspod-test-first', 'vspod-test-second']) {
      const root = join(temporary, name);
      await mkdir(root);
      execFileSync('git', ['init', '--quiet', root]);
      const workspace = await resolveWorkspace(root);
      workspaces.push(workspace);
      await runtime.create(workspace);
    }
    const instances = await Promise.all(workspaces.map((workspace) => runtime.start(workspace, randomBytes(32).toString('hex'))));
    await Promise.all(instances.map((instance, index) => waitForReady(runtime, workspaces[index], instance.url!)));
    assert.notEqual(instances[0].id, instances[1].id);
    assert.notEqual(instances[0].url, instances[1].url);
    assert.equal(await runtime.exec(workspaces[0], ['node', '-e', 'require("node:fs").writeFileSync("/vspod/settings/isolation-probe","first-only")']), 0);
    assert.equal(await runtime.exec(workspaces[1], ['node', '-e', 'if(require("node:fs").existsSync("/vspod/settings/isolation-probe"))process.exit(1)']), 0);
    await runtime.stop(workspaces[0]);
    assert.equal((await runtime.inspect(workspaces[1]))?.running, true);
  } finally {
    for (const workspace of workspaces) {
      await runtime.remove(workspace);
      await runtime.removeTestVolumes(workspace);
    }
    await rm(temporary, { force: true, recursive: true });
  }
});