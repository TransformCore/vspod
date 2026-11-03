import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, symlink, lstat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

async function link(target, destination) {
  try {
    const info = await lstat(destination);
    if (!info.isSymbolicLink()) throw new Error(`Unexpected storage layout at ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(target, destination);
  }
}

for (const path of ['/vspod/state/user-data', '/vspod/state/workspaceStorage', '/vspod/state/globalStorage']) {
  await mkdir(path, { recursive: true });
}
await link('/vspod/settings', '/vspod/state/user-data/User');
await link('/vspod/state/workspaceStorage', '/vspod/settings/workspaceStorage');
await link('/vspod/state/globalStorage', '/vspod/settings/globalStorage');

let credentials;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    credentials = JSON.parse(await readFile('/run/vspod/credentials.json', 'utf8'));
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Invalid startup credentials.');
    await delay(100);
  }
}
if (!credentials || !/^[a-f0-9]{64}$/.test(credentials.password)) throw new Error('VSPod bootstrap timed out.');
await unlink('/run/vspod/credentials.json');

const persistent = {
  'bind-addr': '0.0.0.0:8080',
  auth: 'password', cert: false,
  'user-data-dir': '/vspod/state/user-data',
  'extensions-dir': '/vspod/extensions',
  'disable-telemetry': true,
  'disable-update-check': true,
};
const mode = JSON.parse(await readFile('/vspod/config/runtime-mode.json', 'utf8'));
if (mode.restricted) {
  await mkdir('/run/vspod/restricted-user-data/User', { recursive: true, mode: 0o700 });
  await mkdir('/run/vspod/restricted-extensions', { mode: 0o700 });
  await writeFile('/run/vspod/restricted-user-data/User/settings.json',
    await readFile('/vspod/config/workspace/settings.json'), { mode: 0o600 });
  await writeFile('/run/vspod/restricted-user-data/User/keybindings.json', '[]', { mode: 0o600 });
  persistent['user-data-dir'] = '/run/vspod/restricted-user-data';
  persistent['extensions-dir'] = '/run/vspod/restricted-extensions';
}
await writeFile('/vspod/config/config.json', JSON.stringify(persistent, null, 2), { mode: 0o600 });
await writeFile('/run/vspod/config.json', JSON.stringify({ ...persistent, password: credentials.password }), { mode: 0o600 });
credentials = undefined;

const editor = spawn('/usr/bin/code-server', ['--config', '/run/vspod/config.json', '/workspace'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => editor.kill(signal));
editor.on('error', () => { console.error('Unable to start code-server.'); process.exit(1); });
editor.on('exit', (code) => process.exit(code ?? 1));