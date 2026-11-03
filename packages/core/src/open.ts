import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopCommand, desktopInstallation } from './installation.ts';
import { editorUrl, waitForReady } from './readiness.ts';
import { readPrivate, withProjectLock, writePrivate } from './state.ts';
import { focusFolder, recentFolders, rememberFolder } from './history.ts';
import { VspodError, explainError } from './errors.ts';
import type { ContainerRuntime, RuntimeConfiguration } from './runtime.ts';
import { resolveWorkspace } from '@vspod/workspace';
import { operationSignal, withCancellation } from './process.ts';
import { assertConfigurationActivatable, inspectConfiguration } from './configuration.ts';
import { assertWorkspaceExtensions } from './extensions.ts';

export interface StartupProgress {
  step: number;
  title: string;
  detail: string;
  state: 'working' | 'done';
  elapsedMs: number;
}

export interface OpenOptions {
  smoke?: boolean;
  newWindow?: boolean;
  onProgress?: (progress: StartupProgress) => void;
  signal?: AbortSignal;
  restricted?: boolean;
}

export interface RuntimeCredential {
  containerId: string;
  startedAt: string;
  password: string;
}

export async function assertSpikeConfiguration(root: string): Promise<void> {
  for (const candidate of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    try { await access(join(root, candidate)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new VspodError('CONFIGURATION_UNSUPPORTED', `${candidate} is not supported yet.`, 'Use a repository without devcontainer configuration. See the configuration/identity roadmap: repository activation is Phase 3, managed extensions Phase 5.');
  }
}

export async function openWorkspace(runtime: ContainerRuntime, directory: string, options: OpenOptions = {}): Promise<number | undefined> {
  options.signal?.throwIfAborted();
  const windowCancellation = new AbortController();
  const startupSignal = options.signal ? AbortSignal.any([options.signal, windowCancellation.signal]) : windowCancellation.signal;
  const start = performance.now();
  const workspace = await resolveWorkspace(directory);
  const folder = await realpath(resolve(directory));
  const suffix = relative(workspace.root, folder);
  const containerFolder = suffix ? `/workspace/${suffix}` : '/workspace';
  await assertSpikeConfiguration(workspace.root);
  const installation = desktopInstallation();
  const binary = resolve(installation.executable);
  try { await access(binary); } catch {
    throw new VspodError('DESKTOP_MISSING', 'The native app has not been built yet.', 'Run vspod setup, or npm run desktop:build from your VSPod checkout.');
  }
  return withCancellation(startupSignal, () => withProjectLock(workspace, async (state) => {
    const signal = operationSignal()!;
    const resolvedConfiguration = (await inspectConfiguration(workspace)).resolved;
    const configuration: RuntimeConfiguration = options.restricted ? {
      ...resolvedConfiguration, extensions: [], keybindings: [], startupTasks: [],
      accounts: { required: [], optional: [] }, restricted: true,
      fingerprint: createHash('sha256').update(`${resolvedConfiguration.fingerprint}:restricted`).digest('hex'),
    } : resolvedConfiguration;
    await assertConfigurationActivatable(workspace, configuration);
    const appliedPath = join(state, 'configuration.json');
    const applied = await readPrivate<{ fingerprint: string; containerId: string; startedAt?: string }>(appliedPath);
    const remembered = (await recentFolders()).find((entry) => entry.id === workspace.id && entry.folder === folder);
    let launchDirectory: string | undefined;
    let path: string | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let launchError: Error | undefined;
    let exited = false;
    let completed = false;
    let startedHere = false;
    const initial = { version: 1, id: workspace.id, name: workspace.name, folder: containerFolder, status: 'starting' };
    let current: StartupProgress = { step: 0, title: 'Opening workspace', detail: folder, state: 'working', elapsedMs: 0 };
    const report = async (step: number, title: string, detail: string, done = false) => {
      signal.throwIfAborted();
      current = { step, title, detail, state: done ? 'done' : 'working', elapsedMs: Math.round(performance.now() - start) };
      if (options.onProgress) options.onProgress(current);
      else console.log(`${title} - ${detail}`);
      signal.throwIfAborted();
      if (path) await writePrivate(path, { ...initial, ...current, message: title });
    };
    const launch = async () => {
      launchDirectory = await mkdtemp(join(state, 'launch-'));
      path = join(launchDirectory, 'session.json');
      await writePrivate(path, { ...initial, ...current, message: current.title });
      const command = desktopCommand(path, installation);
      child = spawn(command.command, command.args, { stdio: 'ignore', detached: true });
      child.once('error', (error) => { launchError = error; windowCancellation.abort(error); });
      child.once('exit', (code) => {
        exited = true;
        if (!completed) {
          if (code && !startupSignal.aborted) launchError = new Error('The native app could not start. Run vspod doctor and check your selected desktop installation.');
          windowCancellation.abort();
        }
      });
      child.unref();
    };
    const closeWindow = async () => {
      if (!child || exited) return;
      if (installation.kind === 'app' && launchDirectory) {
        await writePrivate(join(launchDirectory, 'request.json'), { id: randomBytes(12).toString('hex'), action: 'close' });
        const deadline = Date.now() + 5_000;
        while (!exited && Date.now() < deadline) {
          const ack = await readPrivate<{ stage: string }>(join(launchDirectory, 'ack.json'));
          if (ack?.stage === 'closed') break;
          await delay(50);
        }
        const ack = await readPrivate<{ stage: string }>(join(launchDirectory, 'ack.json'));
        if (!exited && ack?.stage !== 'closed') throw new Error('The native window did not acknowledge closing. Close it manually before retrying.');
      }
      child.kill('SIGTERM');
    };
    try {
      if (!remembered || options.newWindow || options.smoke) await launch();
      await report(0, 'Checking local runtime', 'Starting Docker Desktop if needed');
      await runtime.ensureAvailable(true);
      let instance = await runtime.inspect(workspace);
      if (instance?.compatible === false) {
        throw new VspodError('RUNTIME_UPDATE', 'This workspace uses an older VSPod environment.', 'Run vspod upgrade to update it explicitly. Your repository and persistent volumes will be retained.');
      }
      if (!options.restricted) await assertWorkspaceExtensions(runtime, workspace, state, configuration);
      const credentialPath = join(state, 'runtime.json');
      let credential = await readPrivate<RuntimeCredential>(credentialPath);
      if (instance?.running) {
        if (!credential || credential.containerId !== instance.id || credential.startedAt !== instance.startedAt) {
          throw new VspodError('SESSION_UNAVAILABLE', 'The running workspace has no matching session.', 'Run vspod stop, then vspod open. Settings and extensions are retained.');
        }
        if (!applied || applied.fingerprint !== configuration.fingerprint ||
            applied.containerId !== instance.id || applied.startedAt !== instance.startedAt) {
          throw new VspodError('CONFIG_RESTART_REQUIRED', 'The running editor has a different or incomplete configuration.',
            'Finish terminal work, run vspod stop, then vspod open. Running containers and windows are never silently replaced or reconfigured.');
        }
        await report(2, 'Your workspace is already warm', 'Reusing the running environment');
        if (!options.newWindow && !options.smoke && await focusFolder(workspace, folder, `${instance.id}/${instance.startedAt}`)) {
          await report(5, 'Back where you left off', folder, true);
          completed = true;
          return undefined;
        }
      } else {
        if (!path) await launch();
        if (!instance) {
          await report(1, 'Preparing your environment', 'First launch builds the editor image; later launches reuse it');
          await runtime.ensureImage();
          await runtime.create(workspace);
        }
        await report(2, 'Waking your workspace', 'Your settings and extensions stay with this repository');
        const password = randomBytes(32).toString('hex');
        startedHere = true;
        instance = await runtime.start(workspace, password, configuration);
        credential = { containerId: instance.id, startedAt: instance.startedAt ?? '', password };
        await writePrivate(credentialPath, credential);
        for (const command of configuration.startupTasks) {
          if (!runtime.runStartupTask) throw new VspodError('HOOK_RUNTIME_UNSUPPORTED', 'The runtime cannot execute approved startup tasks.', 'Use the maintained Docker runtime.');
          await report(2, 'Running approved startup task', 'Container-only, non-root; failures stop activation');
          await runtime.runStartupTask(workspace, command);
        }
      }
      if (!path) await launch();
      if (!instance.url || !credential || !path || !launchDirectory) throw new Error('Runtime did not provide an editor endpoint and session.');
      const url = editorUrl(instance.url).origin;
      await report(3, 'Connecting securely', 'Waiting for your editor to become ready');
      await waitForReady(runtime, workspace, url);
      if (startedHere) await writePrivate(appliedPath, {
        fingerprint: configuration.fingerprint, containerId: instance.id, startedAt: instance.startedAt,
      });
      await writePrivate(path, { ...initial, ...current, status: 'ready', message: current.title, url, password: credential.password });
      const deadline = Date.now() + 90_000;
      let authenticated = false;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (launchError) throw new Error(`Cannot start desktop: ${launchError.message}`);
        const ack = await readPrivate<{ stage: string; message: string }>(join(launchDirectory, 'ack.json'));
        if (ack?.stage === 'error') throw new Error(ack.message);
        if (ack?.stage === 'closed' || exited) throw new Error('Desktop closed before the editor became ready.');
        if (ack?.stage === 'authenticated' && !authenticated) {
          authenticated = true;
          await report(4, 'Opening your editor', folder);
          await writePrivate(path, { ...initial, ...current, status: 'connected', message: current.title });
        }
        if (ack?.stage === 'editor-ready') {
          if (!options.smoke) await rememberFolder(workspace, folder, launchDirectory, `${instance.id}/${instance.startedAt}`);
          await report(5, 'Ready', `${workspace.name} opened in ${((performance.now() - start) / 1000).toFixed(1)}s`, true);
          completed = true;
          if (options.smoke) await closeWindow();
          return child?.pid;
        }
        await delay(100, undefined, { signal });
      }
      throw new VspodError('EDITOR_TIMEOUT', 'The editor took too long to open.', 'Your environment is still running. Retry vspod open or inspect vspod logs.');
    } catch (error) {
      const interrupted = signal.aborted;
      const leaseLost = (signal.reason as NodeJS.ErrnoException | undefined)?.code === 'ECOMPROMISED';
      let cleanupFailed = false;
      if (interrupted && startedHere && !leaseLost) {
        try {
          await withCancellation(undefined, () => runtime.stop(workspace));
          await rm(join(state, 'runtime.json'), { force: true });
        } catch { cleanupFailed = true; }
      }
      if (interrupted) {
        try { await closeWindow(); } catch { cleanupFailed = true; }
      }
      const failure = leaseLost ? new VspodError('LOCK_LOST', 'The workspace operation lost its lock.', 'No automatic container cleanup was attempted. Check other VSPod commands, then run vspod doctor before retrying.') : interrupted && !launchError ? new VspodError('OPEN_CANCELLED', 'Opening was cancelled.', cleanupFailed
        ? 'Some startup resources could not be closed automatically. Close the loading window and run vspod stop before retrying. Your volumes were retained.'
        : 'No files or volumes were deleted. Run vspod open whenever you are ready.') : error;
      if (path) {
        const explanation = explainError(failure);
        await writePrivate(path, { ...initial, ...current, status: 'error', message: explanation.title, hint: explanation.hint });
      }
      throw failure;
    } finally {
      if (path) {
        const session = await readPrivate<{ status: string }>(path);
        if (session?.status !== 'error') await rm(path, { force: true });
      }
    }
  }, 5_000));
}

export async function stopWorkspace(runtime: ContainerRuntime, directory: string): Promise<void> {
  const workspace = await resolveWorkspace(directory);
  await withProjectLock(workspace, async (state) => {
    await runtime.ensureAvailable();
    await runtime.stop(workspace);
    await rm(join(state, 'runtime.json'), { force: true });
  });
}