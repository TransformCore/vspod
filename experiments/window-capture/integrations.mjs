import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { settledMatch } from './test.mjs';

// A tiny valid PNG (solid colour), so image paths never depend on host files.
function png(width, height, rgb) {
  const crc = (buffer) => {
    let c = ~0;
    for (const byte of buffer) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from(rgb))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

export async function integrations({ name, root, execute, wait, output, send }) {
  const cmd = 1 << 20, shift = 1 << 17;
  const first = Number(output().match(/WINDOW_CREATED id=(\d+) popup=false owner=0 dialog=false/)[1]);
  const key = async (code, flags = 0, id = first) => { send({ action: 'testKey', id, code, flags }); await delay(80); };
  const click = async (x, y, button = 'left', id = first) => { send({ action: 'testClick', id, x, y, button }); await delay(400); };
  const letters = { a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,
    y:16,t:17,o:31,u:32,i:34,p:35,l:37,j:38,k:40,n:45,m:46,' ':49,'.':47,'-':27 };
  const type = async (text) => { for (const character of text) await key(letters[character]); };
  const guest = async (...args) => execute('docker', ['exec', name, ...args]);
  const read = async (path) => (await guest('cat', path)).stdout;
  const exists = async (path) => (await guest('test', '-e', path).then(() => true, () => false));
  const count = (pattern) => (output().match(new RegExp(pattern, 'g')) || []).length;
  // Waits for the next occurrence of a host log line after the current output.
  const next = async (pattern, label, timeout = 15_000) => {
    const offset = output().length;
    return async () => {
      await wait(() => new RegExp(pattern).test(output().slice(offset)), label, timeout);
      return output().slice(offset).match(new RegExp(pattern));
    };
  };
  const pasteboard = async (tag) => {
    send({ action: 'readPasteboard', id: first, tag });
    await wait(() => output().includes(`WINDOW_PASTEBOARD tag=${tag}`), `pasteboard ${tag}`);
    return JSON.parse(await readFile(join(root, `${tag}.pasteboard.json`)));
  };
  const writePasteboard = async (body) => {
    const before = count('WINDOW_PASTEBOARD_WRITTEN');
    send({ action: 'writePasteboard', id: first, ...body });
    await wait(() => count('WINDOW_PASTEBOARD_WRITTEN') > before, 'pasteboard write');
  };
  const evidence = async (tag) => {
    if (!process.env.VSPOD_WINDOW_EVIDENCE) return;
    send({ action: 'snapshot', id: first, tag });
    await wait(() => output().includes(`WINDOW_SNAPSHOT tag=${tag} `), `snapshot ${tag}`);
    await mkdir(process.env.VSPOD_WINDOW_EVIDENCE, { recursive: true });
    await writeFile(join(process.env.VSPOD_WINDOW_EVIDENCE, `${tag}.png`), await readFile(join(root, `${tag}.png`)));
  };
  const quickOpen = async (file) => {
    await key(35, cmd);
    await delay(600);
    await type(file);
    await delay(700);
    await key(36);
    await delay(1200);
  };

  await delay(8000);
  await settledMatch({ root, wait, output, send }, first, 'integrations-startup');

  // Host -> guest text: Unicode and multiple lines survive byte-for-byte through Cmd+V.
  const text = 'Héllo wörld ✓ 世界 🚀\n\tindented line\nlast line without newline';
  await writePasteboard({ kind: 'text', text });
  await click(450, 160);
  await key(0, cmd);
  let set = await next('WINDOW_CLIPBOARD_SET kind=text', 'host text clipboard');
  await key(9, cmd);
  await set();
  await delay(500);
  await key(1, cmd);
  await delay(700);
  assert.equal(await read('/tmp/workspace/first.txt'), text);
  console.log('PASS host Unicode multi-line text pasted into the editor byte-for-byte');

  // Guest -> host text: a user copy (Cmd+C) reaches the macOS pasteboard.
  await key(0, cmd);
  let copied = await next('WINDOW_CLIPBOARD text bytes=(\\d+)', 'guest text copy');
  await key(8, cmd);
  await copied();
  assert.deepEqual(await pasteboard('guest-text'), { kind: 'text', text });
  console.log('PASS guest editor copy reached the host pasteboard');

  // Large text in both directions (~1 MiB).
  const large = Array.from({ length: 16_000 }, (_, i) => `large clipboard line ${i} ${'x'.repeat(40)}`).join('\n');
  await writePasteboard({ kind: 'text', text: large });
  await key(0, cmd);
  set = await next('WINDOW_CLIPBOARD_SET kind=text', 'large host clipboard');
  await key(9, cmd);
  await set();
  await delay(2500);
  await key(1, cmd);
  await delay(1500);
  const saved = await read('/tmp/workspace/first.txt');
  assert.equal(createHash('sha256').update(saved).digest('hex'), createHash('sha256').update(large).digest('hex'),
    `large paste differs (${saved.length} vs ${large.length} bytes)`);
  await key(0, cmd);
  copied = await next('WINDOW_CLIPBOARD text bytes=(\\d+)', 'large guest copy', 30_000);
  await key(8, cmd);
  assert.equal(Number((await copied())[1]), Buffer.byteLength(large));
  assert.equal((await pasteboard('guest-large')).text, large);
  console.log(`PASS ${Buffer.byteLength(large)}-byte text pasted and copied back intact`);

  // Host -> guest files: Cmd+V in the Explorer copies a host folder (with a nested file) into the workspace.
  const hostFiles = join(root, 'host-files');
  await mkdir(join(hostFiles, 'pasted', 'nested'), { recursive: true });
  await writeFile(join(hostFiles, 'pasted', 'alpha.txt'), 'alpha from the host\n');
  await writeFile(join(hostFiles, 'pasted', 'nested', 'beta.txt'), 'beta from the host\n');
  await writePasteboard({ kind: 'files', paths: [join(hostFiles, 'pasted')] });
  await click(150, 500);
  set = await next('WINDOW_CLIPBOARD_SET kind=files', 'host files clipboard');
  await key(9, cmd);
  await set();
  await wait(() => exists('/tmp/workspace/pasted/nested/beta.txt'), 'pasted files in the workspace');
  assert.equal(await read('/tmp/workspace/pasted/alpha.txt'), 'alpha from the host\n');
  assert.equal(await read('/tmp/workspace/pasted/nested/beta.txt'), 'beta from the host\n');
  await evidence('integrations-files-pasted');
  console.log('PASS host folder pasted into the Explorer');

  // Guest -> host files: copying a workspace file in the Explorer gives macOS a private copy of it.
  await guest('sh', '-c', 'printf "exported from the guest\\n" > /tmp/workspace/export.txt');
  await delay(1500);
  await quickOpen('export.txt');
  await key(53);
  // Focus the Explorer; autoReveal has already selected the active file there.
  await key(14, cmd | shift);
  await delay(800);
  copied = await next('WINDOW_CLIPBOARD files entries=1', 'guest file copy');
  await key(8, cmd);
  await copied();
  const exported = await pasteboard('guest-files');
  assert.equal(exported.kind, 'files');
  assert.equal(exported.paths.length, 1);
  assert.ok(exported.paths[0].startsWith(join(root, 'transfers')), `export outside the private root: ${exported.paths[0]}`);
  assert.equal(await readFile(exported.paths[0], 'utf8'), 'exported from the guest\n');
  console.log('PASS guest Explorer file copy reached the host as a private file');

  // Host -> guest image: a PNG pasted into Markdown becomes a workspace image file.
  const image = png(48, 32, [0x20, 0x90, 0xe0]);
  await guest('sh', '-c', 'printf "# Notes\\n\\n" > /tmp/workspace/notes.md');
  await delay(1500);
  await quickOpen('notes.md');
  await key(53);
  await key(125, cmd);
  await writePasteboard({ kind: 'image', data: image.toString('base64') });
  // The Markdown extension (which owns image paste) activates lazily, so allow a retry.
  await delay(5000);
  const images = async () => (await guest('sh', '-c', 'ls /tmp/workspace')).stdout.split('\n').filter((file) => file.endsWith('.png'));
  let listed = [];
  for (let attempt = 0; attempt < 3 && !listed.length; attempt++) {
    set = await next('WINDOW_CLIPBOARD_SET kind=image', 'host image clipboard');
    await key(9, cmd);
    await set();
    await delay(3000);
    await key(1, cmd);
    await delay(1000);
    listed = await images();
  }
  assert.equal(listed.length, 1, `expected one pasted image, got ${listed}`);
  assert.ok(Buffer.compare(Buffer.from((await guest('base64', '-w0', `/tmp/workspace/${listed[0]}`)).stdout, 'base64'), image) === 0,
    'pasted image differs from the host PNG');
  assert.match(await read('/tmp/workspace/notes.md'), new RegExp(`!\\[.*\\]\\(${listed[0].replace('.', '\\.')}\\)`));
  await evidence('integrations-image-pasted');
  console.log(`PASS host PNG pasted into Markdown as ${listed[0]}`);

  // Finder drops: a file dropped on the editor opens; a file dropped on the Explorer is copied in.
  await writeFile(join(hostFiles, 'dropped-open.txt'), 'opened by drop\n');
  let dropped = await next('WINDOW_DROP result=(\\w+)', 'editor drop');
  send({ action: 'testDrop', id: first, x: 450, y: 300, paths: [join(hostFiles, 'dropped-open.txt')] });
  assert.equal((await dropped())[1], 'dropped');
  await wait(() => /WINDOW_META id=\d+ .*title=dropped-open\.txt/.test(output()), 'dropped file opened in the editor');
  console.log('PASS Finder drop onto the editor opened the file');
  await writeFile(join(hostFiles, 'dropped-copy.txt'), 'copied by drop\n');
  dropped = await next('WINDOW_DROP result=(\\w+)', 'explorer drop');
  send({ action: 'testDrop', id: first, x: 150, y: 500, paths: [join(hostFiles, 'dropped-copy.txt')] });
  assert.equal((await dropped())[1], 'dropped');
  await wait(() => exists('/tmp/workspace/dropped-copy.txt'), 'dropped file copied into the workspace');
  assert.equal(await read('/tmp/workspace/dropped-copy.txt'), 'copied by drop\n');
  await evidence('integrations-dropped');
  console.log('PASS Finder drop onto the Explorer copied the file into the workspace');

  // URL handoff: xdg-open reaches macOS only after a user gesture, once per gesture, and only for web URLs.
  await key(53);
  let opened = await next('WINDOW_OPEN url=(\\S+)', 'xdg-open');
  await guest('xdg-open', 'https://example.com/vspod?from=guest');
  assert.equal((await opened())[1], 'https://example.com/vspod?from=guest');
  let rejected = await next('WINDOW_OPEN_REJECTED reason=(.+)', 'second open without a gesture');
  await guest('xdg-open', 'https://example.com/again');
  assert.equal((await rejected())[1], 'no recent input');
  await key(53);
  rejected = await next('WINDOW_OPEN_REJECTED reason=(.+)', 'file URL');
  await guest('xdg-open', 'file:///etc/passwd');
  assert.equal((await rejected())[1], 'unsupported URL');
  await key(53);
  rejected = await next('WINDOW_OPEN_REJECTED reason=(.+)', 'loopback URL');
  await guest('xdg-open', 'http://localhost:3000/');
  assert.equal((await rejected())[1], 'host policy');
  console.log('PASS xdg-open forwards gesture-backed web URLs and rejects repeats, file: and loopback URLs');
  // End to end from VS Code: Help: Documentation via the command palette uses Electron's openExternal.
  opened = await next('WINDOW_OPEN url=(https://\\S+)', 'VS Code external link', 20_000);
  await key(35, cmd | shift);
  await delay(600);
  await type('documentation');
  await delay(900);
  await key(36);
  console.log(`PASS VS Code opened ${(await opened())[1]} in the host browser path`);

  // Edge-aware popups: with the window at the bottom of the screen, a context menu flips up and stays visible.
  const frames = async () => {
    const offset = output().length;
    send({ action: 'frames' });
    await wait(() => output().slice(offset).includes('WINDOW_FRAMES '), 'frames');
    return JSON.parse(output().slice(offset).match(/WINDOW_FRAMES (.+)/)[1]);
  };
  // Opens a context menu at content point (450, 600) and returns its Cocoa frame and the pointer's Cocoa y.
  const contextMenu = async (y) => {
    send({ action: 'nativeMove', id: first, x: 60, y });
    await delay(800);
    const popups = count('WINDOW_CREATED id=\\d+ popup=true');
    await click(450, 600, 'right');
    await wait(() => count('WINDOW_CREATED id=\\d+ popup=true') > popups, 'context menu');
    await delay(800);
    const menu = [...output().matchAll(/WINDOW_CREATED id=(\d+) popup=true/g)].at(-1)[1];
    const state = await frames();
    const [, windowY, width] = state.windows[first];
    const [guestWidth, guestHeight] = [...output().matchAll(new RegExp(`WINDOW_META id=${first} size=(\\d+)x(\\d+)`, 'g'))]
      .at(-1).slice(1).map(Number);
    const contentHeight = guestHeight * width / guestWidth;
    await evidence(`integrations-menu-${y}`);
    await key(53);
    await delay(500);
    return { screen: state.screen, menu: state.windows[menu], pointer: windowY + contentHeight - 600 };
  };
  const { screen: [, , , screenHeight] } = await frames();
  const middle = await contextMenu(100);
  assert.ok(Math.abs(middle.menu[1] + middle.menu[3] - middle.pointer) <= 2,
    `mid-screen menu should open downwards from the pointer: ${JSON.stringify(middle)}`);
  const [, , , height] = (await frames()).windows[first];
  const edge = await contextMenu(screenHeight - height);
  assert.ok(edge.menu[1] >= edge.screen[1] - 1, `menu extends below the visible screen: ${JSON.stringify(edge)}`);
  assert.ok(Math.abs(edge.menu[1] - edge.pointer) <= 2, `menu did not flip above the pointer: ${JSON.stringify(edge)}`);
  console.log(`PASS context menu opens downwards mid-screen and flips above the pointer at the screen edge (${edge.menu[3]} pt tall)`);
  send({ action: 'stop' });
}
