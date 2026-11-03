import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

const cancellation = new AsyncLocalStorage<AbortSignal | undefined>();

export const operationSignal = (): AbortSignal | undefined => cancellation.getStore();

export function withCancellation<T>(signal: AbortSignal | undefined, action: () => T): T {
  return cancellation.run(signal, action);
}

export async function execute(command: string, args: string[], options: {
  input?: string;
  inherit?: boolean;
  timeout?: number;
  signal?: AbortSignal;
} = {}): Promise<string> {
  const signal = options.signal ?? operationSignal();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let termination: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      termination ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    const abort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeout ?? 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-2_000_000); });
    child.stderr?.on('data', (data: Buffer) => { errors = (errors + data.toString()).slice(-8_000); });
    child.stdin?.on('error', () => {});
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      if (termination) clearTimeout(termination);
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(new DOMException('Operation cancelled', 'AbortError'));
      else if (spawnError) reject(spawnError);
      else if (timedOut) reject(new Error(`${command} ${args[0] ?? ''} timed out.`));
      else if (code === 0) resolve(output.trimEnd());
      else reject(new Error(`${command} ${args[0] ?? ''} failed (${exitSignal ?? code}). ${options.input ? 'Bootstrap failed; credential output suppressed.' : errors}`));
    });
    child.stdin?.end(options.input);
  });
}

export async function attached(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    process.on('SIGINT', interrupt);
    child.once('error', (error) => { process.off('SIGINT', interrupt); reject(error); });
    child.once('close', (code) => { process.off('SIGINT', interrupt); resolve(code ?? 130); });
  });
}