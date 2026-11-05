import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { testClipboard } from './clipboard.mjs';
import { prepareDrop, testDrop } from './drag-drop.mjs';

const executeFile = promisify(execFile);
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Experimental display interrupted.'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const execute = (file, args, options) => executeFile(file, args, { ...options, signal: abort.signal });
const args = process.argv.slice(2);
const clipboardTest = args.includes('--clipboard-test');
const dropTest = args.includes('--drop-test');
const options = args.filter((arg) => !['--clipboard-test', '--drop-test'].includes(arg));
if (options[0] !== '--seccomp' || !(options.length === 2 || (options.length === 4 && options[2] === '--snapshot'))) {
  throw new Error('Usage: node display.mjs --seccomp <experimental-profile.json> [--snapshot <new.png>] [--clipboard-test] [--drop-test]');
}
const snapshotPath = options[3];
if (snapshotPath) {
  try { await stat(snapshotPath); throw new Error('Snapshot path already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const context = fileURLToPath(new URL('.', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'vspod-app-only-spike-'));
const image = 'vspod-experiment:desktop-sandbox-probe';
const name = `vspod-desktop-display-${randomBytes(6).toString('hex')}`;
const capability = randomBytes(32).toString('hex');
let container;
let host;
try {
  const dropFixture = dropTest ? await prepareDrop(root) : undefined;
  await execute('docker', ['build', '--tag', image, context], { timeout: 900_000, maxBuffer: 8_000_000 });
  const binary = join(root, 'desktop-spike');
  await execute('swiftc', [join(context, 'Host.swift'), '-o', binary, '-framework', 'AppKit', '-framework', 'WebKit'], { timeout: 120_000 });
  container = spawn('docker', [
    'run', '--rm', '-i', '--name', name, '--init', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--security-opt', `seccomp=${options[1]}`, '--read-only',
    ...(clipboardTest || dropTest ? ['--env', 'VSPOD_CLIPBOARD_TEST=1'] : []),
    '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--shm-size', '128m',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700',
    '--publish', '127.0.0.1::8080', '--entrypoint', '/bin/bash',
    image, '/opt/spike/display.sh',
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  let containerError;
  container.on('error', (error) => { containerError = error; });
  container.stdin.on('error', (error) => { containerError = error; });
  container.stdin.end(`${capability}\n`);
  let url;
  const readyDeadline = Date.now() + 240_000;
  while (Date.now() < readyDeadline) {
    abort.signal.throwIfAborted();
    if (containerError) throw containerError;
    if (container.exitCode !== null) throw new Error(`Display container exited (${container.exitCode}).`);
    try {
      const { stdout } = await execute('docker', ['port', name, '8080/tcp'], { timeout: 5_000 });
      if (!/^127\.0\.0\.1:\d+\s*$/.test(stdout)) throw new Error('Unexpected non-loopback display binding.');
      url = `http://${stdout.trim()}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.status === 403) break;
      throw new Error('Unauthenticated display did not fail closed.');
    } catch (error) {
      if (Date.now() + 1000 >= readyDeadline) throw error;
      await delay(1000);
    }
  }
  if (!url || Date.now() >= readyDeadline) throw new Error('Display readiness timed out.');
  const response = await fetch(url, {
    headers: { Cookie: `vspod_spike=${capability}` }, signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) throw new Error('Authenticated display page is unavailable.');
  await response.body?.cancel();
  for (const path of ['/novnc/core/rfb.js', '/socket']) {
    const denied = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5_000) });
    await denied.body?.cancel();
    if (denied.status !== 403) throw new Error(`Unauthenticated ${path} was not denied.`);
  }
  const module = await fetch(`${url}/novnc/core/rfb.js`, {
    headers: { Cookie: `vspod_spike=${capability}` }, signal: AbortSignal.timeout(5_000),
  });
  await module.body?.cancel();
  if (module.status !== 200) throw new Error('Authenticated noVNC module is unavailable.');
  const crossOrigin = await fetch(`${url}/socket`, {
    headers: { Cookie: `vspod_spike=${capability}`, Origin: 'https://invalid.example' },
    signal: AbortSignal.timeout(5_000),
  });
  await crossOrigin.body?.cancel();
  if (crossOrigin.status !== 403) throw new Error('Cross-origin socket request was not denied.');
  console.log('Gateway rejects unauthenticated access; opening isolated native host window.');
  const reportPath = join(root, 'display-status.json');
  host = spawn(binary, [], { stdio: ['pipe', 'inherit', 'inherit'] });
  let hostError;
  host.on('error', (error) => { hostError = error; });
  host.stdin.on('error', (error) => { hostError = error; });
  host.stdin.end(JSON.stringify({
    url, capability, reportPath, autoTest: true, snapshotPath,
    dropFixturePaths: dropFixture?.paths, dropReportPath: dropFixture?.reportPath,
  }));
  const sizes = new Set();
  const expected = new Set(['1100x750', '900x600', '1200x800']);
  const deadline = Date.now() + 75_000;
  let snapshotReady = !snapshotPath;
  while (Date.now() < deadline && (sizes.size < 3 || !snapshotReady)) {
    abort.signal.throwIfAborted();
    if (hostError) throw hostError;
    if (host.exitCode !== null) throw new Error('Native display client exited before acceptance.');
    let state;
    try { state = JSON.parse(await readFile(reportPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state?.connected) {
      const { stdout } = await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xrandr', '--current'], { timeout: 5_000 });
      const screen = /current (\d+) x (\d+)/.exec(stdout);
      if (screen && Number(screen[1]) === state.width && Number(screen[2]) === state.height) {
        const key = `${state.width}x${state.height}`;
        if (expected.has(key) && !sizes.has(key)) {
          const { stdout: windows } = await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'wmctrl', '-lG'], { timeout: 5_000 });
          const application = windows.trim().split('\n').find((line) => /Visual Studio Code/.test(line));
          const fields = application?.trim().split(/\s+/);
          if (!fields || Number(fields[2]) !== 0 || Number(fields[3]) !== 0 ||
              Number(fields[4]) !== state.width || Number(fields[5]) !== state.height) {
            throw new Error('VS Code client bounds do not fill the framebuffer.');
          }
          const { stdout: properties } = await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xprop', '-id', fields[0], '_NET_WM_STATE'], { timeout: 5_000 });
          if (!properties.includes('_NET_WM_STATE_FULLSCREEN')) throw new Error('VS Code is not fullscreen.');
          console.log(`Matched host content/framebuffer: ${key}`);
          console.log(windows.trim());
          sizes.add(key);
        }
        if (snapshotPath) {
          try { snapshotReady = (await stat(snapshotPath)).size > 0; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
    await delay(1000);
  }
  if (sizes.size < 3) throw new Error(`Resize acceptance failed; matched ${[...sizes].join(', ') || 'no sizes'}.`);
  if (!snapshotReady) throw new Error('Viewer snapshot did not complete.');
  const { stdout: editorLog } = await execute('docker', ['exec', name, 'cat', '/tmp/editor.log'], { timeout: 5_000 });
  if (/renderer process gone|No usable sandbox|FATAL|Zygote could not fork/.test(editorLog)) {
    console.error(editorLog);
    throw new Error('VS Code renderer failed despite a connected display.');
  }
  const { stdout: processes } = await execute('docker', ['exec', name, 'ps', '-eo', 'pid,args'], { timeout: 5_000 });
  // Forked Chromium renderers can retain their zygote's argv on Linux.
  let sandboxedRenderer = false;
  for (const match of processes.matchAll(/^\s*(\d+)\s+(?:\/tmp\/code\/code|\/proc\/self\/exe) --type=(?:zygote|renderer)\b.*$/gm)) {
    const { stdout: status } = await execute('docker', ['exec', name, 'cat', `/proc/${match[1]}/status`], { timeout: 5_000 });
    const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/);
    const filters = /^Seccomp_filters:\s+(\d+)$/m.exec(status);
    if (/^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status) &&
        /^CapEff:\s+0+$/m.test(status) && nspid && nspid.length >= 3 &&
        filters && Number(filters[1]) >= 2) {
      const { stdout: threads } = await execute('docker', ['exec', name, 'ps', '-T', '-p', match[1], '-o', 'comm='], { timeout: 5_000 });
      if (threads.includes('Compositor')) sandboxedRenderer = true;
    }
  }
  if (!sandboxedRenderer) throw new Error('Nested, seccomp-filtered renderer with a compositor thread not found.');
  console.log('Renderer: nested PID namespace, zero effective capabilities, no-new-privileges, multiple seccomp filters.');
  console.log('PASS: connected native viewer; fullscreen VS Code matched three host sizes, with no renderer failure.');
  if (clipboardTest) await testClipboard({ name, root, context, execute, signal: abort.signal });
  if (dropTest) await testDrop({ name, execute, signal: abort.signal, fixture: dropFixture });
} finally {
  host?.kill('SIGTERM');
  if (container) {
    await executeFile('docker', ['rm', '--force', name], { timeout: 15_000 }).catch((error) => {
      console.error('Unable to clean up isolated display container:', error.message);
      process.exitCode = 1;
    });
  }
  await rm(root, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
