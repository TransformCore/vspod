import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function installationRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (directory !== parse(directory).root) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'vspod') return directory;
    directory = dirname(directory);
  }
  throw new Error('VSPod installation is incomplete. Reinstall from a complete checkout.');
}

export interface DesktopInstallation {
  kind: 'app' | 'binary';
  executable: string;
  path: string;
}

export function desktopInstallation(root = installationRoot(), environment = process.env): DesktopInstallation {
  const binary = (path: string): DesktopInstallation => ({ kind: 'binary', path, executable: path });
  const app = (path: string): DesktopInstallation => ({ kind: 'app', path, executable: join(path, 'Contents/MacOS/vspod-desktop') });
  if (environment.VSPOD_DESKTOP_BINARY) return binary(resolve(environment.VSPOD_DESKTOP_BINARY));
  if (environment.VSPOD_DESKTOP_APP) {
    const path = resolve(environment.VSPOD_DESKTOP_APP);
    if (!path.endsWith('.app')) throw new Error('VSPOD_DESKTOP_APP must point to a VSPod .app bundle.');
    return app(path);
  }
  const target = join(root, 'apps/desktop/src-tauri/target');
  const candidates = [
    app(join(target, 'release/bundle/macos/VSPod.app')),
    app(join(target, 'debug/bundle/macos/VSPod.app')),
    binary(join(target, 'debug/vspod-desktop')),
    binary(join(target, 'release/vspod-desktop')),
  ].flatMap((installation) => {
    try { const stat = statSync(installation.executable); return stat.isFile() ? [{ installation, modified: stat.mtimeMs }] : []; }
    catch { return []; }
  }).sort((left, right) => right.modified - left.modified);
  if (candidates.length) return candidates[0].installation;
  const installed = app('/Applications/VSPod.app');
  return existsSync(installed.executable) ? installed : binary(join(target, 'debug/vspod-desktop'));
}

export function desktopBinary(): string {
  return desktopInstallation().executable;
}

export function desktopCommand(session: string, installation = desktopInstallation()): { command: string; args: string[]; bundled: boolean } {
  return installation.kind === 'app'
    ? { command: '/usr/bin/open', args: ['-n', '-W', installation.path, '--args', '--session', session], bundled: true }
    : { command: installation.executable, args: ['--session', session], bundled: false };
}