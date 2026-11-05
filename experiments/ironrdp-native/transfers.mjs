import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { manifest, run } from '../desktop-spike/clipboard.mjs';

const LIMIT = 8 * 1024 * 1024;
const WIRE_LIMIT = 24 * 1024 * 1024;

export function decodeBytes(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(LIMIT / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid or oversized base64 payload');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > LIMIT) throw new Error('Transfer exceeds 8 MiB');
  return bytes;
}

export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) {
    throw new Error('Expected 1-100 transfer entries');
  }
  const kinds = new Map();
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length > 1024
        || entry.path.includes('\\') || entry.path.includes('\0')
        || entry.path.split('/').some((part) => !part || part === '.' || part === '..')
        || kinds.has(entry.path) || !['directory', 'file'].includes(entry.kind)) {
      throw new Error('Unsafe, duplicate or unsupported transfer entry');
    }
    kinds.set(entry.path, entry.kind);
    if (entry.kind === 'file') total += decodeBytes(entry.data).length;
    if (total > LIMIT) throw new Error('Transfer exceeds 8 MiB');
  }
  for (const name of kinds.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (kinds.get(parts.slice(0, i).join('/')) !== 'directory') {
        throw new Error('Missing or non-directory transfer parent');
      }
    }
  }
  return entries;
}

export async function transfer({ container, root, request, signal }) {
  if (!/^vspod-iron-native-[a-f0-9]{12}$/.test(container)) throw new Error('Invalid disposable container');
  if (!isAbsolute(root) || await realpath(root) !== root) throw new Error('Invalid private transfer root');
  const agent = async (mode, input) => JSON.parse(await run('docker', [
    'exec', '-i', '--env', 'DISPLAY=:10', container, 'python3', '/tmp/runtime/clipboard-agent.py', mode,
  ], input, signal));
  const call = async (input) => {
    const response = await agent('request', input);
    if (response.error) throw new Error(response.error);
    return response.result;
  };
  const set = (formats) => call({ operation: 'write', formats });
  const encodeText = (text) => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) throw new Error('Invalid or oversized text');
    return Buffer.from(text).toString('base64');
  };
  const stage = async (paths) => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100
        || !paths.every((path) => typeof path === 'string' && isAbsolute(path))) {
      throw new Error('Invalid explicit host file selection');
    }
    const entries = validateEntries(await manifest(paths));
    const imported = await call({ operation: 'import', entries });
    if (!Array.isArray(imported.paths) || !imported.paths.length
        || !imported.paths.every((path) => /^\/tmp\/clipboard-transfers\/[a-f0-9]{32}\/[^/]+$/.test(path))) {
      throw new Error('Invalid guest staging response');
    }
    return imported.paths;
  };
  switch (request.action) {
    case 'paste': {
      const payload = request.payload;
      if (payload?.kind === 'files') {
        const paths = await stage(payload.paths);
        const urls = paths.map((path) => pathToFileURL(path).href).join('\n');
        await set({
          'text/uri-list': encodeText(`${paths.map((path) => pathToFileURL(path).href).join('\r\n')}\r\n`),
          'code/file-list': encodeText(urls),
        });
      } else if (payload?.kind === 'image') {
        decodeBytes(payload.data);
        await set({ 'image/png': payload.data });
      } else if (payload?.kind === 'text') {
        await set({ UTF8_STRING: encodeText(payload.data) });
      } else throw new Error('Unsupported host clipboard content');
      return { ready: true };
    }
    case 'prepareCopy': {
      const marker = `VSPOD_COPY_${randomUUID()}`;
      await set({ UTF8_STRING: encodeText(marker) });
      return { marker };
    }
    case 'copy': {
      if (typeof request.marker !== 'string' || !/^VSPOD_COPY_[a-f0-9-]{36}$/.test(request.marker)) {
        throw new Error('Missing copy acknowledgement marker');
      }
      let targets;
      for (let attempt = 0; attempt < 20; attempt++) {
        targets = decodeBytes((await agent('read', { target: 'TARGETS' })).data).toString().split(/\s+/);
        if (targets.includes('code/file-list') || targets.includes('text/uri-list') || targets.includes('image/png')) break;
        const textTarget = ['UTF8_STRING', 'text/plain;charset=utf-8', 'text/plain'].find((target) => targets.includes(target));
        if (textTarget) {
          const bytes = decodeBytes((await agent('read', { target: textTarget })).data);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (text !== request.marker) return { kind: 'text', data: text };
        }
        targets = undefined;
        await delay(100, undefined, { signal });
      }
      if (!targets) throw new Error('Guest did not copy supported content; host clipboard was not changed');
      const fileTarget = ['code/file-list', 'text/uri-list'].find((target) => targets.includes(target));
      if (fileTarget) {
        const entries = validateEntries((await agent('export', { target: fileTarget })).entries);
        const directory = join(root, randomUUID());
        await mkdir(directory, { mode: 0o700 });
        for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : 1)) {
          const path = join(directory, entry.path);
          if (entry.kind === 'directory') await mkdir(path, { mode: 0o700 });
          else await writeFile(path, decodeBytes(entry.data), { flag: 'wx', mode: 0o600 });
        }
        return { kind: 'files', paths: entries.filter((entry) => !entry.path.includes('/')).map((entry) => join(directory, entry.path)) };
      }
      if (targets.includes('image/png')) {
        const image = (await agent('read', { target: 'image/png' })).data;
        decodeBytes(image);
        return { kind: 'image', data: image };
      }
      throw new Error('Unsupported guest clipboard formats');
    }
    case 'drop': {
      if (!Number.isInteger(request.x) || !Number.isInteger(request.y)
          || request.x < 0 || request.y < 0 || request.x >= 4096 || request.y >= 4096) {
        throw new Error('Invalid drop coordinates');
      }
      const paths = await stage(request.paths);
      const windows = await run('docker', ['exec', '--env', 'DISPLAY=:10', container, 'wmctrl', '-lx'], undefined, signal);
      const window = windows.split('\n').find((line) => /code\.Code|code\.code/.test(line))?.split(/\s+/)[0];
      if (!window) throw new Error('Guest VS Code window not found');
      const result = JSON.parse(await run('docker', [
        'exec', '-i', '--env', 'DISPLAY=:10', container, 'python3', '/tmp/runtime/xdnd.py',
      ], { window, paths, x: request.x, y: request.y }, signal));
      if (!result.accepted || !result.copy || !result.selection_requested || !result.finished) {
        throw new Error('Guest did not complete the copy-only file drop');
      }
      return { dropped: true };
    }
    default: throw new Error('Unsupported transfer action');
  }
}

export async function readRequest(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > WIRE_LIMIT) throw new Error('Transfer request exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const request = await readRequest(process.stdin);
    const result = await transfer({
      container: process.argv[2], root: process.argv[3], request,
      signal: AbortSignal.timeout(25_000),
    });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    console.error(`Transfer failed: ${error.message}`);
    process.exitCode = 1;
  }
}
