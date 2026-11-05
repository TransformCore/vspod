import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const abort = new AbortController();
const exec = promisify(execFile);
const execute = (file, args, options) => exec(file, args, { signal: abort.signal, ...options });
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--seccomp' || args[2] !== '--freerdp-prefix') {
  throw new Error('Usage: node run.mjs --seccomp <profile.json> --freerdp-prefix <native-install-prefix>');
}
if (process.env.VSPOD_RDP_CLIPBOARD && !['text', 'dib'].includes(process.env.VSPOD_RDP_CLIPBOARD)) {
  throw new Error('VSPOD_RDP_CLIPBOARD must be text or dib.');
}
const context = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'vspod-rdp-spike-'));
const name = `vspod-rdp-${randomBytes(6).toString('hex')}`;
let container, client, bridge, viewer, connection;
let output = '';
const server = net.createServer();
const imageMode = process.env.VSPOD_RDP_CLIPBOARD === 'dib';
const interrupt = () => {
  abort.abort(new Error('RDP spike interrupted.'));
  client?.kill('SIGTERM');
  viewer?.kill('SIGTERM');
  bridge?.kill('SIGTERM');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await execute('docker', ['build', '-t', 'vspod-experiment:rdp', context], { timeout: 900_000, maxBuffer: 8_000_000 });
  const prefix = args[3];
  const binary = join(root, 'rdp-client');
  await execute('cc', [
    join(context, 'client.c'), '-o', binary, `-I${prefix}/include/freerdp3`,
    `-I${prefix}/include/winpr3`, `-L${prefix}/lib`, `-Wl,-rpath,${prefix}/lib`,
    '-lfreerdp-client3', '-lfreerdp3', '-lwinpr3',
  ], { timeout: 60_000 });
  const viewerBinary = join(root, 'rdp-host');
  await execute('swiftc', [join(context, 'Host.swift'), fileURLToPath(new URL('../../packages/app-runner/host/macos/InputView.swift', import.meta.url)),
    '-o', viewerBinary, '-framework', 'AppKit'], { timeout: 60_000 });
  const compareBinary = join(root, 'rdp-compare');
  await execute('swiftc', [join(context, 'Compare.swift'), '-o', compareBinary, '-framework', 'AppKit'], { timeout: 60_000 });
  container = spawn('docker', [
    'run', '--rm', '--name', name, '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${args[1]}`,
    '--read-only', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--shm-size', '128m',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/run/xrdp:rw,nosuid,nodev,size=4m,uid=1000,gid=1000,mode=0700',
    'vspod-experiment:rdp',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  container.on('error', (error) => { output += error.message; });
  container.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
  container.stderr.on('data', (data) => { output += data; process.stderr.write(data); });
  const deadline = Date.now() + 240_000;
  while (!output.includes('RDP_SPIKE_READY')) {
    abort.signal.throwIfAborted();
    if (container.exitCode !== null || container.signalCode !== null) throw new Error(`RDP server exited: ${output}`);
    if (Date.now() > deadline) throw new Error('RDP server readiness timed out.');
    await delay(500);
  }
  const { stdout: fingerprint } = await execute('docker', ['exec', name, 'openssl', 'x509', '-in', '/tmp/rdp-cert.pem', '-noout', '-fingerprint', '-sha256'], { timeout: 5_000 });
  const hash = fingerprint.trim().split('=')[1];
  assert.match(hash, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  server.once('connection', (socket) => {
    console.log('RDP local transport connected');
    connection = socket;
    server.close();
    bridge = spawn('docker', ['exec', '-i', name, 'socat', 'STDIO', 'TCP:127.0.0.1:3389'], { stdio: ['pipe', 'pipe', 'inherit'] });
    bridge.on('error', (error) => socket.destroy(error));
    bridge.stdin.on('error', (error) => socket.destroy(error));
    socket.on('error', (error) => console.error('RDP tunnel:', error.message));
    socket.pipe(bridge.stdin);
    bridge.stdout.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const framePath = join(root, 'frame.ppm');
  const text = 'RDP clipboard: café, 日本語, 😀\r\n\r\n' + Array.from({ length: 5000 }, (_, i) => `line ${i}: αβγ\tterminal output\r\n`).join('');
  const dib = Buffer.alloc(40 + 52 * 13);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(17, 4);
  dib.writeInt32LE(13, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  dib.writeUInt32LE(52 * 13, 20);
  for (let i = 40; i < dib.length; i++) dib[i] = i % 251;
  const remoteDib = Buffer.from(dib);
  remoteDib[40] ^= 0xff;
  const bmpHeader = Buffer.alloc(14);
  bmpHeader.write('BM');
  bmpHeader.writeUInt32LE(14 + dib.length, 2);
  bmpHeader.writeUInt32LE(54, 10);
  await writeFile(`${framePath}.clipboard-in`, imageMode ? dib : Buffer.from(`${text}\0`, 'utf16le'));
  viewer = spawn(viewerBinary, [framePath, join(root, 'snapshot.png'), '30'], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 40_000, killSignal: 'SIGKILL' });
  const viewerResult = new Promise((resolve, reject) => {
    viewer.once('error', reject);
    viewer.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Native viewer exited ${code}`)));
  });
  // Observe early rejection now; successful acceptance still awaits this promise below.
  viewerResult.catch(() => {});
  client = spawn(binary, [`127.0.0.1:${port}`, hash, framePath, '28'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 40_000, killSignal: 'SIGKILL' });
  let clientOutput = '';
  client.on('error', (error) => { clientOutput += error.message; });
  client.stdout.on('data', (data) => { clientOutput += data; process.stdout.write(data); });
  client.stderr.on('data', (data) => { clientOutput += data; process.stderr.write(data); });
  const sizes = new Set();
  let clipboardTested = false;
  const connectedAt = Date.now();
  const end = Date.now() + 45_000;
  while (client.exitCode === null && client.signalCode === null && Date.now() < end) {
    abort.signal.throwIfAborted();
    try {
      if (!clipboardTested && clientOutput.includes('RDP_CLIPBOARD_READY') && Date.now() - connectedAt > 4000) {
        if (imageMode) {
          const { stdout: bitmap } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'timeout', '5', 'xclip', '-selection', 'clipboard', '-t', 'image/bmp', '-o'], { timeout: 7_000, encoding: 'buffer', maxBuffer: 8_000_000 });
          assert.deepEqual(bitmap.subarray(14), dib);
          await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'sh', '-ec',
            'printf %s "$1" | base64 -d > /tmp/clipboard.bmp; xclip -selection clipboard -t image/bmp -i /tmp/clipboard.bmp',
            'clipboard-fixture', Buffer.concat([bmpHeader, remoteDib]).toString('base64')], { timeout: 5_000 });
          console.log('PASS: CF_DIB crossed CLIPRDR into X11 as a byte-exact BMP.');
        } else {
          const { stdout: pasted } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'timeout', '5', 'xclip', '-selection', 'clipboard', '-t', 'UTF8_STRING', '-o'], { timeout: 7_000, maxBuffer: 8_000_000 });
          assert.ok(pasted.replaceAll('\r\n', '\n') === text.replaceAll('\r\n', '\n'),
            `Clipboard mismatch: ${JSON.stringify(pasted.slice(0, 100))}; length=${pasted.length}, expected=${text.length}`);
          await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'bash', '-ec',
            'xdotool key --clearmodifiers ctrl+1; xdotool key ctrl+a ctrl+v; sleep 1; xdotool key ctrl+s; sleep 1; xdotool key ctrl+a ctrl+c'],
            { timeout: 10_000 });
          const { stdout: saved } = await execute('docker', ['exec', name, 'cat', '/tmp/workspace/rdp.txt'], { timeout: 5_000, maxBuffer: 8_000_000 });
          assert.ok(saved.replaceAll('\r\n', '\n') === text.replaceAll('\r\n', '\n'), 'Actual VS Code paste/save did not match the Unicode fixture.');
          console.log('PASS: 5,000 Unicode/multiline clipboard records crossed CLIPRDR and pasted/saved in actual VS Code.');
        }
        clipboardTested = true;
      }
      const { stdout } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'xrandr', '--current'], { timeout: 5_000 });
      const match = /current (\d+) x (\d+)/.exec(stdout);
      if (match) {
        const key = `${match[1]}x${match[2]}`;
        if (['1100x750', '900x600', '1200x800'].includes(key) && !sizes.has(key)) {
          const { stdout: windows } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'wmctrl', '-lG'], { timeout: 5_000 });
          const editor = windows.split('\n').find((line) => /Visual Studio Code/.test(line));
          const geometry = editor?.trim().split(/\s+/).slice(2, 6).map(Number);
          if (geometry && geometry[0] === 0 && geometry[1] === 0 &&
              geometry[2] === Number(match[1]) && geometry[3] === Number(match[2])) {
            console.log(`RDP desktop and fullscreen editor ${key}: ${editor}`);
            sizes.add(key);
          }
        }
      }
    } catch (error) { console.error('RDP probe failed:', error.message); throw error; }
    await delay(500);
  }
  connection?.destroy();
  if (client.exitCode !== 0) throw new Error(`Native FreeRDP failed (${client.exitCode}/${client.signalCode}): ${clientOutput}`);
  assert.deepEqual([...sizes].sort(), ['1100x750', '1200x800', '900x600']);
  assert.ok(clipboardTested);
  const returned = await readFile(`${framePath}.clipboard-out`);
  if (imageMode) {
    assert.deepEqual(returned, remoteDib);
    console.log('PASS: a different Linux BMP crossed CLIPRDR back as byte-exact CF_DIB.');
  } else {
    assert.ok(returned.toString('utf16le').replace(/\0$/, '').replaceAll('\r\n', '\n') === text.replaceAll('\r\n', '\n'), 'Actual VS Code copy did not match the Unicode fixture.');
    console.log('PASS: actual VS Code copy crossed CLIPRDR back to the native client.');
  }
  const frame = await readFile(framePath);
  assert.ok(frame.length > 1200 * 800 * 3);
  assert.ok(frame.subarray(0, 40).toString().startsWith('P6\n1200 800\n255\n'));
  console.log('PASS: native FreeRDP decoded frames and xorgxrdp resized at three sizes.');
  await viewerResult;
  await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'scrot', '/tmp/source.png'], { timeout: 5_000 });
  const { stdout: source } = await execute('docker', ['exec', name, 'cat', '/tmp/source.png'], { timeout: 5_000, encoding: 'buffer', maxBuffer: 8_000_000 });
  await writeFile(join(root, 'source.png'), source);
  const comparison = await execute(compareBinary, [join(root, 'snapshot.png'), join(root, 'source.png')], { timeout: 15_000 });
  console.log(comparison.stdout.trim());
  if (process.env.VSPOD_RDP_SNAPSHOT) {
    await writeFile(process.env.VSPOD_RDP_SNAPSHOT, await readFile(join(root, 'snapshot.png')));
    await writeFile(`${process.env.VSPOD_RDP_SNAPSHOT}.source.png`, source);
  }
  console.log('PASS: RDP-decoded framebuffer displayed in an AppKit window.');
} catch (error) {
  if (container) {
    const logs = await execute('docker', ['exec', name, 'sh', '-c', 'tail -n 40 /tmp/xrdp.log /tmp/rdp-stdout.log /tmp/chansrv.log /tmp/xrdp-chansrv.10.log /tmp/Xorg.log'], { timeout: 5_000, signal: undefined }).catch((failure) => ({ stdout: failure.message }));
    console.error(logs.stdout);
  }
  throw error;
} finally {
  server.close();
  connection?.destroy();
  client?.kill('SIGTERM');
  bridge?.kill('SIGTERM');
  viewer?.kill('SIGTERM');
  try {
    if (container) await execute('docker', ['rm', '-f', name], { timeout: 15_000, signal: undefined });
  } finally {
    await rm(root, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
