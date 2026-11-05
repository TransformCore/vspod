import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Probes record guest pixels without updating the native texture, so a stale texture cannot be masked.
// The comparison counts only when the guest was unchanged on both sides of the native readback.
export async function settledMatch({ root, wait, output, send }, id, label) {
  const probe = async (tag) => {
    send({ action: 'probe', id, tag });
    await wait(() => output().includes(`WINDOW_PROBE tag=${tag} `), `probe ${tag}`);
    return readFile(join(root, `${tag}.probe.bgra`));
  };
  const differing = (a, b) => {
    let count = 0;
    for (let i = 0; i < a.length; i += 4) {
      if ([0, 1, 2].some((channel) => Math.abs(a[i + channel] - b[i + channel]) > 3)) count++;
    }
    return count;
  };
  let differences, pixels, stable = false;
  for (let attempt = 0; attempt < 10 && !stable; attempt++) {
    const before = await probe(`${label}-before-${attempt}`);
    await delay(500);
    send({ action: 'nativeSnapshot', id, tag: `${label}-${attempt}` });
    await wait(() => output().includes(`WINDOW_METAL_SNAPSHOT tag=${label}-${attempt} `), `${label} Metal readback`);
    const native = await readFile(join(root, `${label}-${attempt}.metal.bgra`));
    const after = await probe(`${label}-after-${attempt}`);
    assert.equal(native.length, before.length, `${label} native drawable has unexpected dimensions`);
    stable = differing(before, after) === 0;
    differences = differing(native, before);
    pixels = native.length / 4;
  }
  assert.ok(stable, `Guest window never settled for the ${label} comparison`);
  assert.ok(differences / pixels < 0.005, `${label}: native window is stale: ${differences}/${pixels} pixels differ`);
  console.log(`PASS ${label}: dirty-rect Metal drawable matches settled guest: ${differences}/${pixels} pixels outside tolerance`);
}

export async function acceptance({ name, root, execute, wait, output, send, wayland = false }) {
  const cmd = 1 << 20, shift = 1 << 17, alt = 1 << 19;
  const ids = () => [...output().matchAll(/WINDOW_CREATED id=(\d+) popup=false owner=0 dialog=false/g)].map((match) => Number(match[1]));
  const first = ids()[0];
  const key = async (id, code, flags = 0) => {
    send({ action: 'testKey', id, code, flags });
    await delay(80);
  };
  const click = async (id, x, y) => { send({ action: 'testClick', id, x, y }); await delay(400); };
  const letters = { a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,
    y:16,t:17,o:31,u:32,i:34,p:35,l:37,j:38,k:40,n:45,m:46,' ':49,'\n':36,'.':47,'/':44,'-':27 };
  async function type(id, text) {
    for (const character of text) {
      const code = letters[character.toLowerCase()];
      assert.notEqual(code, undefined, `Missing test scancode: ${character}`);
      // Dismiss any word-suggestion popup so Enter inserts a newline instead of accepting it.
      if (character === '\n') await key(id, 53);
      await key(id, code, character.toLowerCase() !== character ? shift : 0);
    }
  }
  const guest = async (...args) => execute('docker', ['exec', '--env', 'DISPLAY=:11', name, ...args]);
  const snapshot = async (id, tag) => {
    send({ action: 'snapshot', id, tag });
    await wait(() => output().includes(`WINDOW_SNAPSHOT tag=${tag} `), `snapshot ${tag}`);
    if (process.env.VSPOD_WINDOW_EVIDENCE) {
      await mkdir(process.env.VSPOD_WINDOW_EVIDENCE, { recursive: true });
      for (const ext of ['bgra', 'json', 'png']) await writeFile(join(process.env.VSPOD_WINDOW_EVIDENCE, `${tag}.${ext}`),
        await readFile(join(root, `${tag}.${ext}`)));
    }
    return { meta: JSON.parse(await readFile(join(root, `${tag}.json`))), pixels: await readFile(join(root, `${tag}.bgra`)) };
  };
  await delay(8000);
  await settledMatch({ root, wait, output, send }, first, 'startup');
  await click(first, 450, 160);
  await key(first, 0, cmd);
  await type(first, 'First native window\n');
  await key(first, 1, cmd);
  await delay(700);
  assert.equal((await guest('cat', '/tmp/workspace/first.txt')).stdout, 'First native window\n');
  console.log('PASS first native handler edit/save');
  await settledMatch({ root, wait, output, send }, first, 'after-edit');

  // Open the real File menu before selecting its New Window command.
  await click(first, 18, 12);
  await delay(500);
  const menu = await snapshot(first, 'file-menu');
  assert.ok(menu.pixels.length > 0);
  await wait(() => /WINDOW_CREATED id=\d+ popup=true/.test(output()), 'native File menu popup');
  let popup = Number([...output().matchAll(/WINDOW_CREATED id=(\d+) popup=true/g)].at(-1)[1]);
  const menuFrame = await snapshot(popup, 'menu-popup');
  assert.ok(menuFrame.meta.height > 100 && menuFrame.meta.width > 100, 'Menu was not captured');
  if (wayland) {
    // Chromium's rounded menu corners are transparent (premultiplied ARGB); the native panel must keep them
    // transparent rather than drawing them black.
    send({ action: 'nativeSnapshot', id: popup, tag: 'menu-alpha' });
    await wait(() => output().includes('WINDOW_METAL_SNAPSHOT tag=menu-alpha '), 'menu Metal readback');
    const [, mw, mh] = output().match(/WINDOW_METAL_SNAPSHOT tag=menu-alpha id=\d+ size=(\d+)x(\d+)/).map(Number);
    const drawn = await readFile(join(root, 'menu-alpha.metal.bgra'));
    const alphaAt = (x, y) => drawn[(y * mw + x) * 4 + 3];
    assert.ok(alphaAt(0, 0) < 64 && alphaAt(mw - 1, mh - 1) < 64, `menu corners are opaque: ${alphaAt(0, 0)}, ${alphaAt(mw - 1, mh - 1)}`);
    assert.equal(alphaAt(mw >> 1, mh >> 1), 255, 'menu body is not opaque');
    console.log(`PASS menu rounded corners stay transparent (corner alpha ${alphaAt(0, 0)})`);
  }
  // The key main window receives moves beyond its frame. Clamping them onto its edge used to hover the
  // guest menu bar (here Edit, at x=60) and switch menus; they must map to empty guest desktop instead.
  const popupsBefore = output().match(/popup=true/g).length;
  for (const [x, y] of [[60, -15], [60, -2], [-20, 12], [60, -15]]) {
    send({ action: 'testMove', id: first, x, y });
    await delay(150);
  }
  await delay(600);
  assert.ok(!output().includes(`WINDOW_DESTROYED id=${popup}`), 'Moving outside the window switched away from the File menu');
  assert.equal(output().match(/popup=true/g).length, popupsBefore, 'Moving outside the window opened another menu');
  console.log('PASS pointer outside the main window keeps the open File menu');
  {
    // Hover must follow the pointer over the menu every time. Borderless popup panels used to swallow most real
    // moves; the host now routes them to the owning window, which maps them into guest coordinates.
    const baseline = await snapshot(popup, 'hover-none');
    const { width: pw, height: ph } = baseline.meta;
    const scale = pw / Number(output().match(new RegExp(`WINDOW_META id=${popup} size=(\\d+)x`))[1]);
    const centroid = (pixels) => {
      let sum = 0, count = 0;
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x += 2) {
          const i = (y * pw + x) * 4;
          if ([0, 1, 2].some((c) => Math.abs(pixels[i + c] - baseline.pixels[i + c]) > 12)) { sum += y; count++; }
        }
      }
      return count ? sum / count / scale : null;
    };
    const results = [];
    for (const target of [72, 200, 72, 200, 72]) {
      // Posted through the app event queue onto the popup panel, the path a real mouse takes.
      send({ action: 'testPostMove', id: popup, x: 60, y: target });
      await delay(400);
      results.push([target, centroid((await snapshot(popup, `hover-${results.length}`)).pixels)]);
    }
    // Includes the first move into the popup, which used to be lost (pointer enter without motion).
    for (const [target, y] of results) {
      assert.ok(y !== null && Math.abs(y - target) < 24, `Menu hover did not follow the pointer: ${JSON.stringify(results)}`);
    }
    console.log(`PASS menu hover follows every move, including the first: ${JSON.stringify(results)}`);
    // Hovering another menu-bar title switches menus. Electron reopens the sibling as if from the keyboard and
    // ignores its first sibling hover, so (like a real mouse) move twice over each title.
    for (const x of [60, 18, 105, 18]) {
      const before = output().match(/popup=true/g).length;
      for (const dx of [0, 4]) {
        send({ action: 'testMove', id: first, x: x + dx, y: 12 });
        await delay(350);
      }
      await wait(() => output().match(/popup=true/g).length === before + 1, `menu switch at x=${x}`);
      await delay(300);
    }
    console.log('PASS hovering menu-bar titles switches the open menu every time');
    popup = Number([...output().matchAll(/WINDOW_CREATED id=(\d+) popup=true/g)].at(-1)[1]);
    await delay(500);
  }
  // The actual File menu's third row is New Window.
  await click(popup, 100, 72);
  await wait(() => ids().length === 2, 'VS Code New Window');
  const second = ids()[1];
  await wait(() => output().includes(`WINDOW_FRAME id=${second} `), 'second independent texture');
  await delay(10000);
  // Quick Open in a freshly started window can miss keys while the workbench is still restoring, so confirm the
  // editor actually opened (window title) and retry once.
  const opened = () => new RegExp(`WINDOW_META id=${second} .*title=second\\.txt`).test(output());
  for (let attempt = 0; attempt < 2 && !opened(); attempt++) {
    await key(second, 53);
    await key(second, 35, cmd);
    await delay(600);
    await type(second, '/tmp/workspace/second.txt');
    await delay(700);
    await key(second, 36);
    await wait(opened, 'second.txt open in the new window', 6000).catch(() => {});
  }
  await wait(opened, 'second.txt open in the new window');
  await delay(500);
  await click(second, 450, 160);
  await key(second, 0, cmd);
  await type(second, 'Second native window\n');
  await key(second, 1, cmd);
  await delay(700);
  assert.equal((await guest('cat', '/tmp/workspace/second.txt')).stdout, 'Second native window\n');
  console.log('PASS genuine New Window and independent second edit/save');

  // Regression: a maximised window must not exhaust guest shared memory and kill Chromium's GPU process.
  // macOS clamps the request to the visible screen, so accept any large size it settles on.
  send({ action: 'nativeResize', id: first, width: 2400, height: 1400 });
  const large = new RegExp(`WINDOW_META id=${first} size=(1[6-9]\\d\\d|2[0-4]\\d\\d)x(9\\d\\d|1[0-4]\\d\\d) `);
  await wait(() => large.test(output()), 'large guest resize');
  await delay(5000);
  const gpuLog = (await guest('sh', '-c', 'grep -c "GPU process exited" /tmp/editor.log || true')).stdout.trim();
  assert.equal(gpuLog, '0', 'Chromium GPU process crashed at maximum window size');
  console.log('PASS maximum window size without GPU process crash');

  send({ action: 'nativeResize', id: first, width: 820, height: 600 });
  send({ action: 'nativeResize', id: second, width: 960, height: 700 });
  await wait(() => output().includes(`WINDOW_META id=${first} size=820x600`) &&
    output().includes(`WINDOW_META id=${second} size=960x700`), 'independent guest resizes');

  if (wayland) {
    // Toplevels share the compositor's logical origin, so the larger second window, mapped later, covers the
    // first; each client still renders into its own buffer.
    const meta = (id) => JSON.parse(output().match(new RegExp(`WINDOW_META id=${id} size=(\\d+)x(\\d+)`, 'g')).at(-1)
      .replace(/.*size=(\d+)x(\d+)/, '[$1,$2]'));
    const [a, b] = [meta(first), meta(second)];
    assert.ok(b[0] >= a[0] && b[1] >= a[1], 'Second guest window does not fully cover the first');
  } else {
    // Fully cover the first guest client while retaining its XComposite backing pixmap.
    await guest('wmctrl', '-ir', `0x${first.toString(16)}`, '-e', '0,100,100,820,600');
    await guest('wmctrl', '-ir', `0x${second.toString(16)}`, '-e', '0,100,100,960,700');
    await guest('wmctrl', '-ia', `0x${second.toString(16)}`);
  }
  await delay(1000);
  const before = await snapshot(first, 'occluded-before');
  // Guest pixels per native point: 2 for the Wayland compositor's Retina buffers.
  const scale = before.meta.width / 820;
  assert.ok(scale === 1 || scale === 2, `Unexpected first window width ${before.meta.width}`);
  if (!wayland) {
    const { stdout: stacking } = await guest('xprop', '-root', '_NET_CLIENT_LIST_STACKING');
    const stacked = [...stacking.matchAll(/0x[0-9a-f]+/g)].map((match) => Number(match[0]));
    assert.ok(stacked.indexOf(second) > stacked.indexOf(first), 'Second guest window is not above the first');
    const { stdout: geometries } = await guest('wmctrl', '-lG');
    const geometry = (id) => geometries.split('\n').find((line) => Number(line.split(/\s+/)[0]) === id)?.trim().split(/\s+/).slice(2, 6).map(Number);
    const a = geometry(first), b = geometry(second);
    assert.ok(a && b && b[0] <= a[0] && b[1] <= a[1] && b[0] + b[2] >= a[0] + a[2] &&
      b[1] + b[3] >= a[1] + a[3], 'Second guest window does not fully cover the first');
  }
  await guest('python3', '-c', 'from pathlib import Path; Path("/tmp/workspace/first.txt").write_text("Occluded live update\\n")');
  let live;
  let textChanges = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(500);
    live = await snapshot(first, `occluded-live-${attempt}`);
    textChanges = 0;
    for (let y = 115 * scale; y < 150 * scale; y++) {
      for (let x = 340 * scale; x < 650 * scale; x++) {
        const offset = (y * 820 * scale + x) * 4;
        if ([0, 1, 2].some((channel) => Math.abs(before.pixels[offset + channel] - live.pixels[offset + channel]) > 8)) textChanges++;
      }
    }
    if (textChanges > 100) break;
  }
  assert.ok(textChanges > 100, 'Occluded editor did not repaint external file changes');
  const hidden = await snapshot(first, 'occluded');
  if (!wayland) {
    const { stdout: afterStacking } = await guest('xprop', '-root', '_NET_CLIENT_LIST_STACKING');
    const after = [...afterStacking.matchAll(/0x[0-9a-f]+/g)].map((match) => Number(match[0]));
    assert.ok(after.indexOf(second) > after.indexOf(first), 'Live capture unexpectedly raised the hidden guest');
  }
  const area = 820 * 600 * scale * scale;
  console.log(`PASS fresh repaint while fully occluded: ${textChanges} changed text-region pixels`);
  send({ action: 'nativeSnapshot', id: first, tag: 'occluded' });
  await wait(() => output().includes('WINDOW_METAL_SNAPSHOT tag=occluded '), 'native Metal readback while guest occluded');
  const rendered = await readFile(join(root, 'occluded.metal.bgra'));
  assert.equal(rendered.length, hidden.pixels.length, 'Native drawable has unexpected dimensions');
  let renderingDifferences = 0;
  for (let i = 0; i < rendered.length; i += 4) {
    if ([0, 1, 2].some((channel) => Math.abs(rendered[i + channel] - hidden.pixels[i + channel]) > 3)) renderingDifferences++;
  }
  assert.ok(renderingDifferences / area < 0.005, `Native rendering differs at ${renderingDifferences} pixels`);
  console.log(`PASS actual Metal drawable vs occluded guest pixmap: ${renderingDifferences}/${area} pixels outside tolerance`);
  if (!wayland) await guest('xdotool', 'windowraise', String(first));
  await delay(500);
  const visible = await snapshot(first, 'visible');
  assert.equal(hidden.meta.width, 820 * scale);
  assert.equal(hidden.meta.height, 600 * scale);
  let different = 0;
  for (let i = 0; i < hidden.pixels.length; i += 4) {
    if (hidden.pixels[i] !== visible.pixels[i] || hidden.pixels[i + 1] !== visible.pixels[i + 1] ||
        hidden.pixels[i + 2] !== visible.pixels[i + 2]) different++;
  }
  assert.ok(different / area < 0.02, `Occluded pixmap changed ${different} pixels`);
  assert.ok(new Set(hidden.pixels).size > 32, 'Occluded capture is blank');
  console.log(`PASS fully occluded capture: ${different}/${area} changed pixels on reveal`);

  await click(second, 450, 160);
  await key(second, 0, cmd);
  await type(second, 'Unsaved second window\n');
  send({ action: 'nativeClose', id: second });
  await wait(() => new RegExp(`WINDOW_CREATED id=\\d+ popup=false owner=${second} dialog=true`).test(output()), 'owned unsaved-changes dialog');
  const dialog = Number(new RegExp(`WINDOW_CREATED id=(\\d+) popup=false owner=${second} dialog=true`).exec(output())[1]);
  await wait(() => output().includes(`WINDOW_FRAME id=${dialog} `), 'dialog native frame');
  await snapshot(second, 'unsaved-dialog');
  const dialogSurface = await snapshot(dialog, 'dialog-surface');
  if (wayland) {
    // Server-side decoration (KDE protocol, which GTK 3 honours) leaves only the macOS title bar. A GTK client-side
    // title bar would put its close button in the top-right corner of the surface.
    const { width, height } = dialogSurface.meta;
    const scale = width / Number(output().match(new RegExp(`WINDOW_META id=${dialog} size=(\\d+)x`))[1]);
    const corner = new Set();
    for (let y = 0; y < Math.min(height, 36 * scale); y++) {
      for (let x = width - 28 * scale; x < width; x++) {
        const i = (y * width + x) * 4;
        corner.add(dialogSurface.pixels.readUInt32LE(i) & 0xf0f0f0);
      }
    }
    assert.ok(corner.size <= 2, `GTK dialog drew its own title bar (${corner.size} colours in the top-right corner)`);
    console.log('PASS GTK dialog uses server-side decoration (no Linux title bar under the macOS one)');
  }
  console.log('DIALOG_READY');
  // Escape cancels the real VS Code close prompt.
  await key(dialog, 53);
  await wait(() => output().includes(`WINDOW_DESTROYED id=${dialog}`), 'cancel unsaved dialog');
  assert.ok(!output().includes(`WINDOW_DESTROYED id=${second}`), 'Cancel closed the second window');
  await key(second, 1, cmd);
  await delay(500);
  send({ action: 'nativeClose', id: second });
  await wait(() => output().includes(`WINDOW_DESTROYED id=${second}`), 'close second window only');
  await click(first, 450, 160);
  await key(first, 0, cmd);
  await type(first, 'First survives second close\n');
  await key(first, 1, cmd);
  await delay(700);
  assert.equal((await guest('cat', '/tmp/workspace/first.txt')).stdout, 'First survives second close\n');
  console.log('PASS cancel unsaved close, close second, first remains editable');
  // Arrow/Home/End keys reach the integrated terminal as a line-editing shell, not echoed escapes.
  const terminalKeys = { ...Object.fromEntries(Object.entries(letters).map(([c, code]) => [c, [code, 0]])), '>': [47, shift] };
  const shellType = async (text) => { for (const c of text) await key(first, ...terminalKeys[c]); };
  await key(first, 50, cmd);
  await delay(3000);
  await shellType('echo b');
  await key(first, 123);
  await shellType('a');
  await key(first, 119);
  await shellType(' >> /tmp/workspace/keys.txt\n');
  await delay(800);
  await key(first, 126);
  await shellType('\n');
  await delay(1200);
  assert.equal((await guest('cat', '/tmp/workspace/keys.txt')).stdout, 'ab\nab\n', 'Terminal cursor keys were not interpreted');
  console.log('PASS terminal Left/End edit the line and Up recalls history');
  // The guest cursor is fingerprinted against its theme and shown as the real macOS cursor, so it follows
  // the user's pointer size and colour. Clicking the editor text left the guest showing its text cursor.
  assert.ok(output().includes('WINDOW_CURSOR native=arrow guest='), 'Guest arrow was not mapped to the native arrow');
  assert.ok(/WINDOW_CURSOR native=iBeam guest=[^\n]*\btext\b/.test(output()), 'Guest text cursor was not mapped to the native I-beam');
  assert.ok(!/WINDOW_CURSOR image size=(?!48x48)/.test(output()) || wayland, 'Fallback guest cursor was not the fixed 2x size');
  console.log('PASS guest cursors map to native macOS cursors');
  if (process.env.VSPOD_WINDOW_EVIDENCE) {
    await mkdir(process.env.VSPOD_WINDOW_EVIDENCE, { recursive: true });
    for (const tag of ['file-menu', 'menu-popup', 'occluded', 'visible', 'unsaved-dialog', 'dialog-surface']) {
      for (const ext of ['bgra', 'json']) await writeFile(join(process.env.VSPOD_WINDOW_EVIDENCE, `${tag}.${ext}`),
        await readFile(join(root, `${tag}.${ext}`)));
    }
    await writeFile(join(process.env.VSPOD_WINDOW_EVIDENCE, 'occluded.metal.bgra'), rendered);
  }
  send({ action: 'nativeClose', id: first });
  // The host exits cleanly after the final guest destruction; the launcher checks its exit status.
}
