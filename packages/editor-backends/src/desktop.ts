import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerAppRunner, type AppLaunchSpec, type HostIntegrations } from '@vspod/app-runner';
import { DockerRuntime, environmentContainerName, type DockerEnvironment } from '@vspod/docker';
import type { EditorBackend, EditorSession, RuntimeConfiguration } from '@vspod/core/backend';
import type { RuntimeInstance } from '@vspod/core/runtime';
import { installationRoot } from '@vspod/core/installation';
import { execute, operationSignal } from '@vspod/core/process';
import { VspodError } from '@vspod/core';
import { readPrivate, stateDirectory } from '@vspod/core/state';
import { nativeAttachment } from '@vspod/core/native';
import type { Workspace } from '@vspod/workspace';
import type { ExtensionRuntimeAdapter } from '@vspod/extensions';

export const DESKTOP_ENVIRONMENT: DockerEnvironment = {
  image: 'vspod-desktop:1.106.3-node22-v1',
  buildDirectory: 'packages/editor-backends/images/desktop',
  containerSuffix: '-desktop',
  volumes: ['extensions', 'settings', 'state', 'config'],
  ports: [],
};
export const DESKTOP_INTEGRATIONS: HostIntegrations = { clipboard: true, files: true, externalUrls: true };
export const desktopContainerName = (workspace: Workspace) => environmentContainerName(workspace, DESKTOP_ENVIRONMENT);

export async function desktopSeccompPolicy(environment = process.env, root = installationRoot()): Promise<string> {
  const policy = environment.VSPOD_DESKTOP_SECCOMP ??
    join(root, 'packages/editor-backends/security/desktop-renderer-seccomp.json');
  const invalid = () => new VspodError('DESKTOP_SECCOMP_INVALID', 'The desktop renderer seccomp policy is unavailable or invalid.',
    'Restore the bundled policy, or set VSPOD_DESKTOP_SECCOMP to an existing absolute profile path. Unset the variable to use the bundled default. Unconfined seccomp is not supported.');
  if (!isAbsolute(policy) || /[\0\r\n]/.test(policy)) throw invalid();
  let info;
  try { info = await lstat(policy); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw invalid();
    throw error;
  }
  if (!info.isFile()) throw invalid();
  return policy;
}

export function desktopLaunchSpec(workspace: Workspace, seccompProfile: string): AppLaunchSpec {
  const name = desktopContainerName(workspace);
  return {
    id: name, image: DESKTOP_ENVIRONMENT.image, command: ['/usr/local/bin/node', '/opt/vspod/bootstrap.mjs'],
    workdir: '/workspace', seccompProfile,
    mounts: [
      { kind: 'bind', source: workspace.root, target: '/workspace' },
      ...DESKTOP_ENVIRONMENT.volumes.map((kind) => ({
        kind: 'volume' as const, source: `${name}-${kind}`, target: `/vspod/${kind}`,
      })),
    ],
    resources: { cpus: 4, memoryMiB: 4096, pids: 512, shmMiB: 256, tmpMiB: 1024 },
    scale: 2, exportRoots: ['/workspace'], integrations: DESKTOP_INTEGRATIONS, electronMenuNudge: true,
  };
}

export class DesktopRuntime extends DockerRuntime {
  constructor(readonly runner = new DockerAppRunner()) { super(DESKTOP_ENVIRONMENT); }

  protected override assertOwnership(workspace: Workspace, labels: Record<string, string>): void {
    if (labels['dev.vspod.app-runner'] !== desktopContainerName(workspace)) {
      throw new Error('The desktop container is not owned by the application runner. It was not changed.');
    }
  }

  protected override async createContainer(workspace: Workspace): Promise<void> {
    const policy = await desktopSeccompPolicy();
    await this.runner.create(desktopLaunchSpec(workspace, policy));
  }

  override async ensureImage(options: { rebuild?: boolean } = {}): Promise<void> {
    if (!options.rebuild) {
      try { await execute('docker', ['image', 'inspect', this.environment.image]); return; }
      catch { operationSignal()?.throwIfAborted(); }
    }
    const root = installationRoot();
    await execute('docker', ['build', '-t', 'vspod-app-runner:dev', '-f',
      join(root, 'packages/app-runner/guest/Dockerfile'), join(root, 'packages/app-runner')],
    { inherit: true, timeout: 900_000 });
    await execute('docker', ['build', '-t', this.environment.image, '-f',
      join(root, this.environment.buildDirectory, 'Dockerfile'), root], { inherit: true, timeout: 900_000 });
  }
}

export class DesktopBackend implements EditorBackend {
  readonly id = 'desktop';
  readonly vscodeVersion = '1.106.3';
  constructor(readonly runtime = new DesktopRuntime()) {}

  readonly nativePresenter = {
    check: async () => {
      if (process.platform !== 'darwin') throw new Error('The desktop backend currently requires macOS.');
      try { await access(join(installationRoot(), 'packages/app-runner/dist/app-host')); }
      catch { throw new Error('Build the native helper first: npm run build:host --workspace @vspod/app-runner'); }
      await desktopSeccompPolicy();
    },
    launch: (directory: string) => {
      const entry = join(installationRoot(), 'bin/vspod.mjs');
      const log = openSync(join(directory, 'supervisor.log'), 'ax', 0o600);
      try {
        return spawn(process.execPath, [entry, '__present-native', directory], { stdio: ['ignore', log, log], detached: true });
      } finally { closeSync(log); }
    },
    openFolder: async (workspace: Workspace, folder: string, newWindow: boolean, restricted: boolean) => {
      if (!folder.startsWith('/workspace') || (folder !== '/workspace' && !folder.startsWith('/workspace/'))) {
        throw new Error('Native folder must be inside the workspace mount.');
      }
      const userData = restricted ? '/tmp/restricted-user-data' : '/vspod/state/user-data';
      await execute('docker', ['exec', desktopContainerName(workspace), '/opt/vscode/bin/code',
        '--ozone-platform=wayland', '--disable-gpu',
        '--user-data-dir', userData, '--extensions-dir', restricted ? '/tmp/restricted-extensions' : '/vspod/extensions',
        newWindow ? '--new-window' : '--reuse-window', folder]);
    },
  };

  async start(workspace: Workspace, configuration: RuntimeConfiguration): Promise<EditorSession> {
    const instance = await this.runtime.start(workspace);
    await execute('docker', ['exec', '-i', desktopContainerName(workspace), 'node', '/opt/vspod/configure.mjs'],
      { input: JSON.stringify(configuration) });
    return {
      backend: this.id, containerId: instance.id, startedAt: instance.startedAt ?? '',
      presentation: { kind: 'native', sessionId: desktopContainerName(workspace) },
    };
  }

  resume(instance: RuntimeInstance, session: EditorSession | undefined): EditorSession {
    if (!session || session.backend !== this.id || !instance.running ||
        session.containerId !== instance.id || session.startedAt !== instance.startedAt ||
        session.presentation?.kind !== 'native' || !/^vspod-[a-f0-9]{20}-desktop$/.test(session.presentation.sessionId)) {
      throw new VspodError('SESSION_UNAVAILABLE', 'The running workspace has no matching desktop session.',
        'Run vspod stop --backend desktop, then reopen. Desktop settings and extensions are retained.');
    }
    return session;
  }

  async waitForReady(workspace: Workspace, session: EditorSession): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const instance = await this.runtime.inspect(workspace);
      if (!instance?.running) throw new VspodError('DESKTOP_GUEST_EXITED', 'The desktop container exited before readiness.',
        'Run vspod logs --backend desktop, then reopen. Your persistent volumes are retained.');
      this.resume(instance, session);
      const logs = await execute('docker', ['logs', '--since', session.startedAt, desktopContainerName(workspace)]);
      if (logs.includes('APP_RUNNER_READY')) return;
      await delay(100, undefined, { signal: operationSignal() });
    }
    throw new VspodError('DESKTOP_READY_TIMEOUT', 'Desktop did not map a Wayland window within 60 seconds.',
      'Run vspod logs --backend desktop, then vspod stop --backend desktop before retrying. Persistent volumes are retained.');
  }

  async diagnose(workspace: Workspace): Promise<readonly { name: string; detail: string; healthy: boolean }[]> {
    const root = join(stateDirectory(), workspace.id);
    const instance = await this.runtime.inspect(workspace);
    const results = [{ name: 'Desktop container', healthy: instance?.compatible !== false,
      detail: instance ? `${instance.running ? 'running' : 'stopped'}; ${instance.id}; started ${instance.startedAt}; ${instance.image}` : 'not created' }];
    if (instance?.running) {
      try {
        this.resume(instance, await readPrivate<EditorSession>(join(root, 'desktop/runtime.json')));
        results.push({ name: 'Desktop session', healthy: true, detail: 'matches the running container generation' });
      } catch (error) {
        results.push({ name: 'Desktop session', healthy: false,
          detail: `${error instanceof Error ? error.message : 'Invalid session'} Stop with vspod stop --backend desktop, then reopen.` });
      }
    }
    const { attachment, locked } = await nativeAttachment(root);
    if (attachment) {
      const directory = join(root, attachment.directory);
      const ack = await readPrivate<{ stage: string; message?: string }>(join(directory, 'ack.json'));
      const generationMatches = !instance?.running || attachment.runtimeSession === `${instance.id}/${instance.startedAt}`;
      results.push({ name: 'Native attachment', healthy: generationMatches && ack?.stage !== 'error' && (!locked || ack?.stage === 'editor-ready'),
        detail: `${locked ? 'owned' : 'detached/stale'}; ${ack?.stage ?? 'no acknowledgement'}${ack?.message ? `; ${ack.message}` : ''}. Logs: ${join(directory, 'host.log')} and ${join(directory, 'supervisor.log')}` });
    } else results.push({ name: 'Native attachment', healthy: !locked, detail: locked ? 'starting; retry after startup finishes' : 'none; open attaches a new host' });
    return results;
  }

  extensionAdapter(workspace: Workspace): ExtensionRuntimeAdapter {
    const run = async (command: string[], artifact?: { cachePath: string }) => {
      if (artifact && /[\r\n,]/.test(artifact.cachePath)) throw new Error('Unsupported extension cache path.');
      return execute('docker', ['run', '--rm', '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--network', 'none', '--read-only',
        '--env', 'HOME=/tmp', '--pids-limit', '128', '--memory', '512m', '--cpus', '2',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
        '--mount', `type=volume,source=${desktopContainerName(workspace)}-extensions,target=/vspod/extensions`,
        ...(artifact ? ['--mount', `type=bind,source=${artifact.cachePath},target=/tmp/artifact.vsix,readonly`] : []),
        '--entrypoint', '/opt/vscode/bin/code', DESKTOP_ENVIRONMENT.image,
        '--user-data-dir', '/tmp/user-data', '--extensions-dir', '/vspod/extensions', ...command,
      ], { timeout: 300_000 });
    };
    return {
      list: async () => (await run(['--list-extensions', '--show-versions'])).split(/\r?\n/).filter(Boolean).map((line) => {
        const match = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)@([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)$/i.exec(line.trim());
        if (!match) throw new Error('Desktop returned an invalid installed-extension list.');
        return { id: match[1].toLowerCase(), version: match[2] };
      }),
      install: async (artifact) => { await run(['--install-extension', '/tmp/artifact.vsix', '--force'], artifact); },
      uninstall: async (id) => { await run(['--uninstall-extension', id]); },
    };
  }
}
