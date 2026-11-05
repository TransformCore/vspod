import { writeFile, rename } from 'node:fs/promises';
import { applyConfiguration } from './apply-configuration.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 512 * 1024) throw new Error('Bootstrap payload is too large.');
}
const config = JSON.parse(input);
if (!/^[a-f0-9]{64}$/.test(config.password)) throw new Error('Invalid bootstrap credential.');
if (config.configuration) await applyConfiguration(config.configuration);
await writeFile('/run/vspod/credentials.pending', JSON.stringify({ password: config.password }), { mode: 0o600, flag: 'wx' });
await rename('/run/vspod/credentials.pending', '/run/vspod/credentials.json');