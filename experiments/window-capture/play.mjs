import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptance } from './test.mjs';
import { benchmark } from './bench.mjs';
import { integrations } from './integrations.mjs';
import { menubarStress } from './menubar-stress.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--seccomp') throw new Error('Usage: node play.mjs --seccomp approved-profile.json');
const context = fileURLToPath(new URL('.', import.meta.url));
const previous = fileURLToPath(new URL('../rdp-spike/', import.meta.url));
const runner = fileURLToPath(new URL('../../packages/app-runner/', import.meta.url));
const name = `vspod-window-${randomBytes(6).toString('hex')}`;
const root = await realpath(await mkdtemp(join(tmpdir(), 'vspod-window-')));
const exec = promisify(execFile);
const execute = (file, args, options) => exec(file, args, { timeout: 10_000, maxBuffer: 8_000_000, ...options });
const bench = process.env.VSPOD_WINDOW_BENCH === '1';
const cpus = process.env.VSPOD_WINDOW_CPUS || '2';
const gpu = process.env.VSPOD_WINDOW_GPU || 'off';
if (!/^[1-8]$/.test(cpus) || !['off', 'swiftshader'].includes(gpu)) throw new Error('Invalid VSPOD_WINDOW_CPUS/VSPOD_WINDOW_GPU');
// Clipboard, drag-and-drop, URL handoff and edge-aware popups (Wayland only); runs instead of core acceptance.
const integrated = process.env.VSPOD_WINDOW_INTEGRATIONS === '1';
// Menu-bar hover stress (Wayland or X11); runs instead of core acceptance.
const stress = process.env.VSPOD_WINDOW_STRESS === '1';
const selftest = bench || integrated || stress || process.env.VSPOD_WINDOW_SELFTEST === '1';
// x11: Xvfb + openbox + agent.py. wayland: the smithay compositor in ../wayland-capture.
const backend = process.env.VSPOD_WINDOW_BACKEND || 'x11';
if (!['x11', 'wayland'].includes(backend)) throw new Error('Invalid VSPOD_WINDOW_BACKEND');
if (integrated && backend !== 'wayland') throw new Error('VSPOD_WINDOW_INTEGRATIONS needs VSPOD_WINDOW_BACKEND=wayland');
const wayland = backend === 'wayland';
const image = wayland ? 'vspod-experiment:wayland' : 'vspod-experiment:window-capture';
const imageContext = wayland ? fileURLToPath(new URL('../wayland-capture/', import.meta.url)) : context;
const logs = wayland ? '/tmp/editor.log /tmp/compositor.log' : '/tmp/editor.log /tmp/xorg.log /tmp/wm.log';
// Wayland buffer scale: 2 (default) for Retina sharpness, 1 to compare transfer cost with X11.
const scale = process.env.VSPOD_WINDOW_SCALE || '2';
if (!['1', '2'].includes(scale)) throw new Error('Invalid VSPOD_WINDOW_SCALE');
// Chromium's software compositor keeps several wl_shm buffers per window in /dev/shm; a 2400x1400 window at 2x
// is ~54 MB per buffer, and exhausting 128m kills the GPU process until VS Code aborts.
const shm = wayland ? '512m' : '128m';
const terminalGpu = process.env.VSPOD_TERMINAL_GPU || 'off';
if (!['auto', 'on', 'off'].includes(terminalGpu)) throw new Error('Invalid VSPOD_TERMINAL_GPU');
const controller = new AbortController();
const children = [];
let container, host, output = '', hostOutput = '', failure;
let closing = false;
function launch(file, args, options) {
  const child = spawn(file, args, options);
  child.on('error', (error) => { failure = error; });
  children.push(child);
  return child;
}
function check() {
  controller.signal.throwIfAborted();
  if (failure) throw failure;
  for (const child of [container, host]) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Spike process exited: ${child.exitCode}/${child.signalCode}`);
  }
}
const interrupt = () => controller.abort(new Error('Interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await execute('node', [join(runner, 'build.mjs'), '--host'], { timeout: 120_000 });
  const { containerArguments, writeHostConfiguration } = await import(join(runner, 'dist/index.mjs'));
  if (wayland) {
    await execute('docker', ['build', '-t', 'vspod-app-runner:dev', '-f', join(runner, 'guest/Dockerfile'), runner], { timeout: 900_000 });
  } else {
    await execute('docker', ['build', '-t', 'vspod-experiment:rdp', previous], { timeout: 900_000 });
  }
  await execute('docker', ['build', '-t', image, imageContext], { timeout: 900_000 });
  const binary = join(runner, 'dist/app-host');
  if (wayland) {
    await execute('docker', containerArguments({
      id: name, image, seccompProfile: args[1], workdir: '/tmp',
      command: ['/tmp/code/code', '--ozone-platform=wayland', '--disable-gpu', '--disable-extensions',
        '--user-data-dir=/tmp/user-data', '--extensions-dir=/tmp/extensions',
        '--new-window', '/tmp/workspace', '/tmp/workspace/first.txt'],
      mounts: [], resources: { cpus: Number(cpus), memoryMiB: 2048, pids: 512, shmMiB: 512, tmpMiB: 1024 },
      scale: Number(scale), exportRoots: ['/tmp/workspace'],
      integrations: { clipboard: true, files: true, externalUrls: true }, electronMenuNudge: true,
      environment: { VSPOD_TERMINAL_GPU: terminalGpu },
      pointerTrace: process.env.VSPOD_POINTER_TRACE === '1',
    }));
    container = launch('docker', ['start', '--attach', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    container = launch('docker', ['run', '--rm', '--name', name, '--init', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${args[1]}`,
    '--read-only', '--pids-limit', '512', '--memory', '2g', '--cpus', cpus, '--env', `VSPOD_CODE_GPU=${gpu}`, '--env', `VSPOD_SCALE=${scale}`, '--env', `VSPOD_TERMINAL_GPU=${terminalGpu}`, '--env', `VSPOD_POINTER_TRACE=${process.env.VSPOD_POINTER_TRACE === '1' ? '1' : '0'}`, '--shm-size', shm,
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700',
    image], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  for (const stream of [container.stdout, container.stderr]) {
    stream.on('data', (data) => { output += data; process.stdout.write(data); });
  }
  const wait = async (predicate, label, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) {
      check();
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await delay(100);
    }
  };
  await wait(() => output.includes(wayland ? 'APP_RUNNER_READY' : 'WINDOW_CAPTURE_READY'), 'guest startup', 240_000);
  const hostConfiguration = await writeHostConfiguration(root, {
    container: name, protocol: backend, integrations: { clipboard: true, files: true, externalUrls: true },
    stopGuestOnQuit: true,
  });
  host = launch(binary, [hostConfiguration], { env: { ...process.env, VSPOD_WINDOW_SELFTEST: selftest ? '1' : '0' }, stdio: ['pipe', 'pipe', 'inherit'] });
  host.stdin.on('error', (error) => { if (!closing) failure = error; });
  host.stdout.on('data', (data) => { hostOutput += data; process.stdout.write(data); });
  await wait(() => hostOutput.includes('WINDOW_FRAME'), 'native Metal window');
  console.log(`WINDOW_PLAY_READY container=${name}`);
  if (bench) {
    await benchmark({ root, wait, output: () => hostOutput, send: (request) => host.stdin.write(`${JSON.stringify(request)}\n`) });
    closing = true;
  } else if (stress) {
    await menubarStress({ name, execute, wait, output: () => hostOutput, send: (request) => host.stdin.write(`${JSON.stringify(request)}\n`) });
    closing = true;
  } else if (integrated) {
    await integrations({
      name, root, execute, wait,
      output: () => hostOutput,
      send: (request) => host.stdin.write(`${JSON.stringify(request)}\n`),
    });
    console.log('WINDOW_INTEGRATIONS_PASS');
    closing = true;
  } else if (selftest) {
    await acceptance({
      name, root, execute, wait, check, wayland,
      output: () => hostOutput,
      send: (request) => host.stdin.write(`${JSON.stringify(request)}\n`),
    });
    console.log('WINDOW_ACCEPTANCE_PASS');
    closing = true;
  }
  const closeDeadline = Date.now() + 10_000;
  while (host.exitCode === null && host.signalCode === null) {
    if (!closing) check();
    if (selftest && Date.now() > closeDeadline) throw new Error('Final native window did not close the session');
    await delay(100);
  }
  if (host.exitCode !== 0) throw new Error(`Native host failed: ${host.exitCode}/${host.signalCode}`);
  if (selftest && !bench && !integrated) {
    const mains = [...hostOutput.matchAll(/WINDOW_CREATED id=(\d+) popup=false owner=0 dialog=false/g)];
    for (const [, id] of mains) {
      if (!hostOutput.includes(`WINDOW_DESTROYED id=${id}`)) throw new Error('Missing final guest window destruction');
    }
    console.log('PASS last-window close ended the host cleanly');
  }
} catch (error) {
  if (!controller.signal.aborted) {
    console.error('Window capture spike failed:', error);
    process.exitCode = 1;
    if (container) {
      try {
        console.error((await execute('docker', ['exec', name, 'sh', '-c', `tail -n 25 ${logs}`])).stdout);
        if (process.env.VSPOD_WINDOW_EVIDENCE && !wayland) {
          await execute('docker', ['exec', '--env', 'DISPLAY=:11', name, 'scrot', '/tmp/failure.png']);
          const image = (await execute('docker', ['exec', name, 'cat', '/tmp/failure.png'], { encoding: 'buffer' })).stdout;
          await mkdir(process.env.VSPOD_WINDOW_EVIDENCE, { recursive: true });
          await writeFile(join(process.env.VSPOD_WINDOW_EVIDENCE, 'failure.png'), image);
        }
      } catch (diagnostic) { console.error('Cannot collect diagnostics:', diagnostic.message); }
    }
  }
} finally {
  closing = true;
  for (const child of children) {
    if (child !== container && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  try { if (container) await execute('docker', ['rm', '-f', name], { timeout: 15_000 }); }
  finally {
    await rm(root, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  console.log('Window spike closed; disposable container and runtime removed.');
}
