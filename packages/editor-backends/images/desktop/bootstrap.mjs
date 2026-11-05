import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('/vspod/state/user-data', { recursive: true });
await mkdir(process.env.HOME, { recursive: true });
try {
  const info = await lstat('/vspod/state/user-data/User');
  if (!info.isSymbolicLink()) throw new Error('Unsafe desktop user-data layout.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await symlink('/vspod/settings', '/vspod/state/user-data/User');
}
let mode;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try { mode = JSON.parse(await readFile('/tmp/vspod-launch.json', 'utf8')); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await delay(100);
}
if (typeof mode?.restricted !== 'boolean') throw new Error('Desktop activation timed out or has an invalid mode.');
await unlink('/tmp/vspod-launch.json');
let userData = '/vspod/state/user-data', extensions = '/vspod/extensions';
if (mode.restricted) {
  userData = '/tmp/restricted-user-data';
  extensions = '/tmp/restricted-extensions';
  await mkdir(`${userData}/User`, { recursive: true, mode: 0o700 });
  await mkdir(extensions, { mode: 0o700 });
  await writeFile(`${userData}/User/settings.json`, await readFile('/vspod/settings/settings.json'), { mode: 0o600 });
  await writeFile(`${userData}/User/keybindings.json`, '[]', { mode: 0o600 });
}
await writeFile('/tmp/application.log', '', { mode: 0o600 });
const logs = spawn('tail', ['-n', '+1', '-F', '/tmp/application.log'], { stdio: 'inherit' });
const child = spawn('/bin/bash', ['/opt/app-runner/entrypoint.sh', '/opt/vscode/code',
  '--ozone-platform=wayland', '--disable-gpu', '--disable-telemetry', '--skip-welcome',
  '--skip-release-notes', '--password-store=basic', '--user-data-dir', userData,
  '--extensions-dir', extensions, ...(mode.restricted ? ['--disable-extensions'] : []), '/workspace',
], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); logs.kill(signal); });
logs.once('error', (error) => { console.error(`Desktop log stream failed: ${error.message}`); child.kill('SIGTERM'); process.exit(1); });
child.once('error', (error) => { console.error(`Desktop editor launch failed: ${error.message}`); process.exit(1); });
child.once('exit', (code) => { logs.kill('SIGTERM'); process.exit(code ?? 1); });
