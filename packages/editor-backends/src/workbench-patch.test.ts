import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { execute } from '@vspod/core/process';

const patch = fileURLToPath(new URL('../images/code-server/patch-editor.mjs', import.meta.url));
const script = 'this.f=o.extUri.joinPath(e.uri,t),this.g=new Ngn(e.uri,t,';
const styles = '.monaco-workbench .part.titlebar{display:flex}.monaco-workbench .part.titlebar>.titlebar-container{overflow:hidden}';
const desktopPatch = fileURLToPath(new URL('../images/desktop/patch-editor.mjs', import.meta.url));
const desktopKey = 'vs/workbench/workbench.desktop.main.js';
const checksum = (content: string) => createHash('sha256').update(content).digest('base64').replace(/=+$/, '');

test('desktop patch records its intentional checksum while preserving all other integrity checks and product metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-desktop-patch-'));
  const path = join(root, 'out', desktopKey);
  const product = { commit: 'pinned-build', checksums: { [desktopKey]: checksum(script), 'other.js': 'unchanged' } };
  try {
    await mkdir(join(root, 'out/vs/workbench'), { recursive: true });
    await writeFile(path, script);
    await writeFile(join(root, 'product.json'), JSON.stringify(product));
    await execute(process.execPath, [desktopPatch, root]);
    const patched = await readFile(path, 'utf8');
    assert.match(patched, /\/vspod\/config\/workspace/);
    assert.notEqual(checksum(patched), product.checksums[desktopKey]);
    const manifest = JSON.parse(await readFile(join(root, 'product.json'), 'utf8'));
    assert.deepEqual(manifest, { ...product, checksums: { ...product.checksums, [desktopKey]: checksum(patched) } });
    assert.notEqual(checksum(patched + 'unexpected change'), manifest.checksums[desktopKey],
      'Subsequent unexpected modifications must still fail integrity checking');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop patch rejects missing or mismatched checksums and anchor drift without changing assets', async () => {
  for (const [source, checksums] of [
    [script, {}], [script, { [desktopKey]: 'wrong' }],
    [script + script, { [desktopKey]: checksum(script + script) }],
    ['changed upstream JS', { [desktopKey]: checksum('changed upstream JS') }],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), 'vspod-desktop-drift-'));
    const path = join(root, 'out', desktopKey);
    const product = JSON.stringify({ checksums });
    try {
      await mkdir(join(root, 'out/vs/workbench'), { recursive: true });
      await writeFile(path, source);
      await writeFile(join(root, 'product.json'), product);
      await assert.rejects(execute(process.execPath, [desktopPatch, root]), /Unsupported desktop editor/);
      assert.equal(await readFile(path, 'utf8'), source);
      assert.equal(await readFile(join(root, 'product.json'), 'utf8'), product);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('maintained web editor patches configuration and provides an unclipped titlebar overlay without changing menu layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-workbench-patch-'));
  const directory = join(root, 'out/vs/code/browser/workbench');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'workbench.js'), script);
    await writeFile(join(directory, 'workbench.css'), styles);
    await execute(process.execPath, [patch, root]);
    assert.match(await readFile(join(directory, 'workbench.js'), 'utf8'), /\/vspod\/config\/workspace/);
    const patched = await readFile(join(directory, 'workbench.css'), 'utf8');
    assert.ok(patched.startsWith(styles), 'Upstream menu layout rules must remain intact');
    assert.match(patched, /\.monaco-workbench\.web \.part\.titlebar\s*\{\s*position: relative;\s*z-index: 2500;\s*overflow: visible;/);
    assert.match(patched, /\.monaco-workbench\.web \.part\.titlebar > \.titlebar-container\s*\{\s*overflow: visible;/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('upstream configuration and titlebar stylesheet drift fail before either asset is changed', async () => {
  for (const [js, css] of [[script + script, styles], [script, 'changed upstream CSS'], [script, styles + styles]]) {
    const root = await mkdtemp(join(tmpdir(), 'vspod-workbench-drift-'));
    const directory = join(root, 'out/vs/code/browser/workbench');
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'workbench.js'), js);
      await writeFile(join(directory, 'workbench.css'), css);
      await assert.rejects(execute(process.execPath, [patch, root]), /Unsupported editor build/);
      assert.equal(await readFile(join(directory, 'workbench.js'), 'utf8'), js);
      assert.equal(await readFile(join(directory, 'workbench.css'), 'utf8'), css);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
