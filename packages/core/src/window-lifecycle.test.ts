import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EditorBackend } from './backend.ts';
import { privateDirectory, readPrivate, writePrivate } from './state.ts';
import { registerWindowLifetime, stopAfterLastWindow, watchWindowLifecycle } from './window-lifecycle.ts';

const unused = async (): Promise<never> => { throw new Error('Unexpected backend call'); };
const backendDefaults = {
  vscodeVersion: '1.106.3', start: unused, resume: (): never => { throw new Error('Unexpected resume'); },
  waitForReady: unused,
};
const runtimeDefaults = {
  ensureImage: unused, create: unused, start: unused, exec: unused, logs: unused, replace: unused,
};

test('last-window shutdown is backend/generation scoped, preserves volumes and clears only matching session state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-window-lifetime-'));
  const previous = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = root;
  const workspace = { id: 'c'.repeat(20), root: '/projects/repo', name: 'repo', containerName: 'vspod-test' };
  let stops = 0, running = true, startedAt = 'generation';
  const backend: EditorBackend = { ...backendDefaults, id: 'code-server', runtime: {
    ...runtimeDefaults,
    ensureAvailable: async () => {},
    inspect: async () => ({ id: 'guest', startedAt, running }),
    stop: async () => { stops++; running = false; },
  } };
  const directory = join(root, workspace.id);
  const launch = async (name: string, stage: string, target = backend, generation = 'guest/generation') => {
    const path = join(directory, `launch-${name}`);
    await privateDirectory(path);
    await registerWindowLifetime(path, workspace, target.id, generation);
    await writePrivate(join(path, 'ack.json'), { stage, pid: process.pid });
    return path;
  };
  try {
    const first = await launch('first', 'closed');
    const second = await launch('second', 'editor-ready');
    await launch('native', 'editor-ready', { ...backend, id: 'desktop' });
    await launch('old', 'editor-ready', backend, 'guest/old');
    const crashed = await launch('crashed', 'editor-ready');
    const presenter = spawn(process.execPath, ['-e', '']);
    await once(presenter, 'exit');
    assert.ok(presenter.pid);
    await writePrivate(join(crashed, 'ack.json'), { stage: 'editor-ready', pid: presenter.pid });
    await writePrivate(join(directory, 'runtime.json'), { containerId: 'guest', startedAt });
    await writePrivate(join(directory, 'configuration.json'), { fingerprint: 'preserved' });
    assert.equal(await stopAfterLastWindow(backend, first), false, 'another same-generation window keeps the guest alive');
    assert.equal(stops, 0);
    await writePrivate(join(second, 'ack.json'), { stage: 'closed' });
    await Promise.all([stopAfterLastWindow(backend, first), stopAfterLastWindow(backend, second)]);
    assert.equal(stops, 1, 'simultaneous closes stop exactly once');
    assert.equal(await readPrivate(join(directory, 'runtime.json')), undefined);
    assert.deepEqual(await readPrivate(join(directory, 'configuration.json')), { fingerprint: 'preserved' });
    await watchWindowLifecycle(backend, second);
    assert.deepEqual(await readPrivate(join(second, 'lifetime-ack.json')), { stage: 'closed', stopped: false });
    running = true;
    startedAt = 'replacement';
    await writePrivate(join(directory, 'runtime.json'), { containerId: 'guest', startedAt });
    assert.equal(await stopAfterLastWindow(backend, first), false, 'a late close cannot stop an externally restarted or replaced guest');
    assert.equal(stops, 1);
    assert.deepEqual(await readPrivate(join(directory, 'runtime.json')), { containerId: 'guest', startedAt });
    await assert.rejects(stopAfterLastWindow({ ...backend, id: 'desktop' }, first), /Invalid window lifetime/);
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR; else process.env.VSPOD_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('web lifetime watcher reports shutdown failures explicitly and does not stop after presenter errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-window-watcher-'));
  const previous = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = root;
  const workspace = { id: 'd'.repeat(20), root: '/projects/repo', name: 'repo', containerName: 'vspod-test' };
  const directory = join(root, workspace.id, 'launch-first');
  let stops = 0;
  const backend: EditorBackend = { ...backendDefaults, id: 'code-server', runtime: {
    ...runtimeDefaults,
    ensureAvailable: async () => {},
    inspect: async () => ({ id: 'guest', startedAt: 'generation', running: true }),
    stop: async () => { stops++; throw new Error('Docker stop failed'); },
  } };
  try {
    await privateDirectory(directory);
    await registerWindowLifetime(directory, workspace, backend.id, 'guest/generation');
    await writePrivate(join(directory, 'ack.json'), { stage: 'closed' });
    await assert.rejects(watchWindowLifecycle(backend, directory), /Docker stop failed/);
    assert.equal((await readPrivate<{ stage: string }>(join(directory, 'lifetime-ack.json')))?.stage, 'error');
    await writePrivate(join(directory, 'ack.json'), { stage: 'error' });
    await watchWindowLifecycle(backend, directory);
    assert.equal(stops, 1, 'presenter failures retain the guest for recovery');
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR; else process.env.VSPOD_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
