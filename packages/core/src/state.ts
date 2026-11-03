import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Workspace } from '@vspod/workspace';
import lockfile from 'proper-lockfile';
import { operationSignal, withCancellation } from './process.ts';

export const stateDirectory = () => resolve(process.env.VSPOD_STATE_DIR ?? join(homedir(), 'Library', 'Application Support', 'VSPod', 'spike'));

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error(`VSPod state directory must be private and owned by you: ${path}`);
  }
}

export async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.pending`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readPrivate<T>(path: string, maximumBytes = 16_384): Promise<T | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error('VSPod session state is not a private, regular file owned by you.');
    }
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function withProjectLock<T>(workspace: Workspace, action: (directory: string) => Promise<T>, waitMs = 0): Promise<T> {
  const root = stateDirectory();
  await privateDirectory(root);
  const directory = join(root, workspace.id);
  await privateDirectory(directory);
  const lock = join(directory, 'operation.lock');
  const formatPath = join(directory, 'lock-format.json');
  const format = await readPrivate<{ version: number }>(formatPath);
  const existing = await lstat(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid?.())) {
    throw new Error('Workspace operation lock has an unsafe owner or file type. It was not changed.');
  }
  if (existing && format?.version !== 2) {
    throw new Error(`A legacy VSPod lock exists at ${lock}. Check that no older VSPod command is running before removing that lock directory.`);
  }
  if (format && format.version !== 2) throw new Error('Unsupported workspace lock format. Update VSPod before continuing.');
  if (!format) await writePrivate(formatPath, { version: 2 });
  const deadline = Date.now() + waitMs;
  const signal = operationSignal();
  const lease = new AbortController();
  const linkedSignal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
  let release: (() => Promise<void>) | undefined;
  let compromised: Error | undefined;
  while (true) {
    signal?.throwIfAborted();
    try {
      release = await lockfile.lock(directory, {
        lockfilePath: lock, realpath: false, stale: 30_000, update: 10_000,
        onCompromised: (error) => { compromised = error; lease.abort(error); },
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      if (Date.now() >= deadline) {
        throw new Error('Another VSPod operation is active for this repository. Wait for it to finish and retry; crashed heartbeat locks recover after 30 seconds.');
      }
      await delay(50, undefined, { signal });
    }
  }
  try {
    const result = await withCancellation(linkedSignal, () => action(directory));
    if (compromised) throw compromised;
    return result;
  } finally {
    try { await release(); } catch (error) { if (!compromised) throw error; }
  }
}