import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveWorkspace } from '@vspod/workspace';
import { openWorkspace } from './open.ts';
import { operationSignal } from './process.ts';
import { privateDirectory, readPrivate, withProjectLock, writePrivate } from './state.ts';
import { recentFolders } from './history.ts';
import type { ContainerRuntime, RuntimeInstance } from './runtime.ts';
import { resolveConfiguration } from '@vspod/config';

for (const existing of [false, true]) {
  test(`cancelled startup ${existing ? 'preserves an existing backend and credential' : 'stops only its newly started backend'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'vspod-cancel-'));
    const project = join(root, 'project');
    await mkdir(project);
    execFileSync('git', ['init', '--quiet', project]);
    const oldState = process.env.VSPOD_STATE_DIR;
    const oldBinary = process.env.VSPOD_DESKTOP_BINARY;
    process.env.VSPOD_STATE_DIR = join(root, 'state');
    process.env.VSPOD_DESKTOP_BINARY = join(root, 'desktop');
    await writeFile(process.env.VSPOD_DESKTOP_BINARY, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    const workspace = await resolveWorkspace(project);
    const state = join(process.env.VSPOD_STATE_DIR, workspace.id);
    await privateDirectory(state);
    const credential = { containerId: 'original', startedAt: 'original', password: 'a'.repeat(64) };
    if (existing) await writePrivate(join(state, 'runtime.json'), credential);
    if (existing) await writePrivate(join(state, 'configuration.json'), {
      fingerprint: resolveConfiguration().fingerprint, containerId: 'original', startedAt: 'original',
    });
    const cancellation = new AbortController();
    let stops = 0;
    let instance: RuntimeInstance | undefined = existing ? { id: 'original', startedAt: 'original', running: true, url: 'http://127.0.0.1:49152' } : undefined;
    const runtime: ContainerRuntime = {
      ensureAvailable: async () => {}, ensureImage: async () => {},
      inspect: async () => instance && { ...instance },
      create: async () => { instance = { id: 'new', running: false }; },
      start: async () => {
        instance = { id: 'new', startedAt: 'new', running: true, url: 'http://127.0.0.1:49152' };
        cancellation.abort();
        operationSignal()?.throwIfAborted();
        return instance;
      },
      stop: async () => { operationSignal()?.throwIfAborted(); stops++; if (instance) instance.running = false; },
      exec: async () => 0, logs: async () => 0,
      replace: async () => { throw new Error('Not expected'); },
    };
    try {
      await assert.rejects(openWorkspace(runtime, project, {
        signal: cancellation.signal,
        onProgress: (progress) => { if (existing && progress.step === 2) cancellation.abort(); },
      }), (error: unknown) => {
        assert.equal((error as { code: string }).code, 'OPEN_CANCELLED');
        return true;
      });
      assert.equal(stops, existing ? 0 : 1);
      assert.equal(instance?.running, existing);
      assert.deepEqual(await recentFolders(), []);
      assert.deepEqual(await readPrivate(join(state, 'runtime.json')), existing ? credential : undefined);
      assert.equal(await withProjectLock(workspace, async () => 'released'), 'released');
    } finally {
      if (oldState === undefined) delete process.env.VSPOD_STATE_DIR;
      else process.env.VSPOD_STATE_DIR = oldState;
      if (oldBinary === undefined) delete process.env.VSPOD_DESKTOP_BINARY;
      else process.env.VSPOD_DESKTOP_BINARY = oldBinary;
      await rm(root, { force: true, recursive: true });
    }
  });
}