import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { manifest, run } from './clipboard.mjs';

export async function prepareDrop(root) {
  const fixtures = join(root, 'drop-fixtures');
  await mkdir(join(fixtures, 'drag-folder', 'empty'), { recursive: true, mode: 0o700 });
  await writeFile(join(fixtures, 'drag file.txt'), 'Native drop -> XDND -> VS Code\n');
  await writeFile(join(fixtures, 'drag-folder', 'binary.bin'), Buffer.from([0, 17, 128, 255]));
  return {
    paths: [join(fixtures, 'drag file.txt'), join(fixtures, 'drag-folder')],
    reportPath: join(root, 'native-drop.json'),
  };
}

export async function testDrop({ name, execute, signal, fixture }) {
  const deadline = Date.now() + 15_000;
  let native;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try { native = JSON.parse(await readFile(fixture.reportPath, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(250);
  }
  assert.ok(native, 'Native file-drop receiver did not record its fixture');
  assert.deepEqual(native.paths, fixture.paths);
  assert.equal(native.operation, 'copy');
  assert.equal(native.x, 150);
  assert.equal(native.y, 130);
  assert.equal(native.width, 1200);
  assert.equal(native.height, 800);
  console.log('DROP PASS: native file-URL receiver, copy-only validation and host/display coordinates');

  const entries = await manifest(native.paths);
  const response = JSON.parse(await run('docker', [
    'exec', '-i', name, 'python3', '/opt/spike/clipboard-agent.py', 'request',
  ], { operation: 'import', entries }, signal));
  if (response.error) throw new Error(response.error);
  const paths = response.result.paths;
  const { stdout } = await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'wmctrl', '-lx'], { timeout: 5_000 });
  const window = stdout.split('\n').find((line) => /code\.Code|code\.code/.test(line))?.split(/\s+/)[0];
  assert.ok(window);
  const key = (...keys) => execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xdotool', 'key', '--clearmodifiers', ...keys], { timeout: 10_000 });
  const type = (text) => execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xdotool', 'type', '--clearmodifiers', '--delay', '1', '--', text], { timeout: 10_000 });
  await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'xdotool', 'windowactivate', '--sync', window], { timeout: 5_000 });
  await execute('docker', ['exec', name, 'mkdir', '/tmp/workspace/drop-target'], { timeout: 5_000 });
  await delay(1000);
  await key('Escape', 'ctrl+shift+e');
  await delay(500);
  const xdnd = async (input) => JSON.parse(await run('docker', [
    'exec', '-i', '--env', 'DISPLAY=:99', name, 'python3', '/opt/spike/xdnd.py',
  ], { window, paths, x: native.x, y: native.y, ...input }, signal));
  const exists = async (path) => (await execute('docker', ['exec', name, 'sh', '-c', 'if [ -e "$1" ]; then echo yes; else echo no; fi', 'exists', path], { timeout: 5_000 })).stdout.trim() === 'yes';

  const cancel = await xdnd({ cancel: true });
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.accepted, true);
  assert.equal(await exists('/tmp/workspace/drop-target/drag file.txt'), false);
  console.log('DROP PASS: XDND enter/position/leave cancellation leaves workspace unchanged');
  const result = await xdnd({});
  console.log('XDND Explorer response:', JSON.stringify(result));
  assert.equal(result.accepted, true);
  assert.equal(result.copy, true);
  assert.equal(result.selection_requested, true);
  assert.equal(result.finished, true);
  await delay(1000);
  for (const entry of entries) {
    const path = `/tmp/workspace/drop-target/${entry.path}`;
    if (entry.kind === 'directory') assert.equal(await exists(path), true);
    else {
      const { stdout: data } = await execute('docker', ['exec', name, 'cat', path], { timeout: 5_000, encoding: 'buffer' });
      assert.deepEqual(data, Buffer.from(entry.data, 'base64'));
    }
  }
  assert.deepEqual(await manifest(fixture.paths), entries, 'Copy must not remove or alter host sources');
  console.log('DROP PASS: genuine Explorer XDND drop copies multiple files, binary bytes and an empty folder');

  await key('ctrl+p');
  await delay(300);
  await type('/tmp/workspace/spike.txt');
  await key('Return');
  await delay(600);
  const editorResult = await xdnd({ paths: [paths.find((path) => path.endsWith('/drag file.txt'))], x: 650, y: 300 });
  console.log('XDND editor response:', JSON.stringify(editorResult));
  assert.equal(editorResult.accepted, true);
  assert.equal(editorResult.copy, true);
  assert.equal(editorResult.selection_requested, true);
  assert.equal(editorResult.finished, true);
  await delay(800);
  const { stdout: titles } = await execute('docker', ['exec', '--env', 'DISPLAY=:99', name, 'wmctrl', '-l'], { timeout: 5_000 });
  assert.match(titles, /drag file\.txt/, 'Editor drop did not open the staged file');
  console.log('DROP PASS: same staged file dropped over editor opens it rather than importing into Explorer');
  await assert.rejects(xdnd({ x: -1 }), /outside framebuffer/);
  await assert.rejects(xdnd({ y: 800 }), /outside framebuffer/);
  await assert.rejects(xdnd({ paths: ['/etc/passwd'] }), /explicit staged/);
  console.log('DROP PASS: invalid coordinates and unstaged source paths rejected');
  return { explorer: result, editor: editorResult, nativeEventDispatch: 'not-tested', hostSourceUnchanged: true };
}
