import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { upgradeWorkspace } from './upgrade.ts';
import { privateDirectory, readPrivate, writePrivate } from './state.ts';
import { resolveWorkspace } from '@vspod/workspace';
import type { ContainerRuntime } from './runtime.ts';
import type { EditorBackend, EditorSession } from './backend.ts';
import { resolveConfiguration } from '@vspod/config';

test('upgrades are no-op when current and preserve credentials when replacement never starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-upgrade-'));
  const project = join(root, 'project');
  await mkdir(project);
  execFileSync('git', ['init', '--quiet', project]);
  const workspace = await resolveWorkspace(project);
  const previous = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  const current = { id: 'existing', running: true, compatible: true, startedAt: 'original' };
  const runtime: ContainerRuntime = {
    ensureAvailable: async () => {}, ensureImage: async () => {},
    inspect: async () => ({ ...current }), create: async () => {}, start: async () => ({ ...current }),
    stop: async () => {}, exec: async () => 0, logs: async () => 0,
    replace: async () => { throw new Error('Replacement did not start'); },
  };
  let serial = 0;
  const backend: EditorBackend = {
    id: 'test-web', vscodeVersion: '1.106.3', runtime,
    start: async () => ({
      backend: 'test-web', containerId: current.id, startedAt: current.startedAt,
      presentation: { kind: 'web', origin: 'http://127.0.0.1:49152',
        authentication: { kind: 'password', password: String(++serial).repeat(64) } },
    }),
    resume: (_instance, session) => { assert.ok(session); return session; },
    waitForReady: async () => {},
  };
  try {
    assert.equal(await upgradeWorkspace(backend, project), false);
    const directory = join(process.env.VSPOD_STATE_DIR, workspace.id);
    await privateDirectory(directory);
    const credential = await backend.start(workspace, resolveConfiguration());
    await writePrivate(join(directory, 'runtime.json'), credential);
    await assert.rejects(upgradeWorkspace(backend, project, true), /did not start/);
    assert.deepEqual(await readPrivate(join(directory, 'runtime.json')), credential);
    runtime.replace = async (_workspace, activate) => { current.id = 'replacement'; current.startedAt = 'later'; await activate(); return current; };
    assert.equal(await upgradeWorkspace(backend, project, true), true);
    const updated = await readPrivate<EditorSession>(join(directory, 'runtime.json'));
    assert.equal(updated?.containerId, 'replacement');
    assert.equal(updated?.backend, backend.id);
    assert.notDeepEqual(updated?.presentation, credential.presentation);
    let readinessChecks = 0;
    backend.waitForReady = async () => {
      if (++readinessChecks === 1) throw new Error('Replacement health check failed');
    };
    runtime.replace = async (_workspace, activate) => {
      current.id = 'failed-replacement';
      current.startedAt = 'failed';
      try { await activate(); } catch {
        current.id = 'replacement';
        current.startedAt = 'restored';
        await activate();
        throw new Error('Previous container restored after failed health check');
      }
      throw new Error('Expected the replacement health check to fail');
    };
    await assert.rejects(upgradeWorkspace(backend, project, true), /Previous container restored/);
    const restored = await readPrivate<EditorSession>(join(directory, 'runtime.json'));
    assert.equal(restored?.containerId, 'replacement');
    assert.equal(restored?.startedAt, 'restored');
    assert.notDeepEqual(restored?.presentation, updated?.presentation);
    assert.equal(readinessChecks, 2);
    const receipt = await readPrivate<{ containerId: string; startedAt: string }>(join(directory, 'configuration.json'));
    assert.equal(receipt?.containerId, restored?.containerId);
    assert.equal(receipt?.startedAt, restored?.startedAt);
    runtime.replace = async (_workspace, activate) => {
      current.id = 'unrecoverable';
      current.startedAt = 'unrecoverable';
      await activate();
      return current;
    };
    backend.waitForReady = async () => { throw new Error('Recovery failed'); };
    await assert.rejects(upgradeWorkspace(backend, project, true), /Recovery failed/);
    assert.equal(await readPrivate(join(directory, 'runtime.json')), undefined);
    assert.equal(await readPrivate(join(directory, 'configuration.json')), undefined);
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});