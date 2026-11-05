import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
import type { EditorBackend, EditorSession } from './backend.ts';
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
    const credential: EditorSession = {
      backend: 'test-web', containerId: 'original', startedAt: 'original',
      presentation: { kind: 'web', origin: 'http://127.0.0.1:49152', authentication: { kind: 'password', password: 'a'.repeat(64) } },
    };
    if (existing) await writePrivate(join(state, 'runtime.json'), credential);
    if (existing) await writePrivate(join(state, 'configuration.json'), {
      backend: 'test-web', fingerprint: resolveConfiguration().fingerprint, containerId: 'original', startedAt: 'original',
    });
    const cancellation = new AbortController();
    let stops = 0;
    let instance: RuntimeInstance | undefined = existing ? { id: 'original', startedAt: 'original', running: true } : undefined;
    const runtime: ContainerRuntime = {
      ensureAvailable: async () => {}, ensureImage: async () => {},
      inspect: async () => instance && { ...instance },
      create: async () => { instance = { id: 'new', running: false }; },
      start: async () => {
        instance = { id: 'new', startedAt: 'new', running: true };
        cancellation.abort();
        operationSignal()?.throwIfAborted();
        return instance;
      },
      stop: async () => { operationSignal()?.throwIfAborted(); stops++; if (instance) instance.running = false; },
      exec: async () => 0, logs: async () => 0,
      replace: async () => { throw new Error('Not expected'); },
    };
    const backend: EditorBackend = {
      id: 'test-web', vscodeVersion: '1.106.3', runtime,
      start: async () => {
        const current = await runtime.start(workspace);
        return { ...credential, containerId: current.id, startedAt: current.startedAt! };
      },
      resume: (_instance, session) => { assert.ok(session); return session; },
      waitForReady: async () => { throw new Error('Cancelled before readiness'); },
    };
    try {
      await assert.rejects(openWorkspace(backend, project, {
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

for (const typed of [false, true]) {
  test(`native startup preserves ${typed ? 'structured host errors' : 'presenter exit diagnostics'} rather than reporting cancellation`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'vspod-native-failure-'));
    const project = join(root, 'project');
    await mkdir(project);
    execFileSync('git', ['init', '--quiet', project]);
    const previous = process.env.VSPOD_STATE_DIR;
    process.env.VSPOD_STATE_DIR = join(root, 'state');
    let running = false, launchDirectory = '';
    const instance = () => ({ id: 'guest', startedAt: 'generation', running });
    const runtime: ContainerRuntime = {
      ensureAvailable: async () => {}, ensureImage: async () => {},
      inspect: async () => instance(), create: async () => {},
      start: async () => { running = true; return instance(); },
      stop: async () => { running = false; },
      exec: async () => 0, logs: async () => 0,
      replace: async () => { throw new Error('Not expected'); },
    };
    const session: EditorSession = {
      backend: 'desktop', containerId: 'guest', startedAt: 'generation',
      presentation: { kind: 'native', sessionId: 'guest' },
    };
    const backend: EditorBackend = {
      id: 'desktop', vscodeVersion: '1.106.3', runtime,
      start: async () => { await runtime.start(await resolveWorkspace(project)); return session; },
      resume: () => session, waitForReady: async () => {},
      nativePresenter: {
        check: async () => {}, openFolder: async () => {},
        launch: (directory) => {
          launchDirectory = directory;
          return spawn(process.execPath, ['-e', `
            ${typed ? `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({
              stage:'error', code:'NATIVE_HOST_EXITED', message:'Injected host failure',
              hint:'Inspect the native host log, then reopen.'
            }), {mode:0o600});` : ''}
            process.exit(1);
          `, join(directory, 'ack.json')], { stdio: 'ignore' });
        },
      },
    };
    try {
      await assert.rejects(openWorkspace(backend, project), (error: unknown) => {
        const failure = error as { code: string; hint: string };
        assert.equal(failure.code, typed ? 'NATIVE_HOST_EXITED' : 'NATIVE_START_FAILED');
        assert.match(failure.hint, typed ? /native host log/ : /supervisor\.log/);
        return true;
      });
      assert.equal((await readPrivate<{ status: string }>(join(launchDirectory, 'session.json')))?.status, 'error');
    } finally {
      if (previous === undefined) delete process.env.VSPOD_STATE_DIR; else process.env.VSPOD_STATE_DIR = previous;
      await rm(root, { force: true, recursive: true });
    }
  });
}