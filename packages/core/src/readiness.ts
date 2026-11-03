import { setTimeout as delay } from 'node:timers/promises';
import type { ContainerRuntime } from './runtime.ts';
import type { Workspace } from '@vspod/workspace';
import { operationSignal } from './process.ts';

export function editorUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Expected a credential-free, literal loopback editor origin with an explicit port.');
  }
  return url;
}

export async function waitForReady(runtime: ContainerRuntime, workspace: Workspace, value: string): Promise<void> {
  const url = editorUrl(value);
  const deadline = Date.now() + 120_000;
  const signal = operationSignal();
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!(await runtime.inspect(workspace))?.running) throw new Error('Editor container exited. Run vspod logs for details.');
    try {
      const timeout = AbortSignal.timeout(2_000);
      const response = await fetch(new URL('/healthz', url), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (response.ok) return;
    } catch { /* The editor may still be starting. */ }
    await delay(200, undefined, { signal });
  }
  throw new Error('Editor did not become ready within 120 seconds. Run vspod logs for details.');
}