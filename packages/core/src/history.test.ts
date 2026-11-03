import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeWindows, completeOnboarding, readCatalog, recentFolders, rememberFolder, refreshWindowHistory, restorableFolders } from './history.ts';
import { privateDirectory, writePrivate } from './state.ts';

test('history remembers exact folders, merges concurrent updates and excludes gracefully closed windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-history-'));
  const previous = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = root;
  const workspace = { id: 'a'.repeat(20), root: '/projects/repo', name: 'repo', containerName: 'vspod-test' };
  try {
    assert.deepEqual(await recentFolders(), []);
    await Promise.all([
      rememberFolder(workspace, '/projects/repo/api', 'launch-first'),
      rememberFolder(workspace, '/projects/repo/web', 'launch-second'),
    ]);
    assert.equal((await recentFolders()).length, 2);
    await completeOnboarding();
    assert.equal((await readCatalog()).onboardingComplete, true);
    for (const [window, stage] of [['launch-first', 'closed'], ['launch-second', 'editor-ready']]) {
      const directory = join(root, workspace.id, window);
      await privateDirectory(directory);
      await writePrivate(join(directory, 'ack.json'), { stage });
    }
    await refreshWindowHistory();
    assert.deepEqual((await restorableFolders()).map((entry) => entry.folder), ['/projects/repo/web']);
    await writePrivate(join(root, workspace.id, 'launch-second', 'ack.json'), { stage: 'closed' });
    assert.equal(await closeWindows(), 0);
    assert.deepEqual((await restorableFolders()).map((entry) => entry.folder), ['/projects/repo/web']);
    const catalog = JSON.stringify(await readCatalog());
    assert.ok(!catalog.includes('password'));
    await writePrivate(join(root, 'catalog/history.json'), { version: 999, recent: [] });
    await assert.rejects(readCatalog(), /unsupported format/);
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});