import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { desktopCommand, desktopInstallation } from './installation.ts';

test('bundle discovery prefers the newest local build and respects explicit overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-installation-'));
  const target = join(root, 'apps/desktop/src-tauri/target');
  const app = join(target, 'release/bundle/macos/VSPod.app');
  const packaged = join(app, 'Contents/MacOS/vspod-desktop');
  const development = join(target, 'debug/vspod-desktop');
  try {
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
    await mkdir(join(target, 'debug'), { recursive: true });
    await writeFile(packaged, 'bundle');
    await writeFile(development, 'development');
    await utimes(packaged, new Date(1_000), new Date(1_000));
    await utimes(development, new Date(2_000), new Date(2_000));
    assert.equal(desktopInstallation(root, {}).kind, 'binary');
    await utimes(packaged, new Date(3_000), new Date(3_000));
    assert.equal(desktopInstallation(root, {}).kind, 'app');
    assert.equal(desktopInstallation(root, { VSPOD_DESKTOP_APP: app }).path, app);
    assert.equal(desktopInstallation(root, { VSPOD_DESKTOP_BINARY: development, VSPOD_DESKTOP_APP: app }).path, development);
    const launch = desktopCommand('/private/a folder/session.json', desktopInstallation(root, {}));
    assert.equal(launch.command, '/usr/bin/open');
    assert.deepEqual(launch.args, ['-n', '-W', app, '--args', '--session', '/private/a folder/session.json']);
    assert.throws(() => desktopInstallation(root, { VSPOD_DESKTOP_APP: '/not-an-app' }), /\.app bundle/);
  } finally { await rm(root, { force: true, recursive: true }); }
});