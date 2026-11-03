import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { execute, withCancellation } from './process.ts';

test('cancellation waits for its child to exit and propagates through the operation context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-process-'));
  const controller = new AbortController();
  const marker = join(root, 'pid');
  try {
    const task = withCancellation(controller.signal, () => execute(process.execPath, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
    ]));
    const rejected = assert.rejects(task, { name: 'AbortError' });
    const deadline = Date.now() + 5_000;
    let pid: number | undefined;
    while (!pid && Date.now() < deadline) {
      pid = await readFile(marker, 'utf8').then(Number).catch(() => undefined);
      if (!pid) await delay(10);
    }
    assert.ok(pid, 'Child did not start');
    controller.abort();
    await rejected;
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    await assert.rejects(execute(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }), { name: 'AbortError' });
  } finally {
    controller.abort();
    await rm(root, { force: true, recursive: true });
  }
});

test('timeouts terminate children and secret-bearing failures suppress output', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), /timed out/);
  await assert.rejects(execute(process.execPath, ['-e', 'console.error("secret");process.exit(1)'], { input: 'private' }), (error: unknown) => {
    assert.doesNotMatch((error as Error).message, /secret|private/);
    assert.match((error as Error).message, /credential output suppressed/);
    return true;
  });
});