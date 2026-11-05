import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

// Sweeps a real-mouse-like stream of moves (posted through the app event queue every 8 ms) across the guest
// menu bar while a menu is open, then checks that the open menu belongs to the title under the pointer.
export async function menubarStress({ name, execute, wait, output, send }) {
  const first = Number(output().match(/WINDOW_CREATED id=(\d+) popup=false owner=0 dialog=false/)[1]);
  const y = 12;
  const openMenu = () => {
    const created = [...output().matchAll(/WINDOW_CREATED id=(\d+) popup=true/g)].at(-1);
    if (!created || output().includes(`WINDOW_DESTROYED id=${created[1]}\n`)) return null;
    const meta = [...output().matchAll(new RegExp(`WINDOW_META id=${created[1]} size=\\S+ at=(-?\\d+),`, 'g'))].at(-1);
    return meta ? Number(meta[1]) : null;
  };
  let pointer = 18;
  const glide = async (target, step) => {
    while (pointer !== target) {
      pointer = pointer < target ? Math.min(target, pointer + step) : Math.max(target, pointer - step);
      send({ action: 'testPostMove', id: first, x: pointer, y });
      await delay(8);
    }
  };
  await delay(8000);
  send({ action: 'testClick', id: first, x: 18, y });
  await wait(() => openMenu() !== null, 'File menu');

  // Calibrate: which menu (by popup x) each title position opens, gliding slowly and dwelling.
  const map = new Map();
  for (let x = 10; x <= 340; x += 10) {
    await glide(x, 2);
    await delay(700);
    map.set(x, openMenu());
  }
  const menus = [...new Set(map.values())];
  console.log(`STRESS_CALIBRATION ${JSON.stringify([...map])}`);
  assert.ok(menus.length >= 6 && !menus.includes(null), `Calibration found too few menus: ${JSON.stringify([...map])}`);

  // Stress: random targets at realistic speeds; only judge points well inside a title (same menu at x-10/x+10).
  const inside = [...map.keys()].filter((x) => map.get(x - 10) === map.get(x) && map.get(x + 10) === map.get(x));
  const misses = [];
  const rounds = Number(process.env.VSPOD_STRESS_ROUNDS || 60);
  for (let round = 0; round < rounds; round++) {
    const target = inside[Math.floor(Math.random() * inside.length)];
    const step = [2, 4, 8, 16][round % 4];
    await glide(target, step);
    const settle = round % 3 === 0 ? 150 : 600;
    await delay(settle);
    // A long sweep queues one asynchronous menu switch per title crossed; judge where the bar settles.
    const deadline = Date.now() + 3000;
    while (openMenu() !== map.get(target) && Date.now() < deadline) await delay(50);
    const got = openMenu();
    if (got !== map.get(target)) {
      misses.push({ round, target, step, settle, expected: map.get(target), got });
      if (process.env.VSPOD_POINTER_TRACE === '1') {
        const trace = (await execute('docker', ['exec', name, 'tail', '-n', '150', '/tmp/compositor.log'])).stdout;
        console.log(`STRESS_MISS_TRACE round=${round}\n${trace}STRESS_MISS_TRACE_END`);
      }
    }
  }
  console.log(`STRESS_RESULT rounds=${rounds} misses=${misses.length} ${JSON.stringify(misses)}`);
  if (process.env.VSPOD_POINTER_TRACE === '1' && process.env.VSPOD_STRESS_LOG) {
    await writeFile(process.env.VSPOD_STRESS_LOG, (await execute('docker', ['exec', name, 'cat', '/tmp/compositor.log'], { maxBuffer: 64_000_000 })).stdout);
  }
  send({ action: 'stop' });
  assert.equal(misses.length, 0, 'Menu bar hover missed a title');
}
