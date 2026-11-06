import { randomBytes } from 'node:crypto';
import { DockerRuntime, type DockerEnvironment } from '@vspod/docker';
import { resolveConfiguration } from '@vspod/config';
import type { EditorBackend, EditorSession, RuntimeConfiguration } from '@vspod/core/backend';
import type { ContainerRuntime, RuntimeInstance } from '@vspod/core/runtime';
import { editorUrl, waitForReady } from '@vspod/core/readiness';
import { execute } from '@vspod/core/process';
import { VspodError } from '@vspod/core';
import type { Workspace } from '@vspod/workspace';
import type { CachedExtensionArtifact, ExtensionRuntimeAdapter } from '@vspod/extensions';

export const CODE_SERVER_ENVIRONMENT: DockerEnvironment = {
  image: 'vspod:4.106.3-node22-config-v3',
  buildDirectory: 'packages/editor-backends/images/code-server',
  volumes: ['extensions', 'settings', 'state', 'config'],
  ports: [8080],
};

function origin(instance: RuntimeInstance): string {
  const endpoint = instance.ports?.['8080'];
  if (!endpoint) throw new Error('Docker did not allocate a loopback code-server port.');
  return editorUrl(endpoint).origin;
}

export class CodeServerBackend implements EditorBackend {
  readonly id = 'code-server';
  readonly vscodeVersion = '1.106.3';

  constructor(readonly runtime: ContainerRuntime = new DockerRuntime(CODE_SERVER_ENVIRONMENT)) {}

  async start(workspace: Workspace, configuration: RuntimeConfiguration = resolveConfiguration()): Promise<EditorSession> {
    const password = randomBytes(32).toString('hex');
    const instance = await this.runtime.start(workspace);
    await execute('docker', ['exec', '-i', workspace.containerName, 'node', '/opt/vspod/configure.mjs'], {
      input: JSON.stringify({ password, configuration }),
    });
    return {
      backend: this.id, containerId: instance.id, startedAt: instance.startedAt ?? '',
      presentation: { kind: 'web', origin: origin(instance), authentication: { kind: 'password', password } },
    };
  }

  resume(instance: RuntimeInstance, session: EditorSession | undefined): EditorSession {
    if (!session || session.backend !== this.id || !instance.running ||
        session.containerId !== instance.id || session.startedAt !== instance.startedAt ||
        session.presentation?.kind !== 'web' || session.presentation.authentication?.kind !== 'password' ||
        typeof session.presentation.authentication.password !== 'string' ||
        !/^[a-f0-9]{64}$/.test(session.presentation.authentication.password)) {
      throw new VspodError('SESSION_UNAVAILABLE', 'The running workspace has no matching code-server session.',
        'Run vspod stop, then vspod open. Settings and extensions are retained.');
    }
    return { ...session, presentation: { ...session.presentation, origin: origin(instance) } };
  }

  async waitForReady(workspace: Workspace, session: EditorSession): Promise<void> {
    const instance = await this.runtime.inspect(workspace);
    if (!instance) throw new Error('Code-server container disappeared before readiness.');
    const current = this.resume(instance, session);
    if (current.presentation.kind !== 'web') throw new Error('Expected code-server web presentation.');
    await waitForReady(this.runtime, workspace, current.presentation.origin);
  }

  extensionAdapter(workspace: Workspace): ExtensionRuntimeAdapter {
    const run = async (command: string[], artifact?: CachedExtensionArtifact): Promise<string> => {
      if (artifact && /[\r\n,]/.test(artifact.cachePath)) throw new Error('Extension cache paths containing commas or newlines are not supported.');
      return execute('docker', [
        'run', '--rm', '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--network', 'none', '--read-only',
        '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/config',
        '--pids-limit', '128', '--memory', '512m', '--cpus', '2',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
        '--mount', `type=volume,source=${workspace.containerName}-extensions,target=/vspod/extensions`,
        ...(artifact ? ['--mount', `type=bind,source=${artifact.cachePath},target=/tmp/artifact.vsix,readonly`] : []),
        '--entrypoint', '/usr/bin/code-server', CODE_SERVER_ENVIRONMENT.image,
        '--config', '/opt/vspod/extensions.yml',
        '--user-data-dir', '/tmp/user-data', '--extensions-dir', '/vspod/extensions',
        '--disable-telemetry', '--disable-update-check', ...command,
      ], { timeout: 300_000 });
    };
    return {
      list: async () => {
        const output = await run(['--list-extensions', '--show-versions']);
        return output.split(/\r?\n/).filter(Boolean).map((line) => {
          const match = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)@([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)$/i.exec(line.trim());
          if (!match) throw new Error('The editor returned an invalid installed-extension list.');
          return { id: match[1].toLowerCase(), version: match[2] };
        });
      },
      install: async (artifact) => { await run(['--install-extension', '/tmp/artifact.vsix', '--force'], artifact); },
      uninstall: async (id) => { await run(['--uninstall-extension', id]); },
    };
  }
}
