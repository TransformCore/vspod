import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.length !== 4 || process.argv[2] !== '--seccomp') throw new Error('Usage: node tests/runtime.mjs --seccomp profile.json');
const seccompProfile = resolve(process.argv[3]);
await execute('node', [join(root, 'build.mjs'), '--host'], { timeout: 300_000 });
await execute('docker', ['build', '-t', 'vspod-app-runner:dev', '-f', join(root, 'guest/Dockerfile'), root], { timeout: 900_000 });
await execute('docker', ['build', '-t', 'vspod-app-runner:notes-test', '-f', join(root, 'tests/Dockerfile'), root], { timeout: 300_000 });
const { DockerAppRunner } = await import(join(root, 'dist/index.mjs'));
const runner = new DockerAppRunner();
const directory = await mkdtemp(join(tmpdir(), 'runner-notes-'));
const id = `runner-notes-${randomBytes(6).toString('hex')}`;
let host, created = false, output = '', hostFailure;
const wait = async (predicate, label) => {
  const end = Date.now() + 30_000;
  while (!await predicate()) {
    if (hostFailure) throw hostFailure;
    if (Date.now() > end) throw new Error(`Timed out: ${label}\n${output}`);
    await delay(100);
  }
};
async function attach(name) {
  const attachment = join(directory, name);
  await mkdir(attachment, { mode: 0o700 });
  host = await runner.attach(join(root, 'dist/app-host'), attachment, {
    container: id, protocol: 'wayland', integrations: { clipboard: false, files: false, externalUrls: false },
  });
  host.on('error', (error) => { hostFailure = error; });
  host.on('exit', (code) => { if (code !== 0) hostFailure = new Error(`Native host failed: ${code}`); });
  host.stdout.on('data', (data) => { output += data; });
  await wait(() => output.includes('WINDOW_FRAME'), 'GTK native frame');
}
async function detach() {
  const closed = new Promise((resolve, reject) => {
    host.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Host exited ${code}`)));
    host.once('error', reject);
  });
  host.stdin.write('{"action":"stop"}\n');
  await closed;
}
try {
  const data = join(directory, 'data');
  await mkdir(data, { mode: 0o700 });
  await runner.create({
    id, image: 'vspod-app-runner:notes-test', command: ['/usr/bin/python3', '/opt/notes.py'],
    workdir: '/data', mounts: [{ kind: 'bind', source: data, target: '/data' }], seccompProfile,
    resources: { cpus: 2, memoryMiB: 512, pids: 128, shmMiB: 64, tmpMiB: 128 },
    scale: 2, exportRoots: [], integrations: { clipboard: false, files: false, externalUrls: false },
  });
  created = true;
  await runner.start(id);
  process.env.VSPOD_WINDOW_SELFTEST = '1';
  await attach('first');
  const window = Number(output.match(/WINDOW_CREATED id=(\d+) popup=false/)[1]);
  host.stdin.write(JSON.stringify({ action: 'testKey', id: window, code: 0 }) + '\n');
  await wait(() => output.includes('title=Runner Notes: a'), 'GTK keyboard input');
  assert.equal(await readFile(join(data, 'text.txt'), 'utf8'), 'a');
  console.log('PASS non-Electron GTK app: native frame, keyboard input, explicit data mount, no Git repository');
  for (const code of [0, 8]) {
    host.stdin.write(JSON.stringify({ action: 'testKey', id: window, code, flags: 1 << 20 }) + '\n');
    await delay(150);
  }
  await wait(() => output.includes('WINDOW_CLIPBOARD_REJECTED reason=host policy'), 'clipboard denied by host policy');
  await execute('docker', ['exec', id, '/usr/local/bin/xdg-open', 'https://example.com']);
  await wait(() => output.includes('WINDOW_OPEN_REJECTED reason=host policy'), 'external URL denied by host policy');
  host.stdin.write(JSON.stringify({ action: 'testDrop', id: window, x: 30, y: 30, paths: ['/not-read-by-disabled-transfer'] }) + '\n');
  await wait(() => output.includes('WINDOW_DROP_REJECTED reason=host policy'), 'file transfer denied by host policy');
  console.log('PASS disabled clipboard export, external URLs and file drops are rejected at the host boundary');
  await detach();
  assert.equal((await runner.inspect(id)).running, true);
  console.log('PASS detaching the native host leaves the application running');
  output = '';
  await attach('second');
  assert.ok(output.includes('title=Runner Notes: a'));
  await detach();
  console.log('PASS reattach replays the same live GTK application and edited state');
  await runner.stop(id);
  assert.equal((await runner.inspect(id)).running, false);
  assert.equal(await readFile(join(data, 'text.txt'), 'utf8'), 'a');
  console.log('PASS explicit stop preserves mounted application data');
} finally {
  if (host && host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
  if (created) { await runner.stop(id); await runner.remove(id); }
  await rm(directory, { recursive: true, force: true });
}
