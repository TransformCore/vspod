import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, readdir, symlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const limit = 8 * 1024 * 1024;
export function run(file, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let failure;
    const timer = setTimeout(() => { failure = new Error('Clipboard subprocess timed out.'); child.kill('SIGKILL'); }, 20_000);
    child.stdout.on('data', (data) => {
      bytes += data.length;
      if (bytes > 24 * 1024 * 1024) { failure = new Error('Clipboard output exceeds limit.'); child.kill('SIGKILL'); }
      else chunks.push(data);
    });
    child.stderr.on('data', (data) => { if (stderr.length < 4096) stderr += data; });
    child.on('error', (error) => { failure = error; });
    child.stdin.on('error', (error) => { failure = error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Clipboard subprocess failed (${code}): ${stderr}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export async function manifest(paths) {
  const entries = [];
  let total = 0;
  const top = new Set();
  async function append(path, relative) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('Symlinks are not transferred.');
    if (entries.length >= 100) throw new Error('Too many files.');
    if (metadata.isDirectory()) {
      entries.push({ path: relative, kind: 'directory' });
      for (const child of (await readdir(path)).sort()) await append(join(path, child), `${relative}/${child}`);
    } else if (metadata.isFile()) {
      total += metadata.size;
      if (total > limit) throw new Error('File transfer exceeds limit.');
      entries.push({ path: relative, kind: 'file', data: (await readFile(path)).toString('base64') });
    } else throw new Error('Special files are not transferred.');
  }
  for (const path of paths) {
    const name = basename(path);
    if (top.has(name)) throw new Error('Duplicate file name.');
    top.add(name);
    await append(path, name);
  }
  return entries;
}

export async function testClipboard({ name, root, context, execute, signal }) {
  const binary = join(root, 'pasteboard');
  await execute('swiftc', [join(context, 'Pasteboard.swift'), '-o', binary, '-framework', 'AppKit'], { timeout: 120_000 });
  const board = `org.vspod.clipboard-spike.${randomUUID()}`;
  const native = async (request, activeSignal = signal) => JSON.parse(await run(binary, [], { board, ...request }, activeSignal));
  const agent = async (mode, input) => JSON.parse(await run('docker', [
    'exec', '-i', '--env', 'DISPLAY=:99', name, 'python3', '/opt/spike/clipboard-agent.py', mode,
  ], input, signal));
  const request = async (input) => {
    const response = await agent('request', input);
    if (response.error) throw new Error(`Container clipboard rejected request: ${response.error}`);
    return response.result;
  };
  const set = (formats) => request({ operation: 'write', formats: Object.fromEntries(
    Object.entries(formats).map(([key, data]) => [key, Buffer.from(data).toString('base64')]),
  ) });
  const get = async (target) => Buffer.from((await agent('read', { target })).data, 'base64');
  const key = (...keys) => execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xdotool', 'key', '--clearmodifiers', ...keys], { timeout: 10_000 });
  const type = (text) => execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xdotool', 'type', '--clearmodifiers', '--delay', '1', '--', text], { timeout: 10_000 });
  async function open(path) {
    await key('ctrl+p');
    await delay(300);
    await type(path);
    await key('Return');
    await delay(900);
  }
  const passed = [];
  const pass = (test) => { passed.push(test); console.log(`CLIPBOARD PASS: ${test}`); };
  try {
    await request({ operation: 'ping' });
    const { stdout } = await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'wmctrl', '-lx'], { timeout: 5_000 });
    const id = stdout.split('\n').find((line) => /code\.Code|code\.code/.test(line))?.split(/\s+/)[0];
    assert.ok(id, 'VS Code window missing');
    await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xdotool', 'windowactivate', '--sync', id], { timeout: 5_000 });
    await delay(2500);
    await key('Escape');

    const text = 'Clipboard Unicode: café 日本語 😀\n\tindented\tcolumns\n\nlast line\n';
    await native({ action: 'write', kind: 'text', data: text });
    const hostText = await native({ action: 'read' });
    await set({ UTF8_STRING: hostText.data, 'text/plain;charset=utf-8': hostText.data });
    assert.equal((await get('UTF8_STRING')).toString(), text);
    await open('/tmp/workspace/clipboard.txt');
    await key('ctrl+a', 'ctrl+v');
    await delay(500);
    await key('ctrl+s');
    await delay(500);
    const { stdout: saved } = await execute('docker', ['exec', name, 'cat', '/tmp/workspace/clipboard.txt'], { timeout: 5_000 });
    assert.equal(saved, text, 'Actual VS Code paste changed text');
    pass('native Unicode/multiline text -> X clipboard -> actual VS Code editor paste');

    await set({ UTF8_STRING: 'COPY_SENTINEL' });
    await key('ctrl+a', 'ctrl+c');
    await delay(400);
    const copied = (await get('UTF8_STRING')).toString();
    await native({ action: 'write', kind: 'text', data: copied });
    assert.equal((await native({ action: 'read' })).data, text);
    pass('actual VS Code editor copy -> native text pasteboard');

    await native({ action: 'write', kind: 'text', data: 'HOST_ONLY_CANARY_NOT_PASTED' });
    await delay(500);
    assert.equal((await get('UTF8_STRING')).toString(), text);
    pass('host clipboard changes are not mirrored without explicit transfer');
    const longText = 'Long clipboard 日本語\tcolumn\n\n'.repeat(5000);
    await native({ action: 'write', kind: 'text', data: longText });
    await set({ UTF8_STRING: (await native({ action: 'read' })).data });
    assert.equal((await get('UTF8_STRING')).toString(), longText);
    pass('large Unicode text uses incremental X clipboard transfer without truncation');

    await key('ctrl+grave');
    await delay(2000);
    const command = "printf 'first\\tcolumn\\n\\nlast line\\n'; touch /tmp/clipboard-executed\n# clipboard second line";
    await native({ action: 'write', kind: 'text', data: command });
    await set({ UTF8_STRING: (await native({ action: 'read' })).data });
    await key('ctrl+shift+v');
    await delay(800);
    const { stdout: markerBefore } = await execute('docker', ['exec', name, 'sh', '-c', 'if [ -e /tmp/clipboard-executed ]; then echo executed; else echo pending; fi'], { timeout: 5_000 });
    assert.equal(markerBefore.trim(), 'pending');
    // VS Code may first ask the user to confirm a multiline paste.
    await key('Return');
    await delay(800);
    let { stdout: markerAfter } = await execute('docker', ['exec', name, 'sh', '-c', 'if [ -e /tmp/clipboard-executed ]; then echo executed; else echo pending; fi'], { timeout: 5_000 });
    if (markerAfter.trim() === 'pending') {
      await key('Return');
      await delay(800);
      ({ stdout: markerAfter } = await execute('docker', ['exec', name, 'sh', '-c', 'if [ -e /tmp/clipboard-executed ]; then echo executed; else echo pending; fi'], { timeout: 5_000 }));
    }
    assert.equal(markerAfter.trim(), 'executed', 'Terminal paste did not reach a live shell');
    pass('multiline VS Code terminal paste does not execute until explicit Return');
    // VS Code's built-in command selects terminal output rather than the editor.
    await key('ctrl+shift+p');
    await delay(300);
    await type('Terminal: Select All');
    await key('Return');
    await delay(300);
    await key('ctrl+shift+c');
    await delay(400);
    const terminalText = (await get('UTF8_STRING')).toString();
    assert.match(terminalText, /first\s+column/);
    assert.match(terminalText, /last line/);
    assert.ok(terminalText.includes('\n\n'), 'Terminal copy lost blank lines');
    await native({ action: 'write', kind: 'text', data: terminalText });
    assert.equal((await native({ action: 'read' })).data, terminalText);
    pass('actual multiline terminal selection -> native text pasteboard (tabs displayed as spaces)');
    await key('ctrl+grave');

    const image = await native({ action: 'fixture' });
    await native({ action: 'write', kind: 'image', data: image.data });
    await set({ 'image/png': Buffer.from((await native({ action: 'read' })).data, 'base64') });
    const png = await get('image/png');
    assert.deepEqual(png, Buffer.from(image.data, 'base64'));
    await native({ action: 'write', kind: 'image', data: png.toString('base64') });
    assert.equal((await native({ action: 'read' })).data, image.data);
    pass('native PNG image <-> Linux image/png clipboard, byte-exact');
    await native({ action: 'write', kind: 'image-tiff', data: image.data });
    const converted = await native({ action: 'read' });
    assert.deepEqual((await native({ action: 'inspect', data: converted.data })).pixels,
      (await native({ action: 'inspect', data: image.data })).pixels);
    pass('native TIFF-only screenshot-style pasteboard converts to PNG with identical pixels');
    const largeImage = await native({ action: 'fixture', kind: 'large' });
    assert.ok(Buffer.from(largeImage.data, 'base64').length > 512 * 1024);
    await native({ action: 'write', kind: 'image', data: largeImage.data });
    await set({ 'image/png': Buffer.from((await native({ action: 'read' })).data, 'base64') });
    assert.deepEqual(await get('image/png'), Buffer.from(largeImage.data, 'base64'));
    pass('large PNG (>512 KiB) uses incremental X clipboard transfer without corruption');
    await set({ 'image/png': Buffer.from(image.data, 'base64') });

    await open('/tmp/workspace/clipboard.md');
    await delay(2500);
    await key('ctrl+v');
    await delay(2000);
    await key('ctrl+s');
    await delay(500);
    const { stdout: markdown } = await execute('docker', ['exec', name, 'cat', '/tmp/workspace/clipboard.md'], { timeout: 5_000 });
    assert.match(markdown, /!\[/, 'PNG reached X clipboard but Markdown did not insert an image reference');
    const reference = /\]\(([^)]+)\)/.exec(markdown)?.[1];
    assert.ok(reference && !reference.startsWith('/') && !reference.includes('..'));
    const imagePath = `/tmp/workspace/${decodeURIComponent(reference)}`;
    const { stdout: imageBytes } = await execute('docker', ['exec', name, 'cat', imagePath], { timeout: 5_000, encoding: 'buffer' });
    assert.deepEqual((await native({ action: 'inspect', data: imageBytes.toString('base64') })).pixels,
      (await native({ action: 'inspect', data: image.data })).pixels);
    pass('actual VS Code Markdown image paste inserts an image reference');
    await open(imagePath);
    await delay(1000);
    await set({ UTF8_STRING: 'IMAGE_COPY_SENTINEL' });
    await key('ctrl+alt+i');
    await delay(800);
    const copiedImage = await get('image/png');
    await native({ action: 'write', kind: 'image', data: copiedImage.toString('base64') });
    assert.deepEqual((await native({ action: 'inspect', data: (await native({ action: 'read' })).data })).pixels,
      (await native({ action: 'inspect', data: image.data })).pixels);
    pass('actual VS Code image preview Copy Image -> native image pasteboard, pixel-exact');

    const fixtures = join(root, 'clipboard-fixtures');
    await mkdir(join(fixtures, 'folder', 'nested'), { recursive: true, mode: 0o700 });
    await mkdir(join(fixtures, 'folder', 'empty'), { mode: 0o700 });
    await writeFile(join(fixtures, 'single.txt'), 'clipboard file\n');
    await writeFile(join(fixtures, 'folder', 'nested', 'binary.bin'), Buffer.from([0, 1, 128, 255]));
    await writeFile(join(fixtures, 'space name.txt'), 'spaces\n');
    const paths = ['single.txt', 'space name.txt', 'folder'].map((path) => join(fixtures, path));
    await native({ action: 'write', kind: 'files', paths });
    const hostFiles = await native({ action: 'read' });
    assert.equal(hostFiles.kind, 'files');
    const entries = await manifest(hostFiles.paths);
    const imported = await request({ operation: 'import', entries });
    const urls = imported.paths.map((path) => pathToFileURL(path).href).join('\n');
    await set({ 'text/uri-list': `${urls}\r\n`, 'code/file-list': urls });
    const exported = await agent('export', { target: 'code/file-list' });
    assert.deepEqual(exported.entries.sort((a, b) => a.path.localeCompare(b.path)), entries.sort((a, b) => a.path.localeCompare(b.path)));
    pass('native file URLs -> bounded container file/folder transfer -> Linux file clipboard');

    await key('ctrl+shift+e');
    await delay(500);
    await key('ctrl+v');
    await delay(2000);
    const { stdout: pastedFile } = await execute('docker', ['exec', name, 'cat', '/tmp/workspace/single.txt'], { timeout: 5_000 });
    assert.equal(pastedFile, 'clipboard file\n');
    pass('actual VS Code Explorer paste creates transferred file');
    await open('/tmp/workspace/single.txt');
    await key('ctrl+alt+e');
    await delay(500);
    await key('ctrl+alt+f', 'ctrl+a');
    await set({ UTF8_STRING: 'FILE_COPY_SENTINEL' });
    await key('ctrl+c');
    await delay(500);
    const workspaceURLs = (await get('code/file-list')).toString().trim().split('\n');
    assert.ok(workspaceURLs.length >= 3 && workspaceURLs.every((uri) => uri.startsWith('file:///tmp/workspace/')));
    const copiedFiles = await agent('export', { target: 'code/file-list' });
    const fixturesCopied = copiedFiles.entries.filter((entry) => entries.some((expected) => expected.path === entry.path));
    assert.deepEqual(fixturesCopied.sort((a, b) => a.path.localeCompare(b.path)), entries);
    const downloads = join(root, 'clipboard-export');
    await mkdir(downloads, { mode: 0o700 });
    for (const entry of copiedFiles.entries) {
      const parts = entry.path.split('/');
      assert.ok(parts.every((part) => part && part !== '.' && part !== '..' && !part.includes('\\')));
      const path = join(downloads, ...parts);
      if (entry.kind === 'directory') await mkdir(path, { mode: 0o700 });
      else await writeFile(path, Buffer.from(entry.data, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    const outputPaths = copiedFiles.entries.filter((entry) => !entry.path.includes('/')).map((entry) => join(downloads, entry.path));
    await native({ action: 'write', kind: 'files', paths: outputPaths });
    assert.deepEqual((await native({ action: 'read' })).paths, outputPaths);
    assert.deepEqual((await manifest((await native({ action: 'read' })).paths)).sort((a, b) => a.path.localeCompare(b.path)),
      copiedFiles.entries.sort((a, b) => a.path.localeCompare(b.path)));
    pass('actual Explorer file copy -> exported bytes -> native file URL pasteboard');
    await assert.rejects(request({ operation: 'import', entries: [{ path: '../escape', kind: 'file', data: '' }] }), /Unsafe/);
    await assert.rejects(request({ operation: 'import', entries: [{ path: 'link', kind: 'symlink', data: '' }] }), /Unsupported/);
    await assert.rejects(request({ operation: 'import', entries: [{ path: 'missing/child', kind: 'file', data: '' }] }), /parent/);
    await assert.rejects(request({ operation: 'import', entries: [{ path: 'duplicate', kind: 'file', data: '' }, { path: 'duplicate', kind: 'file', data: '' }] }), /duplicate/);
    await symlink(join(fixtures, 'single.txt'), join(fixtures, 'symlink'));
    await assert.rejects(manifest([join(fixtures, 'symlink')]), /Symlinks/);
    await set({ 'code/file-list': 'file:///etc/passwd' });
    await assert.rejects(agent('export', { target: 'code/file-list' }), /outside permitted/);
    await execute('docker', ['exec', name, 'ln', '-s', '/etc/passwd', '/tmp/workspace/unsafe-link'], { timeout: 5_000 });
    await set({ 'code/file-list': 'file:///tmp/workspace/unsafe-link' });
    await assert.rejects(agent('export', { target: 'code/file-list' }), /outside permitted/);
    await assert.rejects(set({ UTF8_STRING: Buffer.alloc(limit + 1) }), /exceeds limit/);
    await assert.rejects(native({ action: 'read', board: 'NSGeneralPboard' }), /Only isolated test pasteboards/);
    pass('traversal, duplicate/missing parents, symlinks, out-of-root files, oversized payloads and general-pasteboard access rejected');
    return { passed, imageApplicationReference: markdown.includes('![') };
  } finally {
    await native({ action: 'clear' }, new AbortController().signal);
  }
}
