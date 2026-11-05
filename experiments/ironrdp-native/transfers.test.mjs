import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { decodeBytes, validateEntries, readRequest } from './transfers.mjs';

test('stdin requests preserve Unicode across arbitrary byte boundaries', async () => {
  const expected = { action: 'paste', payload: { kind: 'text', data: 'café 日本語 😀\n'.repeat(5000) } };
  const bytes = Buffer.from(JSON.stringify(expected));
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 7) chunks.push(bytes.subarray(offset, offset + 7));
  assert.deepEqual(await readRequest(Readable.from(chunks)), expected);
  await assert.rejects(readRequest(Readable.from([Buffer.from([0xff])])));
  await assert.rejects(readRequest(Readable.from([Buffer.alloc(24 * 1024 * 1024 + 1)])), /limit/);
});

test('bounded manifests accept binary files, spaces and explicit empty directories', () => {
  const entries = [
    { path: 'space folder', kind: 'directory' },
    { path: 'space folder/empty', kind: 'directory' },
    { path: 'space folder/binary', kind: 'file', data: Buffer.from([0, 128, 255]).toString('base64') },
  ];
  assert.equal(validateEntries(entries), entries);
  assert.deepEqual(decodeBytes(entries[2].data), Buffer.from([0, 128, 255]));
});

test('manifests reject traversal, duplicate names, invalid parents and unsupported kinds', () => {
  for (const path of ['../escape', '/absolute', 'folder//file', 'folder/../file', 'a\\b', 'a\0b', './file', '']) {
    assert.throws(() => validateEntries([{ path, kind: 'file', data: '' }]));
  }
  assert.throws(() => validateEntries([]));
  assert.throws(() => validateEntries(Array.from({ length: 101 }, (_, index) => ({ path: `${index}`, kind: 'directory' }))));
  assert.throws(() => validateEntries([{ path: 'file', kind: 'symlink' }]));
  assert.throws(() => validateEntries([{ path: 'folder/file', kind: 'file', data: '' }]));
  assert.throws(() => validateEntries([{ path: 'a', kind: 'directory' }, { path: 'a', kind: 'file', data: '' }]));
  assert.throws(() => validateEntries([{ path: 'a', kind: 'file', data: '' }, { path: 'a/b', kind: 'directory' }]));
});

test('base64 and aggregate byte limits are enforced', () => {
  assert.throws(() => decodeBytes('bad!!'));
  assert.throws(() => decodeBytes('YQ'));
  assert.throws(() => decodeBytes(Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')));
  const data = Buffer.alloc(5 * 1024 * 1024).toString('base64');
  assert.throws(() => validateEntries([{ path: 'a', kind: 'file', data }, { path: 'b', kind: 'file', data }]));
});
