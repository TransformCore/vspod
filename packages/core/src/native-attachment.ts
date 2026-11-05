import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { privateDirectory, readPrivate, writePrivate } from './state.ts';
import { VspodError } from './errors.ts';

export interface NativeAttachment {
  directory: string;
  runtimeSession: string;
}

async function attachmentPaths(root: string, create = false) {
  const directory = join(root, 'desktop');
  if (create) await privateDirectory(directory);
  const lock = join(directory, 'attachment.lock');
  try {
    const info = await lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
      throw new Error('Native attachment lock has an unsafe owner or file type.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { directory, lock };
}

export async function nativeAttachment(root: string): Promise<{ attachment?: NativeAttachment; locked: boolean }> {
  const { directory, lock } = await attachmentPaths(root);
  const attachment = await readPrivate<NativeAttachment>(join(directory, 'attachment.json'));
  if (attachment && (!/^launch-[a-zA-Z0-9]+$/.test(attachment.directory) ||
      typeof attachment.runtimeSession !== 'string' || !attachment.runtimeSession)) {
    throw new Error('Invalid native attachment metadata.');
  }
  return { attachment, locked: await lockfile.check(directory, { lockfilePath: lock, realpath: false, stale: 5_000 }) };
}

export async function acquireNativeAttachment(root: string, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
  const { directory, lock } = await attachmentPaths(root, true);
  try {
    return await lockfile.lock(directory, {
      lockfilePath: lock, realpath: false, stale: 5_000, update: 1_000, onCompromised,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
    throw new VspodError('NATIVE_ATTACHMENT_BUSY', 'Another native host owns this desktop workspace.',
      'Use vspod quit before attaching again. After a supervisor crash, wait five seconds and retry; no live attachment was replaced.');
  }
}

export async function requestNativeAttachment(root: string, action: 'focus' | 'close', runtimeSession?: string): Promise<string | undefined> {
  const { attachment, locked } = await nativeAttachment(root);
  if (!locked) return undefined;
  if (!attachment) throw new VspodError('NATIVE_ATTACHMENT_BUSY', 'A native attachment is starting.',
    'Wait for the other open operation to finish, then retry.');
  if (runtimeSession && attachment.runtimeSession !== runtimeSession) {
    throw new VspodError('NATIVE_GENERATION_CHANGED', 'The native host belongs to an earlier container session.',
      'Run vspod stop --backend desktop, then reopen. No host was attached to the wrong generation.');
  }
  const directory = join(root, attachment.directory);
  const id = randomBytes(12).toString('hex');
  await writePrivate(join(directory, 'request.json'), { id, action });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const response = await readPrivate<{ id: string }>(join(directory, 'response.json'));
    if (response?.id === id && (action !== 'close' || !(await nativeAttachment(root)).locked)) return directory;
    if (!(await nativeAttachment(root)).locked) return action === 'close' ? directory : undefined;
    await delay(50);
  }
  throw new VspodError('NATIVE_ATTACHMENT_UNRESPONSIVE', `The native host did not acknowledge ${action}.`,
    `Inspect ${join(directory, 'host.log')} and ${join(directory, 'supervisor.log')}. Close the native host and retry; VSPod will not steal a live attachment.`);
}
