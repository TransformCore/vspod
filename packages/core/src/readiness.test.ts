import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorUrl } from './readiness.ts';

test('editor origins cannot carry secrets or target remote hosts', () => {
  assert.equal(editorUrl('http://127.0.0.1:49152').origin, 'http://127.0.0.1:49152');
  for (const url of ['http://localhost:8080', 'http://user:secret@127.0.0.1:8080', 'http://127.0.0.1:8080?token=secret', 'https://example.com', 'file:///etc/passwd', 'http://127.0.0.1:8080/redirect']) {
    assert.throws(() => editorUrl(url));
  }
});