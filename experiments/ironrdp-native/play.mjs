import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import assert from 'node:assert/strict';
import { run } from '../desktop-spike/clipboard.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--seccomp') {
  throw new Error('Usage: node play.mjs --seccomp <approved-profile.json>');
}
const context = fileURLToPath(new URL('.', import.meta.url));
const serverContext = fileURLToPath(new URL('../rdp-spike/', import.meta.url));
const desktopContext = fileURLToPath(new URL('../desktop-spike/', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'vspod-iron-native-'));
const name = `vspod-iron-native-${randomBytes(6).toString('hex')}`;
const selftest = process.env.VSPOD_IRON_SELFTEST === '1';
const transferTest = process.env.VSPOD_IRON_TRANSFER_SELFTEST === '1';
const abort = new AbortController();
const exec = promisify(execFile);
const execute = (file, args, options) => exec(file, args, { signal: abort.signal, ...options });
const children = [];
const listener = net.createServer();
let container, viewer, socket, clipboardAgent;
let output = '', hostOutput = '', failure;
let closing = false;
function launch(command, args, options) {
  const child = spawn(command, args, options);
  child.on('error', (error) => { failure = error; console.error(error); });
  children.push(child);
  return child;
}
function check() {
  abort.signal.throwIfAborted();
  if (failure) throw failure;
  if (container && (container.exitCode !== null || container.signalCode !== null)) {
    throw new Error(`Container exited (${container.exitCode}/${container.signalCode}): ${output}`);
  }
  if (clipboardAgent && (clipboardAgent.exitCode !== null || clipboardAgent.signalCode !== null)) {
    throw new Error('Guest clipboard agent exited');
  }
}
const interrupt = () => { closing = true; abort.abort(new Error('Playground interrupted')); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await execute('cargo', ['build', '--locked', '--release', '--manifest-path', join(context, 'Cargo.toml')],
    { timeout: 900_000, maxBuffer: 8_000_000 });
  const binary = join(context, 'target/release/iron-native');
  if (selftest) {
    const inputTests = join(root, 'input-tests');
    await execute('swiftc', ['-warnings-as-errors', join(context, 'InputTests.swift'),
      fileURLToPath(new URL('../../packages/app-runner/host/macos/InputView.swift', import.meta.url)), '-o', inputTests, '-framework', 'AppKit'], { timeout: 60_000 });
    const tested = await execute(inputTests, [], { timeout: 10_000 });
    console.log(tested.stdout.trim());
  }
  await execute('swiftc', ['-O', '-import-objc-header', join(context, 'Bridge.h'),
    join(context, 'main.swift'), fileURLToPath(new URL('../../packages/app-runner/host/macos/InputView.swift', import.meta.url)),
    join(context, 'Transfers.swift'),
    join(context, 'TransferTests.swift'),
    join(context, 'target/release/libvspod_ironrdp_native.a'),
    '-o', binary, '-framework', 'AppKit', '-framework', 'MetalKit', '-framework', 'Metal',
    '-framework', 'Security', '-framework', 'SystemConfiguration', '-lresolv', '-lz', '-liconv'],
  { timeout: 120_000 });
  await execute('docker', ['build', '-t', 'vspod-experiment:rdp', serverContext],
    { timeout: 900_000, maxBuffer: 8_000_000 });
  await execute('docker', ['build', '-t', 'vspod-experiment:iron-native', context],
    { timeout: 900_000, maxBuffer: 8_000_000 });
  container = launch('docker', ['run', '--rm', '--name', name, '--init', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${args[1]}`,
    '--read-only', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--shm-size', '128m',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/run/xrdp:rw,nosuid,nodev,size=4m,uid=1000,gid=1000,mode=0700',
    'vspod-experiment:iron-native'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [container.stdout, container.stderr]) {
    stream.on('data', (data) => { output += data; process.stdout.write(data); });
  }
  const deadline = Date.now() + 240_000;
  while (!output.includes('RDP_SPIKE_READY')) {
    check();
    if (Date.now() > deadline) throw new Error(`Server readiness timed out: ${output}`);
    await delay(100);
  }
  for (const script of ['clipboard-agent.py', 'xdnd.py']) {
    const writer = launch('docker', ['exec', '-i', name, 'sh', '-c', 'cat > "$1"', 'stage-script',
      `/tmp/runtime/${script}`], { stdio: ['pipe', 'ignore', 'inherit'] });
    writer.stdin.on('error', (error) => { failure = error; });
    writer.stdin.end(await readFile(join(desktopContext, script)));
    await new Promise((resolve, reject) => {
      writer.once('error', reject);
      writer.once('close', (code) => code === 0 ? resolve() : reject(new Error('Cannot stage transfer helper')));
    });
  }
  clipboardAgent = launch('docker', ['exec', '--env', 'DISPLAY=:10', name,
    'python3', '/tmp/runtime/clipboard-agent.py', 'serve'], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (let attempt = 0; ; attempt++) {
    check();
    const { stdout } = await execute('docker', ['exec', name, 'sh', '-c',
      'test ! -S /tmp/runtime/clipboard.sock || printf ready'], { timeout: 5_000 });
    if (stdout === 'ready') break;
    if (attempt === 49) throw new Error('Guest clipboard agent readiness timed out');
    await delay(100);
  }
  const transferRoot = await realpath(root);
  await mkdir(join(transferRoot, 'exports'), { mode: 0o700 });
  const fixture = join(transferRoot, 'fixtures');
  if (transferTest) {
    await mkdir(join(fixture, 'folder', 'empty'), { recursive: true, mode: 0o700 });
    await mkdir(join(fixture, 'drop-folder'), { mode: 0o700 });
    await writeFile(join(fixture, 'single.txt'), 'host file bytes\n');
    await writeFile(join(fixture, 'folder', 'binary.bin'), Buffer.from([0, 17, 128, 255]));
    await writeFile(join(fixture, 'drop.txt'), 'host drop bytes\n');
    await writeFile(join(fixture, 'drop-folder', 'nested.txt'), 'nested drop bytes\n');
    await execute('docker', ['exec', name, 'touch', '/tmp/workspace/clipboard.md'], { timeout: 5_000 });
  }
  const { stdout } = await execute('docker', ['exec', name, 'openssl', 'x509', '-in', '/tmp/rdp-cert.pem',
    '-noout', '-fingerprint', '-sha256'], { timeout: 5_000 });
  const fingerprint = stdout.trim().split('=')[1];
  assert.match(fingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  listener.once('connection', (connection) => {
    socket = connection;
    socket.setNoDelay(true);
    listener.close();
    const bridge = launch('docker', ['exec', '-i', name, 'socat', 'STDIO', 'TCP:127.0.0.1:3389,nodelay'],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    const transportError = (error) => { if (!closing) { failure = error; console.error(error); } };
    socket.on('error', transportError);
    bridge.stdin.on('error', transportError);
    socket.pipe(bridge.stdin);
    bridge.stdout.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const snapshot = join(root, 'snapshot.png');
  viewer = launch(binary, [`127.0.0.1:${listener.address().port}`, fingerprint], {
    env: { ...process.env, VSPOD_IRON_SNAPSHOT: snapshot,
      VSPOD_TRANSFER_NODE: process.execPath, VSPOD_TRANSFER_SCRIPT: join(context, 'transfers.mjs'),
      VSPOD_TRANSFER_CONTAINER: name, VSPOD_TRANSFER_ROOT: join(transferRoot, 'exports'),
      VSPOD_IRON_TEST_BOARD: `org.vspod.clipboard-spike.${randomBytes(16).toString('hex')}`,
      VSPOD_IRON_TRANSFER_FIXTURE: fixture },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  viewer.stdout.on('data', (data) => { hostOutput += data; process.stdout.write(data); });
  const frameDeadline = Date.now() + 30_000;
  while (!hostOutput.includes('IRON_NATIVE_READY')) {
    check();
    if (viewer.exitCode !== null || viewer.signalCode !== null) throw new Error('IronRDP native host failed before first frame');
    if (Date.now() > frameDeadline) throw new Error('No native Metal frame in 30 seconds');
    await delay(100);
  }
  console.log(`IRON_PLAY_READY container=${name}`);
  console.log('Close the native window or Cmd+Q to clean up. Cmd shortcuts map to Linux Ctrl.');
  const sizes = new Set();
  let terminalChecked = false;
  const selftestDeadline = Date.now() + (transferTest ? 150_000 : 60_000);
  while (viewer.exitCode === null && viewer.signalCode === null) {
    check();
    if (transferTest && !terminalChecked && hostOutput.includes('IRON_TRANSFER_TERMINAL_PENDING')) {
      await execute('docker', ['exec', name, 'test', '!', '-e', '/tmp/clipboard-executed'], { timeout: 5_000 });
      await writeFile(join(fixture, 'terminal-paste-checked'), '');
      terminalChecked = true;
    }
    if (transferTest && Date.now() > selftestDeadline) throw new Error('Native transfer selftest timed out');
    if (selftest) {
      if (Date.now() > selftestDeadline) throw new Error('Native selftest timed out');
      const currentTexture = [...hostOutput.matchAll(/IRON_TEXTURE=(\d+x\d+)/g)].at(-1)?.[1];
      if (currentTexture && !sizes.has(currentTexture)) {
        const { stdout } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'sh', '-c',
          'xrandr --current; wmctrl -lG'],
          { timeout: 5_000 });
        const editor = stdout.split('\n').find((line) => /Visual Studio Code/.test(line));
        const geometry = editor?.trim().split(/\s+/).slice(2, 6).map(Number);
        const desktop = /current (\d+) x (\d+)/.exec(stdout);
        if (geometry?.[0] === 0 && geometry[1] === 0 && desktop &&
            geometry[2] === Number(desktop[1]) && geometry[3] === Number(desktop[2]) &&
            `${geometry[2]}x${geometry[3]}` === currentTexture) {
          sizes.add(currentTexture);
        }
      }
    }
    await delay(selftest ? 200 : 100);
  }
  closing = true;
  if (viewer.exitCode !== 0) throw new Error(`Native host failed (${viewer.exitCode}/${viewer.signalCode})`);
  if (transferTest) {
    assert.ok(hostOutput.includes('IRON_TRANSFERS_PASS'), 'Missing native transfer acceptance');
    const cat = async (path) => (await execute('docker', ['exec', name, 'cat', path],
      { timeout: 5_000, encoding: 'buffer' })).stdout;
    assert.equal((await cat('/tmp/workspace/rdp.txt')).toString(), 'Clipboard café 日本語 😀\n\tcolumns\n\nlast line\n');
    assert.equal((await cat('/tmp/workspace/single.txt')).toString(), 'host file bytes\n');
    assert.deepEqual(await cat('/tmp/workspace/folder/binary.bin'), Buffer.from([0, 17, 128, 255]));
    await execute('docker', ['exec', name, 'test', '-d', '/tmp/workspace/folder/empty'], { timeout: 5_000 });
    assert.equal((await cat('/tmp/workspace/folder/drop.txt')).toString(), 'host drop bytes\n');
    assert.equal((await cat('/tmp/workspace/folder/drop-folder/nested.txt')).toString(), 'nested drop bytes\n');
    assert.ok(terminalChecked, 'Terminal paste safety was not checked');
    assert.ok(hostOutput.includes('IRON_TRANSFER_TERMINAL_PASS'), 'Missing multiline terminal clipboard acceptance');
    await execute('docker', ['exec', name, 'test', '-e', '/tmp/clipboard-executed'], { timeout: 5_000 });
    const markdown = (await cat('/tmp/workspace/clipboard.md')).toString();
    const reference = /!\[[^\]]*\]\(([^)]+)\)/.exec(markdown)?.[1];
    assert.ok(reference && !reference.startsWith('/') && !reference.includes('..'), 'Missing pasted Markdown image');
    const inspector = join(root, 'inspect-image');
    await execute('swiftc', [join(desktopContext, 'Pasteboard.swift'), '-o', inspector, '-framework', 'AppKit'], { timeout: 60_000 });
    const pixels = async (data) => JSON.parse(await run(inspector, [], {
      board: `org.vspod.clipboard-spike.${randomBytes(16).toString('hex')}`,
      action: 'inspect', data: data.toString('base64'),
    }, abort.signal)).pixels;
    assert.deepEqual(await pixels(await cat(`/tmp/workspace/${decodeURIComponent(reference)}`)),
      await pixels(await readFile(join(fixture, 'fixture.png'))));
    const { stdout: titles } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'wmctrl', '-l'], { timeout: 5_000 });
    assert.match(titles, /drop\.txt/, 'Editor drop did not open transferred file');
    console.log('PASS: native clipboard text/image/files and real Explorer/editor drops; normal host clipboard untouched.');
  }
  if (selftest) {
    assert.ok(hostOutput.includes('IRON_CURSOR_SHAPES_PASS'), 'Missing contextual cursor acceptance');
    const { stdout: text } = await execute('docker', ['exec', name, 'cat', '/tmp/workspace/rdp.txt'], { timeout: 5_000 });
    assert.equal(text, 'Native Iron input verified\nSecond line');
    for (const size of ['1100x750', '1000x680', '1200x800']) {
      assert.ok(sizes.has(size), `Missing actual fullscreen editor size ${size}: ${[...sizes]}`);
      assert.ok(hostOutput.includes(`IRON_TEXTURE=${size}`), `Missing native Metal texture ${size}`);
    }
    const { stdout: geometry } = await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'xrandr', '--current'],
      { timeout: 5_000 });
    assert.match(geometry, /current 1200 x 800/);
    await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'scrot', '/tmp/source.png'], { timeout: 5_000 });
    const { stdout: source } = await execute('docker', ['exec', name, 'cat', '/tmp/source.png'],
      { timeout: 5_000, encoding: 'buffer', maxBuffer: 8_000_000 });
    await writeFile(join(root, 'source.png'), source);
    const compare = join(root, 'compare');
    await execute('swiftc', [join(serverContext, 'Compare.swift'), '-o', compare, '-framework', 'AppKit'],
      { timeout: 60_000 });
    const comparison = await execute(compare, [snapshot, join(root, 'source.png')], { timeout: 15_000 });
    console.log(comparison.stdout.trim());
    if (process.env.VSPOD_IRON_SAVE_SNAPSHOT) {
      await writeFile(process.env.VSPOD_IRON_SAVE_SNAPSHOT, await readFile(snapshot));
      await writeFile(`${process.env.VSPOD_IRON_SAVE_SNAPSHOT}.source.png`, source);
    }
    console.log('PASS: native input saved actual VS Code text; X/editor/Metal sizes matched at three sizes; Metal drawable matched X screenshot.');
    assert.ok(hostOutput.includes('IRON_TERMINAL_SCROLL_PASS'), 'Terminal scroll gate failed; see IRON_TERMINAL_SCROLL_FAIL diagnostics');
  }
} catch (error) {
  if (!abort.signal.aborted) {
    console.error('IronRDP native playground failed:', error);
    process.exitCode = 1;
    if (container) {
      try {
        const logs = await execute('docker', ['exec', name, 'sh', '-c', 'tail -n 25 /tmp/xrdp.log /tmp/Xorg.log'],
          { timeout: 5_000, signal: undefined });
        console.error(logs.stdout);
        if ((selftest || transferTest) && process.env.VSPOD_IRON_SAVE_SNAPSHOT) {
          await execute('docker', ['exec', '--env', 'DISPLAY=:10', name, 'scrot', '/tmp/failure.png'],
            { timeout: 5_000 });
          const { stdout: screenshot } = await execute('docker', ['exec', name, 'cat', '/tmp/failure.png'],
            { timeout: 5_000, encoding: 'buffer', maxBuffer: 8_000_000 });
          await writeFile(`${process.env.VSPOD_IRON_SAVE_SNAPSHOT}.failure.png`, screenshot);
        }
      } catch (failure) { console.error('Cannot retrieve server diagnostics:', failure.message); }
    }
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
  console.log('IronRDP playground closed; disposable container and runtime removed.');
}
