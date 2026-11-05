import { join } from 'node:path';
import { installationRoot } from '@vspod/core/installation';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execute, attached, operationSignal, withCancellation } from '@vspod/core/process';
import type { ContainerRuntime, RuntimeInstance } from '@vspod/core/runtime';
import type { Workspace } from '@vspod/workspace';
export const OWNER = 'dev.vspod.project';

export interface DockerEnvironment {
  image: string;
  buildDirectory: string;
  volumes: readonly string[];
  ports: readonly number[];
  containerSuffix?: string;
}

export const environmentContainerName = (workspace: Workspace, environment: DockerEnvironment) =>
  `${workspace.containerName}${environment.containerSuffix ?? ''}`;

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

export function createArguments(workspace: Workspace, environment: DockerEnvironment): string[] {
  const name = environmentContainerName(workspace, environment);
  if (/[\r\n,]/.test(workspace.root)) throw new Error('Repository paths containing commas or newlines are not supported by this spike.');
  return [
    'create', '--name', name,
    '--label', `${OWNER}=${workspace.id}`,
    '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    ...environment.ports.flatMap((port) => ['--publish', `127.0.0.1::${port}`]),
    '--mount', `type=bind,source=${workspace.root},target=/workspace`,
    ...environment.volumes.flatMap((kind) => [
      '--mount', `type=volume,source=${name}-${kind},target=/vspod/${kind}`,
    ]),
    '--tmpfs', '/run/vspod:rw,noexec,nosuid,size=1m,uid=1000,gid=1000,mode=0700',
    '--workdir', '/workspace', environment.image,
  ];
}

interface DockerInspection {
  Id: string;
  Config: { Labels: Record<string, string>; Image: string };
  State: { Running: boolean; StartedAt: string };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
}

export class DockerRuntime implements ContainerRuntime {
  constructor(readonly environment: DockerEnvironment) {}

  protected containerName(workspace: Workspace): string {
    return environmentContainerName(workspace, this.environment);
  }

  protected assertOwnership(workspace: Workspace, labels: Record<string, string>): void {
    if (labels[OWNER] !== workspace.id) {
      throw new Error(`Container ${this.containerName(workspace)} is not owned by VSPod. It was not changed.`);
    }
  }

  protected async createContainer(workspace: Workspace): Promise<void> {
    await execute('docker', createArguments(workspace, this.environment));
  }

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
      try { await execute('docker', ['image', 'inspect', this.environment.image]); return; } catch { operationSignal()?.throwIfAborted(); }
    }
    await execute('docker', ['build', '--tag', this.environment.image, join(installationRoot(), this.environment.buildDirectory)], {
      inherit: true, timeout: 900_000,
    });
  }

  async inspect(workspace: Workspace): Promise<RuntimeInstance | undefined> {
    const matches = await execute('docker', ['container', 'ls', '-a', '--filter', `name=^/${this.containerName(workspace)}$`, '--format', '{{.ID}}']);
    if (!matches) return undefined;
    const item = (JSON.parse(await execute('docker', ['inspect', this.containerName(workspace)])) as DockerInspection[])[0];
    this.assertOwnership(workspace, item.Config.Labels);
    const ports: Record<string, string> = {};
    for (const port of this.environment.ports) {
      const bindings = item.NetworkSettings.Ports[`${port}/tcp`];
      if (item.State.Running && (!bindings || bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1')) {
        throw new Error('Refusing a container endpoint that is not published exclusively on 127.0.0.1.');
      }
      if (bindings?.[0]) ports[String(port)] = `http://127.0.0.1:${bindings[0].HostPort}`;
    }
    return { id: item.Id, running: item.State.Running, startedAt: item.State.StartedAt, image: item.Config.Image, compatible: item.Config.Image === this.environment.image, ports };
  }

  async create(workspace: Workspace): Promise<void> {
    for (const kind of this.environment.volumes) {
      const name = `${this.containerName(workspace)}-${kind}`;
      const existing = await execute('docker', ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
      if (existing) {
        const [volume] = JSON.parse(await execute('docker', ['volume', 'inspect', name]));
        if (volume.Labels?.[OWNER] !== workspace.id) throw new Error(`Volume ${name} is not owned by VSPod; it was not mounted.`);
      } else {
        await execute('docker', ['volume', 'create', '--label', `${OWNER}=${workspace.id}`, name]);
      }
    }
    await this.createContainer(workspace);
  }

  async start(workspace: Workspace): Promise<RuntimeInstance> {
    await execute('docker', ['start', this.containerName(workspace)]);
    const instance = await this.inspect(workspace);
    if (!instance?.running) throw new Error('Docker did not start the workspace container.');
    return instance;
  }

  async stop(workspace: Workspace): Promise<void> {
    const instance = await this.inspect(workspace);
    if (instance?.running) await execute('docker', ['stop', '--time', '10', this.containerName(workspace)]);
  }

  async runStartupTask(workspace: Workspace, command: string): Promise<void> {
    await execute('docker', ['exec', '-i', '--user', '1000:1000', '--workdir', '/workspace',
      this.containerName(workspace), '/bin/sh', '-es'], { input: command, timeout: 600_000 });
  }

  async replace(workspace: Workspace, activate: () => Promise<void>): Promise<RuntimeInstance> {
    const signal = operationSignal();
    signal?.throwIfAborted();
    return withCancellation(undefined, async () => {
      const previous = await this.inspect(workspace);
      if (!previous) throw new Error('No workspace exists to upgrade. Run vspod open first.');
      const backup = `${this.containerName(workspace)}-previous-${randomBytes(4).toString('hex')}`;
      await this.stop(workspace);
      await execute('docker', ['rename', this.containerName(workspace), backup]);
      let created = false;
      let replacement: RuntimeInstance;
      try {
        await this.create(workspace);
        created = true;
        await withCancellation(signal, activate);
        const current = await this.inspect(workspace);
        if (!current?.running) throw new Error('Replacement activation did not start the container.');
        replacement = current;
      } catch (error) {
        if (created) await execute('docker', ['rm', '-f', this.containerName(workspace)]);
        await execute('docker', ['rename', backup, this.containerName(workspace)]);
        if (previous.running) {
          try { await activate(); } catch (recovery) {
            throw new Error('The previous container was restored, but editor reactivation failed. Run vspod stop before retrying.', { cause: recovery });
          }
        }
        throw new Error(`The upgrade did not finish. The previous container was restored; persistent volumes were retained. ${error instanceof Error ? error.message : ''}`);
      }
      try { await execute('docker', ['rm', backup]); } catch {
        console.warn(`Upgrade succeeded. The stopped recovery container ${backup} was retained because cleanup failed.`);
      }
      return replacement;
    });
  }

  async remove(workspace: Workspace): Promise<void> {
    if (await this.inspect(workspace)) {
      await this.stop(workspace);
      await execute('docker', ['rm', this.containerName(workspace)]);
    }
  }

  async removeTestVolumes(workspace: Workspace): Promise<void> {
    if (!workspace.name.startsWith('vspod-test-')) throw new Error('Only temporary test volumes may be deleted by the spike.');
    for (const kind of this.environment.volumes) {
      const name = `${this.containerName(workspace)}-${kind}`;
      const [volume] = JSON.parse(await execute('docker', ['volume', 'inspect', name]));
      if (volume.Labels?.[OWNER] !== workspace.id) throw new Error('Refusing to delete an unowned volume.');
      await execute('docker', ['volume', 'rm', name]);
    }
  }

  async exec(workspace: Workspace, command: string[], interactive = false): Promise<number> {
    if (!(await this.inspect(workspace))?.running) throw new Error('Workspace is stopped. Run vspod open first.');
    return attached('docker', ['exec', ...(interactive ? [process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i'] : []), '--workdir', '/workspace', this.containerName(workspace), ...command]);
  }

  async logs(workspace: Workspace, follow = false): Promise<number> {
    if (!await this.inspect(workspace)) throw new Error('No workspace container exists. Run vspod open first.');
    return attached('docker', ['logs', '--tail', '100', ...(follow ? ['--follow'] : []), this.containerName(workspace)]);
  }
}