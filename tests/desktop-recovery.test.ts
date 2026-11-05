import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DesktopBackend, desktopContainerName } from '@vspod/editor-backends';
import { openWorkspace, stopWorkspace, upgradeWorkspace, inspectConfiguration, trustConfiguration } from '@vspod/core';
import { installationRoot } from '@vspod/core/installation';
import { nativeAttachment } from '@vspod/core/native';
import { execute, withCancellation } from '@vspod/core/process';
import { readPrivate, writePrivate } from '@vspod/core/state';
import type { EditorSession } from '@vspod/core/backend';
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

test('desktop recovers from native crashes, duplicate hosts, container loss and failed upgrades', {
  skip: process.env.VSPOD_DESKTOP_TEST !== '1', timeout: 300_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-test-recovery-'));
  const repo = join(root, 'vspod-test-project');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const saved = { state: process.env.VSPOD_STATE_DIR, config: process.env.VSPOD_CONFIG_DIR,
    backend: process.env.VSPOD_EDITOR_BACKEND };
  process.env.VSPOD_STATE_DIR = join(root, 'host-state');
  process.env.VSPOD_CONFIG_DIR = join(root, 'configuration');
  delete process.env.VSPOD_EDITOR_BACKEND;
  const workspace = await resolveWorkspace(repo);
  await mkdir(join(repo, '.vspod'));
  await writeFile(join(repo, '.vspod/vspod.yml'),
    'schemaVersion: 1\ntasks:\n  startup:\n    - printf x >> /workspace/hook-runs\n');
  const backend = new DesktopBackend(), runtime = backend.runtime;
  const name = desktopContainerName(workspace), state = join(process.env.VSPOD_STATE_DIR, workspace.id);
  const ack = async () => {
    const { attachment } = await nativeAttachment(state);
    assert.ok(attachment);
    const directory = join(state, attachment.directory);
    const value = await readPrivate<{ stage: string; pid: number; hostPid: number; code?: string }>(join(directory, 'ack.json'));
    assert.ok(value);
    return { ...value, directory };
  };
  const persistent = async () => {
    for (const kind of ['extensions', 'settings', 'state', 'config']) {
      assert.equal(await execute('docker', ['exec', name, 'cat', `/vspod/${kind}/retained`]), kind);
    }
  };
  try {
    await trustConfiguration(workspace, (await inspectConfiguration(workspace)).resolved);
    assert.ok(await openWorkspace(backend, repo));
    const initial = await runtime.inspect(workspace);
    assert.ok(initial?.running);
    await execute('docker', ['exec', name, 'node', '-e',
      "const fs=require('fs');for(const kind of ['extensions','settings','state','config'])fs.writeFileSync('/vspod/'+kind+'/retained',kind);"]);

    const originalAck = await ack();
    const duplicate = await mkdtemp(join(state, 'launch-'));
    await writePrivate(join(duplicate, 'session.json'), { status: 'ready', backend: 'desktop',
      runtimeSession: `${initial.id}/${initial.startedAt}`, presentation: { kind: 'native', sessionId: name } });
    const contender = backend.nativePresenter.launch(duplicate);
    const exit = new Promise((resolve, reject) => { contender.once('error', reject); contender.once('exit', resolve); });
    assert.equal(await exit, 1, 'a duplicate supervisor fails rather than stealing the bridge');
    assert.equal((await readPrivate<{ code: string }>(join(duplicate, 'ack.json')))?.code, 'NATIVE_ATTACHMENT_BUSY');
    assert.equal((await ack()).hostPid, originalAck.hostPid);
    await rm(join(process.env.VSPOD_STATE_DIR, 'catalog/history.json'));
    assert.equal(await openWorkspace(backend, repo), undefined, 'original host remains responsive');
    assert.equal((await ack()).hostPid, originalAck.hostPid, 'missing recent history cannot create a duplicate attachment');

    process.kill(originalAck.hostPid, 'SIGKILL');
    await waitFor(async () => (await nativeAttachment(state)).locked, (locked) => !locked, 'host crash releases attachment');
    assert.equal((await runtime.inspect(workspace))?.startedAt, initial.startedAt);
    assert.ok(await openWorkspace(backend, repo), 'host crash reattaches to the same guest');
    const beforeSupervisorKill = await ack();
    process.kill(beforeSupervisorKill.pid, 'SIGKILL');
    await waitFor(async () => (await nativeAttachment(state)).locked, (locked) => !locked, 'supervisor heartbeat expires');
    assert.ok(await openWorkspace(backend, repo), 'supervisor crash allows a fresh attachment');
    assert.equal((await runtime.inspect(workspace))?.startedAt, initial.startedAt);
    await persistent();

    await execute('docker', ['kill', name]);
    await waitFor(async () => (await nativeAttachment(state)).locked, (locked) => !locked, 'dead guest detaches native host');
    const diagnostics = await backend.diagnose(workspace);
    assert.ok(diagnostics.some((entry) => entry.name === 'Native attachment' && !entry.healthy && /Logs:/.test(entry.detail)));
    assert.ok(await openWorkspace(backend, repo), 'unexpected container exit can be reopened');
    const restarted = await runtime.inspect(workspace);
    assert.notEqual(restarted?.startedAt, initial.startedAt);
    await persistent();

    await execute('docker', ['restart', name]);
    await waitFor(async () => (await nativeAttachment(state)).locked, (locked) => !locked, 'external restart invalidates old attachment');
    await assert.rejects(openWorkspace(backend, repo), { code: 'SESSION_UNAVAILABLE' });
    assert.ok((await backend.diagnose(workspace)).some((entry) => entry.name === 'Desktop session' && !entry.healthy));
    await stopWorkspace(backend, repo);
    assert.ok(await openWorkspace(backend, repo), 'explicit stop/reopen recovers externally restarted guests');
    await persistent();

    const ensureImage = runtime.ensureImage.bind(runtime);
    runtime.ensureImage = () => ensureImage(); // Exercise replacement of the already-built maintained image.
    const beforeUpgrade = await runtime.inspect(workspace);
    assert.equal(await upgradeWorkspace(backend, repo, true), true);
    const upgraded = await runtime.inspect(workspace);
    assert.notEqual(upgraded?.id, beforeUpgrade?.id);
    assert.equal((await nativeAttachment(state)).locked, false, 'upgrade detaches the old host');
    assert.ok(await openWorkspace(backend, repo), 'upgraded editor can attach');
    await persistent();
    const waitForReady = backend.waitForReady.bind(backend);
    let checks = 0;
    backend.waitForReady = async (target, session) => {
      if (++checks === 1) throw new Error('Injected replacement readiness failure');
      await waitForReady(target, session);
    };
    await assert.rejects(upgradeWorkspace(backend, repo, true), /previous container was restored/i);
    backend.waitForReady = waitForReady;
    const restored = await runtime.inspect(workspace);
    assert.equal(restored?.id, upgraded?.id);
    assert.equal(checks, 2, 'rollback reactivates and checks the restored editor');
    const session = await readPrivate<EditorSession>(join(state, 'desktop/runtime.json'));
    assert.equal(session?.containerId, restored?.id);
    assert.equal(session?.startedAt, restored?.startedAt);
    const applied = await readPrivate<{ containerId: string; startedAt: string }>(join(state, 'desktop/configuration.json'));
    assert.equal(applied?.containerId, restored?.id);
    assert.equal(applied?.startedAt, restored?.startedAt, 'rollback records a valid applied generation');
    assert.ok(await openWorkspace(backend, repo), 'rollback leaves an attachable editor, not just a running container');
    await persistent();

    const cancellation = new AbortController();
    checks = 0;
    backend.waitForReady = async (target, active) => {
      if (++checks === 1) cancellation.abort();
      await waitForReady(target, active);
    };
    await assert.rejects(withCancellation(cancellation.signal, () => upgradeWorkspace(backend, repo, true)),
      /previous container was restored/i);
    backend.waitForReady = waitForReady;
    assert.equal(checks, 2, 'cancellation cannot interrupt rollback activation');
    assert.equal((await runtime.inspect(workspace))?.id, restored?.id);
    assert.ok(await openWorkspace(backend, repo), 'cancelled upgrades still leave a usable configuration receipt');
    await persistent();

    const startupTask = runtime.runStartupTask.bind(runtime);
    let hooks = 0;
    runtime.runStartupTask = async (target, command) => {
      if (++hooks === 1) throw new Error('Injected startup hook failure');
      await startupTask(target, command);
    };
    await assert.rejects(upgradeWorkspace(backend, repo, true), /previous container was restored/i);
    runtime.runStartupTask = startupTask;
    assert.equal(hooks, 2, 'approved hooks are checked during replacement and recovery');
    assert.equal((await runtime.inspect(workspace))?.id, restored?.id);
    assert.ok(await openWorkspace(backend, repo), 'hook failure rollback leaves a matching applied configuration');
    await persistent();

    const cli = join(installationRoot(), 'bin/vspod.mjs');
    const doctor = await execute(process.execPath, [cli, 'doctor', repo, '--backend', 'desktop']);
    assert.match(doctor, /Desktop session: matches/);
    assert.match(doctor, /Native attachment: owned/);
    assert.match(doctor, /host\.log/);

    const env = { context: process.env.DOCKER_CONTEXT, host: process.env.DOCKER_HOST };
    try {
      delete process.env.DOCKER_CONTEXT;
      process.env.DOCKER_HOST = `unix://${join(root, 'unavailable.sock')}`;
      await assert.rejects(runtime.ensureAvailable(), /Docker is unavailable/);
    } finally {
      if (env.context === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = env.context;
      if (env.host === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = env.host;
    }
    await stopWorkspace(backend, repo);
    assert.ok(await openWorkspace(backend, repo, { smoke: true }), 'returns to a usable editor after runtime reconnection');
    await persistent();
  } catch (error) {
    const record = await nativeAttachment(state);
    if (record.attachment) {
      console.error(await readFile(join(state, record.attachment.directory, 'host.log'), 'utf8'));
      console.error(await readFile(join(state, record.attachment.directory, 'ack.json'), 'utf8'));
    }
    throw error;
  } finally {
    await stopWorkspace(backend, repo);
    if (await runtime.inspect(workspace)) { await runtime.remove(workspace); await runtime.removeTestVolumes(workspace); }
    if (saved.state === undefined) delete process.env.VSPOD_STATE_DIR; else process.env.VSPOD_STATE_DIR = saved.state;
    if (saved.config === undefined) delete process.env.VSPOD_CONFIG_DIR; else process.env.VSPOD_CONFIG_DIR = saved.config;
    if (saved.backend === undefined) delete process.env.VSPOD_EDITOR_BACKEND; else process.env.VSPOD_EDITOR_BACKEND = saved.backend;
    await rm(root, { recursive: true, force: true });
  }
});
