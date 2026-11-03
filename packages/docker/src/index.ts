import { join } from 'node:path';
import { installationRoot } from '@vspod/core/installation';
import { randomBytes } from 'node:crypto';
import { waitForReady } from '@vspod/core';
import { setTimeout as delay } from 'node:timers/promises';
import { execute, attached, operationSignal } from '@vspod/core/process';
import type { ContainerRuntime, RuntimeInstance, RuntimeConfiguration } from '@vspod/core/runtime';
import type { Workspace } from '@vspod/workspace';
import { resolveConfiguration } from '@vspod/config';
import type { CachedExtensionArtifact, ExtensionRuntimeAdapter } from '@vspod/extensions';

export const IMAGE = 'vspod:4.106.3-node22-config-v2';
export const OWNER = 'dev.vspod.project';

export function assertLocalEndpoint(endpoint: string): void {
  if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) {
    throw new Error('Remote runtimes are not supported. Select a local Unix-socket Docker context.');
  }
}

export async function effectiveDockerEndpoint(
  environment: NodeJS.ProcessEnv,
  inspectContext: (name?: string) => Promise<string>,
): Promise<string> {
  if (environment.DOCKER_CONTEXT) return inspectContext(environment.DOCKER_CONTEXT);
  return environment.DOCKER_HOST ?? inspectContext();
}

export function createArguments(workspace: Workspace): string[] {
  if (/[\r\n,]/.test(workspace.root)) throw new Error('Repository paths containing commas or newlines are not supported by this spike.');
  return [
    'create', '--name', workspace.containerName,
    '--label', `${OWNER}=${workspace.id}`,
    '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--publish', '127.0.0.1::8080',
    '--mount', `type=bind,source=${workspace.root},target=/workspace`,
    ...['extensions', 'settings', 'state', 'config'].flatMap((kind) => [
      '--mount', `type=volume,source=${workspace.containerName}-${kind},target=/vspod/${kind}`,
    ]),
    '--tmpfs', '/run/vspod:rw,noexec,nosuid,size=1m,uid=1000,gid=1000,mode=0700',
    '--workdir', '/workspace', IMAGE,
  ];
}

interface DockerInspection {
  Id: string;
  Config: { Labels: Record<string, string>; Image: string };
  State: { Running: boolean; StartedAt: string };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
}

export class DockerRuntime implements ContainerRuntime {
  async ensureAvailable(startProvider = false): Promise<void> {
    const endpoint = await effectiveDockerEndpoint(process.env, async (name) => {
      const contexts = JSON.parse(await execute('docker', ['context', 'inspect', ...(name ? [name] : [])]));
      return contexts[0]?.Endpoints?.docker?.Host ?? '';
    });
    assertLocalEndpoint(endpoint ?? '');
    const probe = () => execute('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
    try { await probe(); return; } catch {
      operationSignal()?.throwIfAborted();
      if (!startProvider || process.platform !== 'darwin') {
        throw new Error('Docker is unavailable. Start Docker Desktop and run vspod open again.');
      }
    }
    await execute('open', ['-a', 'Docker']);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try { await probe(); return; } catch {
        operationSignal()?.throwIfAborted();
        await delay(500, undefined, { signal: operationSignal() });
      }
    }
    throw new Error('Docker Desktop did not become ready within 120 seconds. Check Docker Desktop and retry.');
  }

  async ensureImage(options: { rebuild?: boolean } = {}): Promise<void> {
    if (!options.rebuild) {
      try { await execute('docker', ['image', 'inspect', IMAGE]); return; } catch { operationSignal()?.throwIfAborted(); }
    }
    await execute('docker', ['build', '--tag', IMAGE, join(installationRoot(), 'packages/docker/image')], {
      inherit: true, timeout: 900_000,
    });
  }

  async inspect(workspace: Workspace): Promise<RuntimeInstance | undefined> {
    const matches = await execute('docker', ['container', 'ls', '-a', '--filter', `name=^/${workspace.containerName}$`, '--format', '{{.ID}}']);
    if (!matches) return undefined;
    const item = (JSON.parse(await execute('docker', ['inspect', workspace.containerName])) as DockerInspection[])[0];
    if (item.Config.Labels[OWNER] !== workspace.id) {
      throw new Error(`Container ${workspace.containerName} is not owned by VSPod. It was not changed.`);
    }
    const bindings = item.NetworkSettings.Ports['8080/tcp'];
    if (item.State.Running && (!bindings || bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1')) {
      throw new Error('Refusing an editor endpoint that is not published exclusively on 127.0.0.1.');
    }
    return { id: item.Id, running: item.State.Running, startedAt: item.State.StartedAt, image: item.Config.Image, compatible: item.Config.Image === IMAGE, url: bindings?.[0] ? `http://127.0.0.1:${bindings[0].HostPort}` : undefined };
  }

  async create(workspace: Workspace): Promise<void> {
    for (const kind of ['extensions', 'settings', 'state', 'config']) {
      const name = `${workspace.containerName}-${kind}`;
      const existing = await execute('docker', ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
      if (existing) {
        const [volume] = JSON.parse(await execute('docker', ['volume', 'inspect', name]));
        if (volume.Labels?.[OWNER] !== workspace.id) throw new Error(`Volume ${name} is not owned by VSPod; it was not mounted.`);
      } else {
        await execute('docker', ['volume', 'create', '--label', `${OWNER}=${workspace.id}`, name]);
      }
    }
    await execute('docker', createArguments(workspace));
  }

  async start(workspace: Workspace, credential: string, configuration: RuntimeConfiguration = resolveConfiguration()): Promise<RuntimeInstance> {
    if (!/^[a-f0-9]{64}$/.test(credential)) throw new Error('Invalid runtime credential.');
    await execute('docker', ['start', workspace.containerName]);
    await execute('docker', ['exec', '-i', workspace.containerName, 'node', '/opt/vspod/configure.mjs'], {
      input: JSON.stringify({ password: credential, configuration }),
    });
    const instance = await this.inspect(workspace);
    if (!instance?.url) throw new Error('Docker did not allocate a loopback editor port.');
    return instance;
  }

  async stop(workspace: Workspace): Promise<void> {
    const instance = await this.inspect(workspace);
    if (instance?.running) await execute('docker', ['stop', '--time', '10', workspace.containerName]);
  }

  async runStartupTask(workspace: Workspace, command: string): Promise<void> {
    await execute('docker', ['exec', '-i', '--user', '1000:1000', '--workdir', '/workspace',
      workspace.containerName, '/bin/sh', '-es'], { input: command, timeout: 600_000 });
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
        '--entrypoint', '/usr/bin/code-server', IMAGE,
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

  async replace(workspace: Workspace, credential: string, configuration?: RuntimeConfiguration): Promise<RuntimeInstance> {
    const previous = await this.inspect(workspace);
    if (!previous) throw new Error('No workspace exists to upgrade. Run vspod open first.');
    const backup = `${workspace.containerName}-previous-${randomBytes(4).toString('hex')}`;
    await this.stop(workspace);
    await execute('docker', ['rename', workspace.containerName, backup]);
    let created = false;
    let replacement: RuntimeInstance;
    try {
      await this.create(workspace);
      created = true;
      replacement = await this.start(workspace, credential, configuration);
      await waitForReady(this, workspace, replacement.url!);
    } catch (error) {
      if (created) await execute('docker', ['rm', '-f', workspace.containerName]);
      await execute('docker', ['rename', backup, workspace.containerName]);
      if (previous.running) await this.start(workspace, credential);
      throw new Error(`The upgrade did not finish. The previous container was restored; persistent volumes were retained. ${error instanceof Error ? error.message : ''}`);
    }
    try { await execute('docker', ['rm', backup]); } catch {
      console.warn(`Upgrade succeeded. The stopped recovery container ${backup} was retained because cleanup failed.`);
    }
    return replacement;
  }

  async remove(workspace: Workspace): Promise<void> {
    if (await this.inspect(workspace)) {
      await this.stop(workspace);
      await execute('docker', ['rm', workspace.containerName]);
    }
  }

  async removeTestVolumes(workspace: Workspace): Promise<void> {
    if (!workspace.name.startsWith('vspod-test-')) throw new Error('Only temporary test volumes may be deleted by the spike.');
    for (const kind of ['extensions', 'settings', 'state', 'config']) {
      const name = `${workspace.containerName}-${kind}`;
      const [volume] = JSON.parse(await execute('docker', ['volume', 'inspect', name]));
      if (volume.Labels?.[OWNER] !== workspace.id) throw new Error('Refusing to delete an unowned volume.');
      await execute('docker', ['volume', 'rm', name]);
    }
  }

  async exec(workspace: Workspace, command: string[], interactive = false): Promise<number> {
    if (!(await this.inspect(workspace))?.running) throw new Error('Workspace is stopped. Run vspod open first.');
    return attached('docker', ['exec', ...(interactive ? [process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i'] : []), '--workdir', '/workspace', workspace.containerName, ...command]);
  }

  async logs(workspace: Workspace, follow = false): Promise<number> {
    if (!await this.inspect(workspace)) throw new Error('No workspace container exists. Run vspod open first.');
    return attached('docker', ['logs', '--tail', '100', ...(follow ? ['--follow'] : []), workspace.containerName]);
  }
}