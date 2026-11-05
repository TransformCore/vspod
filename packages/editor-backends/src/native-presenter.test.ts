import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { readPrivate, writePrivate } from '@vspod/core/state';
import { presentNative } from './native-presenter.ts';

test('native supervisor acknowledges cancellation before a container or host is attached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vspod-presenter-'));
  try {
    const presenting = presentNative(directory);
    const deadline = Date.now() + 5_000;
    while (!await readPrivate(join(directory, 'ack.json'))) {
      assert.ok(Date.now() < deadline);
      await delay(10);
    }
    const id = 'a'.repeat(24);
    await writePrivate(join(directory, 'request.json'), { id, action: 'close' });
    await presenting;
    assert.equal((await readPrivate<{ stage: string }>(join(directory, 'ack.json')))?.stage, 'closed');
    assert.deepEqual(await readPrivate(join(directory, 'response.json')), { id });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native supervisor rejects web and malformed native presentations before attaching', async () => {
  for (const presentation of [{ kind: 'web', origin: 'http://127.0.0.1' }, { kind: 'native', sessionId: '../guest' }]) {
    const directory = await mkdtemp(join(tmpdir(), 'vspod-presenter-'));
    try {
      await writePrivate(join(directory, 'session.json'), { backend: 'desktop', status: 'ready', presentation });
      await assert.rejects(presentNative(directory), /Invalid desktop presentation/);
      assert.equal((await readPrivate<{ stage: string }>(join(directory, 'ack.json')))?.stage, 'error');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
