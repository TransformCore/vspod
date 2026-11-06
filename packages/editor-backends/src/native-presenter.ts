import { createWriteStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerAppRunner } from '@vspod/app-runner';
import { privateDirectory, readPrivate, writePrivate } from '@vspod/core/state';
import type { EditorPresentation } from '@vspod/core/backend';
import { DESKTOP_INTEGRATIONS, nativeHostBinary } from './desktop.ts';
import { acquireNativeAttachment } from '@vspod/core/native';
import { explainError, VspodError, stopAfterLastWindow } from '@vspod/core';
import { DesktopBackend } from './desktop.ts';

/** Separate supervisor keeps host IPC alive after the opening CLI exits. */
export async function presentNative(directory: string): Promise<void> {
  await privateDirectory(directory);
  const ackPath = join(directory, 'ack.json');
  const log = createWriteStream(join(directory, 'host.log'), { flags: 'a', mode: 0o600 });
  let host: Awaited<ReturnType<DockerAppRunner['attach']>> | undefined;
  let exited = false, closing = false, framed = false;
  let failure: Error | undefined;
  let focusRequest: string | undefined;
  let closeDeadline: number | undefined;
  let release: (() => Promise<void>) | undefined;
  let compromised = false;
  let runtimeSession: string | undefined, container: string | undefined;
  let stopOnClose = false;
  const runner = new DockerAppRunner();
  let nextProbe = 0;
  const stop = () => {
    closing = true;
    closeDeadline ??= Date.now() + 2_000;
    if (host && !exited) host.stdin?.write('{"action":"stop"}\n');
  };
  log.on('error', (error) => { failure = error; stop(); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await writePrivate(ackPath, { stage: 'starting', pid: process.pid });
    let deadline = Date.now() + 1_200_000;
    while (!host && !closing) {
      if (failure) throw failure;
      const request = await readPrivate<{ id: string; action: string }>(join(directory, 'request.json'));
      if (request?.action === 'close' && /^[a-f0-9]{24}$/.test(request.id)) {
        await writePrivate(ackPath, { stage: 'closed', pid: process.pid });
        await writePrivate(join(directory, 'response.json'), { id: request.id });
        return;
      }
      const session = await readPrivate<{ status: string; backend: string; runtimeSession?: string; stopOnClose?: boolean; presentation?: EditorPresentation }>(join(directory, 'session.json'));
      if (session?.status === 'error') throw new Error('Workspace activation failed before native attachment.');
      if (session?.status === 'ready') {
        if (session.backend !== 'desktop' || session.presentation?.kind !== 'native' ||
            !/^vspod-[a-f0-9]{20}-desktop$/.test(session.presentation.sessionId) ||
            typeof session.runtimeSession !== 'string' || !session.runtimeSession) {
          throw new Error('Invalid desktop presentation session.');
        }
        release = await acquireNativeAttachment(dirname(directory), (error) => { compromised = true; failure = error; stop(); });
        runtimeSession = session.runtimeSession;
        stopOnClose = session.stopOnClose === true;
        if (stopOnClose) await writePrivate(join(directory, 'lifetime-ack.json'), { stage: 'watching', pid: process.pid });
        container = session.presentation.sessionId;
        const instance = await runner.inspect(container);
        if (!instance?.running || `${instance.id}/${instance.startedAt}` !== runtimeSession) {
          throw new VspodError('NATIVE_GENERATION_CHANGED', 'The desktop container changed before native attachment.',
            'Run vspod stop --backend desktop, then reopen. No host was attached to the wrong generation.');
        }
        await writePrivate(join(dirname(directory), 'desktop/attachment.json'), {
          directory: basename(directory), runtimeSession,
        });
        host = await runner.attach(nativeHostBinary(),
          directory, { container: session.presentation.sessionId, protocol: 'wayland', integrations: DESKTOP_INTEGRATIONS },
          { stderr: 'pipe' });
        deadline = Date.now() + 60_000;
        host.once('error', (error) => { failure = error; exited = true; });
        host.once('exit', (code) => {
          exited = true;
          if (code !== 0 && !closing) failure = new VspodError('NATIVE_HOST_EXITED',
            `Native host exited (${code ?? 'signal'}).`, `Inspect ${join(directory, 'host.log')}, then reopen. The container and volumes were not removed.`);
        });
        host.stderr?.pipe(log, { end: false });
        host.stdin?.on('error', (error) => { if (!closing) { failure = error; stop(); } });
        if (!host.stdout) throw new Error('Native host has no readiness stream.');
        const lines = createInterface({ input: host.stdout });
        lines.on('error', (error) => { failure = error; stop(); });
        lines.on('line', (line) => {
          log.write(`${line}\n`);
          if (line.startsWith('WINDOW_FRAME ')) framed = true;
          if (line === 'WINDOW_FOCUSED' && focusRequest) {
            const id = focusRequest;
            focusRequest = undefined;
            void writePrivate(join(directory, 'response.json'), { id }).catch((error: Error) => { failure = error; stop(); });
          }
        });
        if (closing) stop();
      } else {
        if (Date.now() > deadline) throw new Error('Native presentation activation timed out.');
        await delay(50);
      }
    }
    let acknowledged = false, handled: string | undefined;
    while (host && !exited) {
      if (failure) throw failure;
      if (!closing && container && Date.now() >= nextProbe) {
        nextProbe = Date.now() + 2_000;
        const instance = await runner.inspect(container);
        if (!instance?.running || `${instance.id}/${instance.startedAt}` !== runtimeSession) {
          throw new VspodError('NATIVE_GUEST_EXITED', 'The desktop container stopped or changed generation.',
            'Run vspod logs --backend desktop, then reopen. If Docker restarted the container externally, stop it through VSPod before reopening. Persistent volumes are retained.');
        }
      }
      if (closing && closeDeadline && Date.now() > closeDeadline) {
        host.kill('SIGTERM');
        throw new Error('Native host did not acknowledge detaching within two seconds.');
      }
      if (framed && !acknowledged) {
        await writePrivate(ackPath, { stage: 'editor-ready', pid: process.pid, hostPid: host.pid });
        acknowledged = true;
      }
      if (!acknowledged && Date.now() > deadline) throw new Error('Native host did not present a window.');
      const request = await readPrivate<{ id: string; action: string }>(join(directory, 'request.json'));
      if (request && request.id !== handled) {
        if (!/^[a-f0-9]{24}$/.test(request.id) || !['focus', 'close'].includes(request.action)) {
          throw new Error('Invalid native window lifecycle request.');
        }
        handled = request.id;
        if (request.action === 'close') stop();
        else { focusRequest = request.id; host.stdin?.write('{"action":"focus"}\n'); }
      }
      await delay(50);
    }
    if (failure) throw failure;
    await writePrivate(ackPath, { stage: 'closed', pid: process.pid });
    if (handled && closing) await writePrivate(join(directory, 'response.json'), { id: handled });
    if (release && !compromised) {
      await release();
      release = undefined;
    }
    if (stopOnClose && framed) {
      const stopped = await stopAfterLastWindow(new DesktopBackend(), directory);
      await writePrivate(join(directory, 'lifetime-ack.json'), { stage: 'closed', stopped });
    }
  } catch (error) {
    const explanation = explainError(error);
    await writePrivate(ackPath, { stage: 'error', message: explanation.title, code: explanation.code, hint: explanation.hint });
    if (stopOnClose) await writePrivate(join(directory, 'lifetime-ack.json'), { stage: 'error', ...explanation });
    throw error;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (host && !exited) {
      stop();
      const deadline = Date.now() + 3_000;
      while (!exited && Date.now() < deadline) await delay(50);
      if (!exited) {
        host.kill('SIGKILL');
        await new Promise<void>((resolve) => host!.once('exit', () => resolve()));
      }
    }
    try {
      if (release && !compromised) await release();
    } finally {
      log.end();
    }
  }
}
