import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { settledMatch } from './test.mjs';

const cmd = 1 << 20;
const codes = { a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,y:16,t:17,
  o:31,u:32,i:34,p:35,l:37,j:38,k:40,n:45,m:46,' ':49,'\n':36,'.':47,'/':44,'-':27,
  1:18,2:19,3:20,4:21,5:23,6:22,7:26,8:28,9:25,0:29 };

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2));
};
const summarise = (samples, misses) => ({
  samples: samples.length, misses,
  present_ms: { p50: percentile(samples.map((s) => s.present), 0.5), p90: percentile(samples.map((s) => s.present), 0.9) },
  receive_ms: { p50: percentile(samples.map((s) => s.receive), 0.5), p90: percentile(samples.map((s) => s.receive), 0.9) },
  bytes_p50: percentile(samples.map((s) => s.bytes), 0.5),
});

export async function benchmark({ root, wait, output, send }) {
  const first = Number(output().match(/WINDOW_CREATED id=(\d+) popup=false owner=0 dialog=false/)[1]);
  const latencies = () => [...output().matchAll(/WINDOW_LATENCY seq=(\d+) receive_ms=([\d.]+) present_ms=([\d.]+) bytes=(\d+)/g)]
    .map((m) => ({ seq: Number(m[1]), receive: Number(m[2]), present: Number(m[3]), bytes: Number(m[4]) }));
  const key = async (code, flags = 0) => { send({ action: 'testKey', id: first, code, flags }); await delay(60); };
  const type = async (text) => { for (const c of text) await key(codes[c]); };
  const stats = async () => {
    const before = output().length;
    send({ action: 'stats' });
    await wait(() => output().slice(before).includes('WINDOW_STATS'), 'stats');
    const m = output().slice(before).match(/WINDOW_STATS frames=(\d+) bytes=(\d+)/);
    return { frames: Number(m[1]), bytes: Number(m[2]) };
  };
  // Measures one press: the first guest frame presented after it.
  const measured = async (code, flags, count, gap, id = first) => {
    const samples = [];
    let misses = 0;
    for (let i = 0; i < count; i++) {
      await delay(gap);
      const known = Math.max(0, ...latencies().map((l) => l.seq));
      send({ action: 'testKey', id, code, flags });
      const deadline = Date.now() + 2000;
      let sample;
      while (!(sample = latencies().find((l) => l.seq > known)) && Date.now() < deadline) await delay(5);
      if (sample) samples.push(sample); else misses++;
    }
    return summarise(samples, misses);
  };

  await delay(8000);
  send({ action: 'testClick', id: first, x: 450, y: 160 });
  await delay(500);
  const typing = await measured(codes.a, 0, 30, 250);
  console.log(`BENCH typing ${JSON.stringify(typing)}`);

  await key(codes.p, cmd);
  await delay(400);
  await type('long.txt\n');
  await delay(1500);
  const paging = await measured(121, 0, 20, 400);
  console.log(`BENCH page-down ${JSON.stringify(paging)}`);

  await key(50, cmd);
  await delay(3000);
  const terminal = await measured(codes.a, 0, 30, 250);
  console.log(`BENCH terminal-typing ${JSON.stringify(terminal)}`);
  // Ctrl+U clears the typed characters before the flood command.
  await key(codes.u, cmd);
  await delay(300);
  await type('seq 1 3000');
  await delay(800);
  const start = await stats();
  const began = Date.now();
  await key(codes['\n']);
  let last = start, lastChange = Date.now();
  while (Date.now() - lastChange < 700 && Date.now() - began < 30_000) {
    await delay(50);
    const now = await stats();
    if (now.frames !== last.frames) { last = now; lastChange = Date.now(); }
  }
  const flood = { settle_ms: lastChange - began, frames: last.frames - start.frames,
    megabytes: Number(((last.bytes - start.bytes) / 1e6).toFixed(1)) };
  console.log(`BENCH terminal-flood ${JSON.stringify(flood)}`);

  // Hundreds of partial updates have now been applied; the native texture must still match the guest.
  await settledMatch({ root, wait, output, send }, first, 'after-bench');

  // A terminal moved into its own (auxiliary) window.
  const known = output().length;
  // F1 opens the command palette even while the terminal has focus.
  await key(122);
  await delay(1000);
  await type('terminal move terminal into new window');
  await delay(1500);
  await key(codes['\n']);
  await wait(() => /WINDOW_CREATED id=\d+ popup=false/.test(output().slice(known)), 'terminal window', 15_000);
  const detached = Number(output().slice(known).match(/WINDOW_CREATED id=(\d+) popup=false/)[1]);
  await delay(4000);
  const windowTerminal = await measured(codes.a, 0, 30, 250, detached);
  console.log(`BENCH window-terminal-typing ${JSON.stringify(windowTerminal)}`);
  const result = { typing, paging, terminal, flood, windowTerminal };
  if (process.env.VSPOD_WINDOW_EVIDENCE) {
    await mkdir(process.env.VSPOD_WINDOW_EVIDENCE, { recursive: true });
    const label = process.env.VSPOD_WINDOW_BENCH_LABEL || 'bench';
    await writeFile(join(process.env.VSPOD_WINDOW_EVIDENCE, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
  send({ action: 'stop' });
  return result;
}
