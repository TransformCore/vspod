import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { realpath, lstat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const execute = (file: string, args: string[]) => exec(file, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
export const PROTOCOL_VERSION = 1;
const OWNER = 'dev.vspod.app-runner';

export interface HostIntegrations {
  clipboard: boolean;
  files: boolean;
  externalUrls: boolean;
}

export interface AppLaunchSpec {
  id: string;
  image: string;
  command: readonly string[];
  workdir: string;
  mounts: readonly { kind: 'bind' | 'volume'; source: string; target: string; readOnly?: boolean }[];
  seccompProfile: string;
  resources: { cpus: number; memoryMiB: number; pids: number; shmMiB: number; tmpMiB: number };
  scale: 1 | 2;
  exportRoots: readonly string[];
  integrations: HostIntegrations;
  environment?: Readonly<Record<string, string>>;
  electronMenuNudge?: boolean;
  pointerTrace?: boolean;
}

function assertName(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid runner session or volume name.');
}

function assertGuestPath(path: string): void {
  if (!path.startsWith('/') || posix.normalize(path) !== path || /[\0\r\n,]/.test(path)) {
    throw new Error(`Invalid absolute guest path: ${path}`);
  }
}

function assertPolicy(policy: HostIntegrations): void {
  if (['clipboard', 'files', 'externalUrls'].some((key) => typeof policy[key as keyof HostIntegrations] !== 'boolean')) {
    throw new Error('Host integration permissions must be explicit booleans.');
  }
}

export function containerArguments(spec: AppLaunchSpec): string[] {
  assertName(spec.id);
  assertPolicy(spec.integrations);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(spec.image)) throw new Error('Invalid application image.');
  if (!spec.command.length || !spec.command[0].startsWith('/') || spec.command.some((arg) => arg.includes('\0'))) {
    throw new Error('Application command must be an absolute executable and an argument array.');
  }
  assertGuestPath(spec.workdir);
  if (!isAbsolute(spec.seccompProfile) || /[\0\r\n]/.test(spec.seccompProfile)) {
    throw new Error('An absolute seccomp profile path is required.');
  }
  if (![1, 2].includes(spec.scale)) throw new Error('Runner scale must be 1 or 2.');
  for (const [key, value] of Object.entries(spec.resources)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid runner resource limit: ${key}`);
  }
  for (const root of spec.exportRoots) {
    assertGuestPath(root);
    if (root === '/') throw new Error('The filesystem root cannot be a clipboard export root.');
  }
  const mounts = spec.mounts.flatMap((mount) => {
    assertGuestPath(mount.target);
    if (mount.target === '/' || ['/tmp', '/opt', '/proc', '/sys', '/dev', '/run'].some(
      (root) => mount.target === root || mount.target.startsWith(`${root}/`),
    )) throw new Error(`Mount would replace runner internals: ${mount.target}`);
    if (mount.kind === 'volume') assertName(mount.source);
    else if (mount.kind !== 'bind' || !isAbsolute(mount.source) || /[\0\r\n,]/.test(mount.source)) {
      throw new Error('Invalid bind mount source.');
    }
    return ['--mount', `type=${mount.kind},source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`];
  });
  const environment = Object.entries(spec.environment ?? {}).flatMap(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /^(APP_RUNNER_|LD_|DYLD_)/.test(key)
      || ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY'].includes(key) || value.includes('\0')) {
      throw new Error(`Invalid or reserved application environment variable: ${key}`);
    }
    return ['--env', `${key}=${value}`];
  });
  const { cpus, memoryMiB, pids, shmMiB, tmpMiB } = spec.resources;
  return [
    'create', '--name', spec.id, '--label', `${OWNER}=${spec.id}`,
    '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${spec.seccompProfile}`,
    '--read-only', '--pids-limit', String(pids), '--memory', `${memoryMiB}m`, '--cpus', String(cpus),
    '--shm-size', `${shmMiB}m`,
    '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${tmpMiB}m,uid=1000,gid=1000,mode=0700`,
    '--workdir', spec.workdir, ...mounts, ...environment,
    '--env', `APP_RUNNER_SCALE=${spec.scale}`,
    '--env', `APP_RUNNER_POINTER_TRACE=${spec.pointerTrace ? '1' : '0'}`,
    '--env', `APP_RUNNER_EXPORT_ROOTS=${JSON.stringify(spec.exportRoots)}`,
    '--env', `APP_RUNNER_ELECTRON_MENU_NUDGE=${spec.electronMenuNudge ? '1' : '0'}`,
    spec.image, ...spec.command,
  ];
}

export interface HostAttachment {
  container: string;
  protocol: 'wayland' | 'x11';
  integrations: HostIntegrations;
  stopGuestOnQuit?: boolean;
}

export async function writeHostConfiguration(directory: string, attachment: HostAttachment): Promise<string> {
  assertName(attachment.container);
  assertPolicy(attachment.integrations);
  if (!['wayland', 'x11'].includes(attachment.protocol)) throw new Error('Unsupported host protocol.');
  const root = await realpath(directory);
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Host session directory must be private and owned by the current user.');
  }
  const path = join(root, 'host.json');
  await writeFile(path, JSON.stringify({
    version: PROTOCOL_VERSION, ...attachment, root,
    stopGuestOnQuit: attachment.stopGuestOnQuit ?? false,
    bridge: attachment.protocol === 'wayland'
      ? ['/opt/app-runner/vspod-compositor', '--bridge']
      : ['python3', '/opt/window-capture/agent.py'],
  }), { mode: 0o600, flag: 'wx' });
  return path;
}

/** Container ownership is independent of Git workspaces; callers own host attachment and transfer retention. */
export class DockerAppRunner {
  private async assertLocalDocker(): Promise<void> {
    let endpoint = process.env.DOCKER_HOST;
    if (process.env.DOCKER_CONTEXT || !endpoint) {
      const { stdout } = await execute('docker', ['context', 'inspect', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : [])]);
      endpoint = JSON.parse(stdout)[0]?.Endpoints?.docker?.Host;
    }
    if (!endpoint?.startsWith('unix:///') || /[\r\n]/.test(endpoint)) {
      throw new Error('App runner requires a local Unix-socket Docker context.');
    }
  }

  async inspect(id: string): Promise<{ id: string; running: boolean; startedAt: string } | undefined> {
    assertName(id);
    await this.assertLocalDocker();
    const { stdout } = await execute('docker', ['container', 'ls', '-a', '--filter', `name=^/${id}$`, '--format', '{{.ID}}']);
    if (!stdout.trim()) return undefined;
    const result = await execute('docker', ['inspect', id]);
    const [item] = JSON.parse(result.stdout);
    if (item.Config.Labels[OWNER] !== id) throw new Error(`Container ${id} is not owned by the app runner.`);
    return { id: item.Id, running: item.State.Running, startedAt: item.State.StartedAt };
  }

  async create(spec: AppLaunchSpec): Promise<void> {
    const args = containerArguments(spec);
    await this.assertLocalDocker();
    await execute('docker', args);
  }

  async start(id: string): Promise<void> {
    if (!await this.inspect(id)) throw new Error(`Unknown runner session: ${id}`);
    await execute('docker', ['start', id]);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = await this.inspect(id);
      if (!state?.running) throw new Error(`Application exited before readiness: ${id}. Inspect docker logs ${id}.`);
      const { stdout } = await execute('docker', ['logs', '--since', state.startedAt, id]);
      if (stdout.includes('APP_RUNNER_READY')) return;
      await delay(100);
    }
    throw new Error(`Application did not map a window within 30 seconds: ${id}. Inspect docker logs ${id}.`);
  }

  async stop(id: string): Promise<void> {
    if ((await this.inspect(id))?.running) await execute('docker', ['stop', '--time', '10', id]);
  }

  async remove(id: string): Promise<void> {
    const state = await this.inspect(id);
    if (state?.running) throw new Error('Stop the application session before removing it.');
    if (state) await execute('docker', ['rm', id]);
  }

  async attach(binary: string, directory: string, attachment: HostAttachment,
    options: { stderr?: 'inherit' | 'pipe' } = {}): Promise<ChildProcess> {
    if (process.platform !== 'darwin') throw new Error('The native application host currently requires macOS.');
    if (!(await this.inspect(attachment.container))?.running) throw new Error('Cannot attach to a stopped application session.');
    const configuration = await writeHostConfiguration(directory, attachment);
    // The returned child exposes stdout readiness events; no detached/untracked subprocess is created here.
    return spawn(binary, [configuration], { stdio: ['pipe', 'pipe', options.stderr ?? 'inherit'] });
  }
}
