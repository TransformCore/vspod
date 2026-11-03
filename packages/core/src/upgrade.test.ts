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
  try {
    assert.equal(await upgradeWorkspace(runtime, project), false);
    const directory = join(process.env.VSPOD_STATE_DIR, workspace.id);
    await privateDirectory(directory);
    const credential = { containerId: 'existing', startedAt: 'original', password: 'a'.repeat(64) };
    await writePrivate(join(directory, 'runtime.json'), credential);
    await assert.rejects(upgradeWorkspace(runtime, project, true), /did not start/);
    assert.deepEqual(await readPrivate(join(directory, 'runtime.json')), credential);
    runtime.replace = async () => { current.id = 'replacement'; current.startedAt = 'later'; return current; };
    assert.equal(await upgradeWorkspace(runtime, project, true), true);
    const updated = await readPrivate<typeof credential>(join(directory, 'runtime.json'));
    assert.equal(updated?.containerId, 'replacement');
    assert.match(updated!.password, /^[a-f0-9]{64}$/);
    assert.notEqual(updated?.password, credential.password);
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});