import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { DockerRuntime } from '@vspod/docker';
import { CodeServerBackend, CODE_SERVER_ENVIRONMENT } from '@vspod/editor-backends';
import type { EditorSession } from '@vspod/core/backend';
import { resolveWorkspace, type Workspace } from '@vspod/workspace';
import { resolveConfiguration } from '@vspod/config';

function web(session: EditorSession) {
  assert.equal(session.presentation.kind, 'web');
  if (session.presentation.kind !== 'web') throw new Error('Expected web presentation');
  return session.presentation;
}

async function replace(backend: CodeServerBackend, workspace: Workspace): Promise<EditorSession> {
  let session: EditorSession | undefined;
  await backend.runtime.replace(workspace, async () => {
    session = await backend.start(workspace);
    await backend.waitForReady(workspace, session);
  });
  assert.ok(session);
  return session;
}

test('real container enforces auth, rotates credentials and preserves all volumes', {
  skip: process.env.VSPOD_DOCKER_TEST !== '1', timeout: 240_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vspod-test-'));
  const root = join(temporary, 'vspod-test-project');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet', root]);
  const workspace = await resolveWorkspace(root);
  const runtime = new DockerRuntime(CODE_SERVER_ENVIRONMENT);
  const backend = new CodeServerBackend(runtime);
  let created = false;
  try {
    await runtime.ensureAvailable();
    await runtime.ensureImage();
    await runtime.create(workspace);
    created = true;
    let start = performance.now();
    const first = await backend.start(workspace);
    await backend.waitForReady(workspace, first);
    console.log(`Cached-image container start to health: ${Math.round(performance.now() - start)}ms`);
    const denied = await fetch(web(first).origin, { redirect: 'manual' });
    assert.equal(denied.status, 302);
    assert.match(denied.headers.get('location')!, /login/);
    await denied.body?.cancel();
    assert.equal(await runtime.exec(workspace, ['node', '-e', `const fs=require('node:fs');fs.writeFileSync('/vspod/settings/settings.json',JSON.stringify({'editor.wordWrap':'on','editor.tabSize':9}));fs.writeFileSync('/vspod/settings/keybindings.json',JSON.stringify([{key:'ctrl+alt+m',command:'workbench.action.showCommands'}]));`]), 0);

    await runtime.stop(workspace);
    const configuration = resolveConfiguration({ profile: {
      schemaVersion: 1, settings: { 'editor.tabSize': 8 },
      keybindings: [{ key: 'ctrl+alt+p', command: 'workbench.action.quickOpen' }],
    } });
    const second = await backend.start(workspace, configuration);
    await backend.waitForReady(workspace, second);
    assert.equal(await runtime.exec(workspace, ['node', '-e', `const fs=require('node:fs');const s=JSON.parse(fs.readFileSync('/vspod/settings/settings.json'));const k=JSON.parse(fs.readFileSync('/vspod/settings/keybindings.json'));if(s['editor.tabSize']!==8||s['editor.wordWrap']!=='on'||k.length!==2||k[1].key!=='ctrl+alt+p'||s['extensions.autoUpdate']!==false)throw new Error('Managed settings/keybindings were not preserved and applied');`]), 0);
    const login = await fetch(`${web(second).origin}/login`, {
      method: 'POST', body: new URLSearchParams({ password: web(second).authentication.password }), redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
    assert.ok(cookie);
    await login.body?.cancel();
    const allowed = await fetch(`${web(second).origin}/?folder=/workspace`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /workbench/);

    const probe = 'const fs=require("fs");if(process.getuid()!==1000||!process.version.startsWith("v22."))process.exit(1);for(const kind of ["settings","extensions","state","config"])fs.writeFileSync("/vspod/"+kind+"/spike-marker","persisted");';
    assert.equal(await runtime.exec(workspace, ['node', '-e', probe]), 0);
    await runtime.stop(workspace);
    start = performance.now();
    const third = await backend.start(workspace);
    await backend.waitForReady(workspace, third);
    assert.equal(await runtime.exec(workspace, ['node', '-e', `const fs=require('node:fs');const s=JSON.parse(fs.readFileSync('/vspod/settings/settings.json'));const k=JSON.parse(fs.readFileSync('/vspod/settings/keybindings.json'));if(s['editor.tabSize']!==4||s['editor.wordWrap']!=='on'||k.length!==1||k[0].key!=='ctrl+alt+m')throw new Error('Prior managed configuration was not removed without losing manual changes');`]), 0);
    console.log(`Stopped-container start to health: ${Math.round(performance.now() - start)}ms`);
    const stale = await fetch(web(third).origin, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(stale.status, 302);
    await stale.body?.cancel();
    const persisted = 'const fs=require("fs");for(const kind of ["settings","extensions","state","config"])if(fs.readFileSync("/vspod/"+kind+"/spike-marker","utf8")!=="persisted")process.exit(1);';
    assert.equal(await runtime.exec(workspace, ['node', '-e', persisted]), 0);
    assert.equal((await runtime.inspect(workspace))?.id, first.containerId);
    const replacement = await replace(backend, workspace);
    assert.notEqual(replacement.containerId, first.containerId);
    assert.equal(await runtime.exec(workspace, ['node', '-e', persisted]), 0);
    const expired = await fetch(`${web(replacement).origin}/?folder=/workspace`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(expired.status, 302);
    await expired.body?.cancel();
    const create = runtime.create.bind(runtime);
    runtime.create = async () => { throw new Error('Deliberate replacement failure'); };
    await assert.rejects(replace(backend, workspace), /previous container was restored/);
    runtime.create = create;
    const restored = await runtime.inspect(workspace);
    assert.equal(restored?.id, replacement.containerId);
    assert.equal(restored?.running, true);
    assert.ok(restored?.ports?.['8080']);
    assert.equal((await fetch(new URL('/healthz', restored.ports['8080']))).status, 200);
    assert.equal(await runtime.exec(workspace, ['node', '-e', persisted]), 0);
    let recovered: EditorSession | undefined;
    let activations = 0;
    await assert.rejects(runtime.replace(workspace, async () => {
      recovered = await backend.start(workspace);
      if (++activations === 1) throw new Error('Deliberate readiness failure after replacement start');
      await backend.waitForReady(workspace, recovered);
    }), /previous container was restored/);
    assert.equal(activations, 2);
    assert.equal((await runtime.inspect(workspace))?.id, replacement.containerId);
    assert.ok(recovered);
    backend.resume((await runtime.inspect(workspace))!, recovered);
    const recoveryLogin = await fetch(`${web(recovered).origin}/login`, {
      method: 'POST', body: new URLSearchParams({ password: web(recovered).authentication.password }), redirect: 'manual',
    });
    assert.equal(recoveryLogin.status, 302);
    assert.ok(recoveryLogin.headers.getSetCookie().length);
    await recoveryLogin.body?.cancel();
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
  const runtime = new DockerRuntime(CODE_SERVER_ENVIRONMENT);
  const backend = new CodeServerBackend(runtime);
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
    const instances = await Promise.all(workspaces.map((workspace) => backend.start(workspace)));
    await Promise.all(instances.map((instance, index) => backend.waitForReady(workspaces[index], instance)));
    assert.notEqual(instances[0].containerId, instances[1].containerId);
    assert.notEqual(web(instances[0]).origin, web(instances[1]).origin);
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