import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Workspace } from '@vspod/workspace';
import type { EditorBackend } from './backend.ts';
import { backendStateDirectory } from './backend.ts';
import { explainError } from './errors.ts';
import { operationSignal } from './process.ts';
import { privateDirectory, readPrivate, stateDirectory, withProjectLock, writePrivate } from './state.ts';

interface WindowLifetime {
  version: 1;
  workspace: Workspace;
  backend: string;
  runtimeSession: string;
}

export async function registerWindowLifetime(directory: string, workspace: Workspace, backend: string, runtimeSession: string): Promise<void> {
  await writePrivate(join(directory, 'lifetime.json'), { version: 1, workspace, backend, runtimeSession });
}

async function readLifetime(directory: string, backend: string): Promise<WindowLifetime> {
  await privateDirectory(directory);
  const lifetime = await readPrivate<WindowLifetime>(join(directory, 'lifetime.json'));
  if (!lifetime || lifetime.version !== 1 || lifetime.backend !== backend ||
      !/^[a-f0-9]{20}$/.test(lifetime.workspace?.id ?? '') ||
      typeof lifetime.workspace.root !== 'string' || !isAbsolute(lifetime.workspace.root) ||
      typeof lifetime.runtimeSession !== 'string' || !lifetime.runtimeSession ||
      dirname(directory) !== join(stateDirectory(), lifetime.workspace.id) ||
      !/^launch-[a-zA-Z0-9]+$/.test(basename(directory))) {
    throw new Error('Invalid window lifetime. No container was stopped.');
  }
  return lifetime;
}

function presenterAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid window presenter PID.');
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Serialize close with open/upgrade, and never let a late close stop a new container generation. */
export async function stopAfterLastWindow(backend: EditorBackend, directory: string): Promise<boolean> {
  const lifetime = await readLifetime(directory, backend.id);
  return withProjectLock(lifetime.workspace, async (root) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^launch-[a-zA-Z0-9]+$/.test(entry.name)) continue;
      const otherDirectory = join(root, entry.name);
      const other = await readPrivate<WindowLifetime>(join(otherDirectory, 'lifetime.json'));
      if (other?.backend !== backend.id || other.runtimeSession !== lifetime.runtimeSession) continue;
      const ack = await readPrivate<{ stage: string; pid?: number }>(join(otherDirectory, 'ack.json'));
      if (!ack || (ack.stage !== 'closed' && ack.stage !== 'error' &&
          (ack.pid === undefined || presenterAlive(ack.pid)))) return false;
    }
    await backend.runtime.ensureAvailable();
    const instance = await backend.runtime.inspect(lifetime.workspace);
    if (!instance || `${instance.id}/${instance.startedAt}` !== lifetime.runtimeSession) return false;
    if (instance.running) {
      operationSignal()?.throwIfAborted();
      await backend.runtime.stop(lifetime.workspace);
    }
    const state = await backendStateDirectory(root, backend);
    const sessionPath = join(state, 'runtime.json');
    const session = await readPrivate<{ containerId: string; startedAt: string }>(sessionPath);
    if (session && `${session.containerId}/${session.startedAt}` === lifetime.runtimeSession) {
      await rm(sessionPath, { force: true });
    }
    return instance.running;
  }, 1_200_000);
}

export async function watchWindowLifecycle(backend: EditorBackend, directory: string): Promise<void> {
  await readLifetime(directory, backend.id);
  const path = join(directory, 'lifetime-ack.json');
  try {
    await writePrivate(path, { stage: 'watching', pid: process.pid });
    while (true) {
      const ack = await readPrivate<{ stage: string; pid?: number }>(join(directory, 'ack.json'));
      if (ack?.stage === 'closed') {
        const stopped = await stopAfterLastWindow(backend, directory);
        await writePrivate(path, { stage: 'closed', stopped });
        return;
      }
      if (ack?.stage === 'error') {
        await writePrivate(path, { stage: 'closed', stopped: false });
        return;
      }
      if (ack?.pid !== undefined && !presenterAlive(ack.pid)) {
        throw new Error('The workspace presenter exited without acknowledging close. The container was retained; run vspod stop or reopen.');
      }
      await delay(100);
    }
  } catch (error) {
    await writePrivate(path, { stage: 'error', ...explainError(error) });
    throw error;
  }
}

export async function waitForWindowShutdown(directory: string): Promise<void> {
  if (!await readPrivate(join(directory, 'lifetime.json'))) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await readPrivate<{ stage: string; title?: string }>(join(directory, 'lifetime-ack.json'));
    if (result?.stage === 'closed') return;
    if (result?.stage === 'error') throw new Error(`Window shutdown failed: ${result.title ?? 'inspect the private lifecycle log and run vspod stop'}`);
    await delay(50);
  }
  throw new Error('Window closed but container shutdown has not completed. Run vspod doctor or vspod stop; persistent volumes were retained.');
}
