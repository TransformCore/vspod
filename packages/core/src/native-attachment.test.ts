import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireNativeAttachment, nativeAttachment, requestNativeAttachment } from './native-attachment.ts';
import { writePrivate } from './state.ts';

test('native attachment ownership excludes duplicates and releases for reattachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-attachment-'));
  const compromised = (error: Error) => { throw error; };
  try {
    const release = await acquireNativeAttachment(root, compromised);
    try {
      assert.equal((await nativeAttachment(root)).locked, true);
      await assert.rejects(acquireNativeAttachment(root, compromised), { code: 'NATIVE_ATTACHMENT_BUSY' });
    } finally { await release(); }
    assert.equal((await nativeAttachment(root)).locked, false);
    const next = await acquireNativeAttachment(root, compromised);
    await next();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale crashed ownership is recoverable without using persisted process IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-stale-attachment-'));
  try {
    await mkdir(join(root, 'desktop'), { mode: 0o700 });
    const path = join(root, 'desktop/attachment.lock');
    await mkdir(path);
    const past = new Date(Date.now() - 10_000);
    await utimes(path, past, past);
    assert.equal((await nativeAttachment(root)).locked, false);
    const release = await acquireNativeAttachment(root, (error) => { throw error; });
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a live attachment rejects stale generations and remains exclusive when unresponsive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-live-attachment-'));
  const release = await acquireNativeAttachment(root, (error) => { throw error; });
  try {
    await mkdir(join(root, 'launch-test'), { mode: 0o700 });
    await writePrivate(join(root, 'desktop/attachment.json'), {
      directory: 'launch-test', runtimeSession: 'container/generation',
    });
    await assert.rejects(requestNativeAttachment(root, 'focus', 'container/other-generation'), { code: 'NATIVE_GENERATION_CHANGED' });
    await assert.rejects(requestNativeAttachment(root, 'focus', 'container/generation'), { code: 'NATIVE_ATTACHMENT_UNRESPONSIVE' });
    assert.equal((await nativeAttachment(root)).locked, true);
    await assert.rejects(acquireNativeAttachment(root, (error) => { throw error; }), { code: 'NATIVE_ATTACHMENT_BUSY' });
  } finally {
    await release();
    await rm(root, { recursive: true, force: true });
  }
});
