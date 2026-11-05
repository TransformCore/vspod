import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--seccomp' || args[2] !== '--freerdp-prefix') {
  throw new Error('Usage: node play.mjs --seccomp <profile.json> --freerdp-prefix <native-prefix>');
}
const abort = new AbortController();
const exec = promisify(execFile);
const execute = (file, args, options) => exec(file, args, { signal: abort.signal, ...options });
const context = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'vspod-rdp-play-'));
const name = `vspod-rdp-play-${randomBytes(6).toString('hex')}`;
const prefix = args[3];
const children = [];
const listener = net.createServer();
let container, socket, client, viewer;
let output = '';
let failure;
let closing = false;
const selftest = process.env.VSPOD_RDP_SELFTEST === '1';

function launch(command, args, options) {
  const child = spawn(command, args, options);
  child.on('error', (error) => { failure = error; console.error(error); });
  children.push(child);
  return child;
}

function check() {
  abort.signal.throwIfAborted();
  if (failure) throw failure;
  for (const child of [container, client, viewer]) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Playground process exited unexpectedly: ${child.spawnfile} (${child.exitCode}/${child.signalCode})`);
    }
  }
}

const interrupt = () => {
  closing = true;
  abort.abort(new Error('Playground interrupted.'));
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await execute('docker', ['build', '-t', 'vspod-experiment:rdp', context], { timeout: 900_000, maxBuffer: 8_000_000 });
  const binary = join(root, 'rdp-client');
  const host = join(root, 'rdp-host');
  await execute('cc', [join(context, 'client.c'), '-o', binary,
    `-I${prefix}/include/freerdp3`, `-I${prefix}/include/winpr3`,
    `-L${prefix}/lib`, `-Wl,-rpath,${prefix}/lib`, '-lfreerdp-client3', '-lfreerdp3', '-lwinpr3'], { timeout: 60_000 });
  await execute('swiftc', [join(context, 'Host.swift'), fileURLToPath(new URL('../../packages/app-runner/host/macos/InputView.swift', import.meta.url)),
    '-o', host, '-framework', 'AppKit'], { timeout: 60_000 });
  container = launch('docker', [
    'run', '--rm', '--name', name, '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${args[1]}`,
    '--read-only', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--shm-size', '128m',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/run/xrdp:rw,nosuid,nodev,size=4m,uid=1000,gid=1000,mode=0700',
    'vspod-experiment:rdp',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [container.stdout, container.stderr]) {
    stream.on('data', (data) => { output += data; process.stdout.write(data); });
  }
  const deadline = Date.now() + 240_000;
  while (!output.includes('RDP_SPIKE_READY')) {
    check();
    if (Date.now() > deadline) throw new Error(`Server readiness timed out: ${output}`);
    await delay(100);
  }
  const { stdout } = await execute('docker', ['exec', name, 'openssl', 'x509', '-in', '/tmp/rdp-cert.pem',
    '-noout', '-fingerprint', '-sha256'], { timeout: 5_000 });
  const fingerprint = stdout.trim().split('=')[1];
  assert.match(fingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  listener.once('connection', (connection) => {
    socket = connection;
    listener.close();
    const bridge = launch('docker', ['exec', '-i', name, 'socat', 'STDIO', 'TCP:127.0.0.1:3389'],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    const transportError = (error) => {
      if (!closing) { failure = error; console.error('RDP transport:', error); }
    };
    socket.on('error', transportError);
    bridge.stdin.on('error', transportError);
    socket.pipe(bridge.stdin);
    bridge.stdout.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const frame = join(root, 'frame.ppm');
  const env = { ...process.env, VSPOD_RDP_INTERACTIVE: '1' };
  client = launch(binary, [`127.0.0.1:${listener.address().port}`, fingerprint, frame, '0'],
    { env, stdio: ['pipe', 'inherit', 'inherit'] });
  client.stdin.on('error', (error) => { if (!closing) failure = error; });
  const frameDeadline = Date.now() + 30_000;
  while (true) {
    check();
    try {
      if ((await stat(frame)).size > 1100 * 750 * 3) break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() > frameDeadline) throw new Error('No decoded RDP frame received.');
    await delay(100);
  }
  viewer = launch(host, [frame, join(root, 'unused.png'), '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  viewer.stdout.pipe(client.stdin);
  console.log(`RDP_PLAY_READY container=${name}`);
  console.log('Close the native window or press Cmd+Q to end the disposable session.');
  console.log('Cmd shortcuts map to Linux Ctrl; clipboard stays inside the container.');
  while (viewer.exitCode === null && viewer.signalCode === null) {
    check();
    await delay(100);
  }
  closing = true;
  if (viewer.exitCode !== 0) throw new Error(`Native viewer failed (${viewer.exitCode}/${viewer.signalCode}).`);
  if (selftest) {
    const { stdout: text } = await execute('docker', ['exec', name, 'cat', '/tmp/workspace/rdp.txt'], { timeout: 5_000 });
    assert.equal(text, 'Native RDP input verified\nSecond line');
    const { stdout: geometry } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'xrandr', '--current'], { timeout: 5_000 });
    assert.match(geometry, /current 1000 x 680/);
    const frameBytes = await readFile(frame);
    assert.ok(frameBytes.subarray(0, 40).toString().startsWith('P6\n1000 680\n255\n'));
    console.log('PASS: native mouse click, scancode typing, Return, Cmd+A/Cmd+S and native-window resize reached actual VS Code over RDP.');
  }
} catch (error) {
  if (!abort.signal.aborted) {
    console.error('RDP playground failed:', error);
    process.exitCode = 1;
  }
} finally {
  closing = true;
  listener.close();
  socket?.destroy();
  for (const child of children) {
    if (child !== container && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  try {
    if (container) await execute('docker', ['rm', '-f', name], { timeout: 15_000, signal: undefined });
  } finally {
    await rm(root, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  console.log('RDP playground closed; disposable container and local runtime removed.');
}
