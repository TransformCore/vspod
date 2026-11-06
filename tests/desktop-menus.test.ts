import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DesktopBackend, desktopContainerName } from '@vspod/editor-backends';
import { resolveConfiguration } from '@vspod/config';
import { installationRoot } from '@vspod/core/installation';
import { resolveWorkspace } from '@vspod/workspace';
import { DockerAppRunner } from '@vspod/app-runner';

test('native desktop menus retain client shadows, transparent corners and popup input alignment', {
  skip: process.env.VSPOD_DESKTOP_TEST !== '1', timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-menu-'));
  const repo = join(root, 'vspod-test-menu');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const workspace = await resolveWorkspace(repo), backend = new DesktopBackend();
  const runner = new DockerAppRunner();
  const previous = process.env.VSPOD_WINDOW_SELFTEST;
  process.env.VSPOD_WINDOW_SELFTEST = '1';
  let host: Awaited<ReturnType<DockerAppRunner['attach']>> | undefined;
  let output = '', failure: Error | undefined;
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 30_000;
    while (!predicate()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, `Timed out: ${label}\n${output.slice(-2000)}`);
      await delay(50);
    }
  };
  const send = (request: object) => host!.stdin!.write(JSON.stringify(request) + '\n');
  try {
    await backend.runtime.ensureImage();
    await backend.runtime.create(workspace);
    for (const [index, theme] of ['Default Light Modern', 'Default Dark Modern'].entries()) {
      const session = await backend.start(workspace, resolveConfiguration({ profile: {
        schemaVersion: 1, settings: { 'workbench.colorTheme': theme },
      } }));
      await backend.waitForReady(workspace, session);
      const directory = join(root, `attachment-${index}`);
      await mkdir(directory, { mode: 0o700 });
      host = await runner.attach(join(installationRoot(), 'packages/editor-backends/dist/VSPod.app/Contents/MacOS/VSPod'), directory, {
        container: desktopContainerName(workspace), protocol: 'wayland',
        integrations: { clipboard: false, files: false, externalUrls: false },
      }, { stderr: 'pipe' });
      output = '';
      host.on('error', (error) => { failure = error; });
      host.on('exit', (code) => { if (code !== 0) failure = new Error(`Native host failed: ${code}`); });
      host.stdout!.on('data', (data) => { output += data.toString(); });
      host.stderr!.on('data', (data) => { output += data.toString(); });
      await wait(() => output.includes('WINDOW_FRAME'), 'editor frame');
      assert.match(output, /WINDOW_APP name=VSPod bundled=true icon=true identifier=dev\.vspod\.native-host/);
      await delay(8000);
      const main = Number(output.match(/WINDOW_CREATED id=(\d+) popup=false owner=0 dialog=false/)![1]);
      send({ action: 'testDockMenu', focus: main });
      await wait(() => output.includes('WINDOW_DOCK_FOCUSED'), 'Dock restores and focuses the editor');
      send({ action: 'testClick', id: main, x: 18, y: 12 });
      await wait(() => /WINDOW_CREATED id=\d+ popup=true/.test(output), 'File menu');
      const popup = Number([...output.matchAll(/WINDOW_CREATED id=(\d+) popup=true/g)].at(-1)![1]);
      const dockOffset = output.length;
      send({ action: 'testDockMenu' });
      await wait(() => output.slice(dockOffset).includes('WINDOW_DOCK_MENU '), 'live Dock window menu');
      const dock = JSON.parse(output.slice(dockOffset).match(/WINDOW_DOCK_MENU (.+)/)![1]) as {
        id: number; title: string; minimized: boolean;
      }[];
      assert.deepEqual(dock.map((item) => item.id), [main], 'Dock lists editor windows, not popup menus');
      assert.ok(dock[0].title.length > 0);
      assert.equal(dock[0].minimized, false, 'Selecting a minimized Dock window restores it');
      await delay(500);
      send({ action: 'nativeSnapshot', id: popup, tag: 'menu' });
      await wait(() => output.includes('WINDOW_METAL_SNAPSHOT tag=menu '), 'native menu pixels');
      const state = JSON.parse(await readFile(join(directory, 'menu.native.json'), 'utf8')) as {
        opaque: boolean; layerOpaque: boolean; shadow: boolean;
        metadata: { scale: number; width: number; height: number; geometry: [number, number, number, number] };
      };
      assert.equal(state.opaque, false);
      assert.equal(state.layerOpaque, false);
      assert.equal(state.shadow, false, 'AppKit must not add a rectangular second shadow');
      const { scale, width, height, geometry: [gx, gy, gw, gh] } = state.metadata;
      const w = width * scale, h = height * scale;
      const pixels = await readFile(join(directory, 'menu.metal.bgra'));
      assert.equal(pixels.length, w * h * 4);
      assert.ok(gx > 0 && gy > 0 && gx + gw < width && gy + gh < height,
        'Client shadow margins must survive on all four sides of window geometry');
      const alpha = (x: number, y: number) => pixels[(y * w + x) * 4 + 3]!;
      for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
        assert.ok(alpha(x, y) < 16, `Outer corner ${x},${y} is not transparent`);
      }
      assert.equal(alpha(w >> 1, h >> 1), 255, 'Menu body remains opaque');
      let shadowPixels = 0;
      for (let y = (gy + gh) * scale; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (alpha(x, y) > 0 && alpha(x, y) < 128) shadowPixels++;
        }
      }
      assert.ok(shadowPixels > w, 'Bottom shadow must extend beyond the rounded menu body, not be cropped off');
      send({ action: 'testPostMove', id: popup, x: gx + 60, y: gy + 14 });
      await delay(300);
      send({ action: 'testClick', id: popup, x: gx + 60, y: gy + 14 });
      await wait(() => output.includes(`WINDOW_DESTROYED id=${popup}`), 'menu item input closes the menu');
      console.log(`PASS ${theme}: all corners transparent; ${shadowPixels} retained bottom-shadow pixels; popup input aligned`);
      const closed = new Promise<void>((resolve, reject) => {
        host!.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Detach failed: ${code}`)));
      });
      send({ action: 'stop' });
      await closed;
      host = undefined;
      await backend.runtime.stop(workspace);
    }
  } finally {
    if (host && host.exitCode === null && host.signalCode === null) {
      const closed = new Promise<void>((resolve) => host!.once('exit', () => resolve()));
      host.kill('SIGTERM');
      await closed;
    }
    if (await backend.runtime.inspect(workspace)) {
      await backend.runtime.remove(workspace);
      await backend.runtime.removeTestVolumes(workspace);
    }
    if (previous === undefined) delete process.env.VSPOD_WINDOW_SELFTEST; else process.env.VSPOD_WINDOW_SELFTEST = previous;
    await rm(root, { recursive: true, force: true });
  }
});
