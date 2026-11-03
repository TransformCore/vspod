import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateDirectory, readPrivate, withProjectLock, writePrivate } from './state.ts';

test('session files are private, atomically replaceable and reject public files and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-state-'));
  try {
    await privateDirectory(root);
    const path = join(root, 'session.json');
    await writePrivate(path, { stage: 'starting' });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await writePrivate(path, { stage: 'ready' });
    assert.deepEqual(await readPrivate(path), { stage: 'ready' });
    await symlink(path, join(root, 'alias'));
    await assert.rejects(readPrivate(join(root, 'alias')), /private/);
    await chmod(path, 0o644);
    await assert.rejects(readPrivate(path), /private/);
    assert.equal(await readPrivate(join(root, 'missing')), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project lock excludes concurrent mutation and releases after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-lock-'));
  const previous = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = root;
  const workspace = { id: 'abc', root, name: 'project', containerName: 'vspod-abc' };
  try {
    await withProjectLock(workspace, async () => {
      await assert.rejects(withProjectLock(workspace, async () => {}), /Another VSPod operation/);
    });
    await assert.rejects(withProjectLock(workspace, async () => { throw new Error('probe'); }), /probe/);
    assert.equal(await withProjectLock(workspace, async () => 'released'), 'released');
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('expired heartbeat locks recover but legacy locks are not stolen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-stale-lock-'));
  const previous = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = root;
  const workspace = { id: 'expired', root, name: 'project', containerName: 'vspod-expired' };
  const directory = join(root, workspace.id);
  const lock = join(directory, 'operation.lock');
  try {
    await privateDirectory(directory);
    await mkdir(lock, { mode: 0o700 });
    await assert.rejects(withProjectLock(workspace, async () => {}), /legacy VSPod lock/);
    assert.ok((await lstat(lock)).isDirectory());
    await writePrivate(join(directory, 'lock-format.json'), { version: 2 });
    const expired = new Date(Date.now() - 60_000);
    await utimes(lock, expired, expired);
    assert.equal(await withProjectLock(workspace, async () => 'recovered'), 'recovered');
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});