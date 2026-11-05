import { rename, writeFile } from 'node:fs/promises';
import { applyConfiguration } from './apply-configuration.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 512 * 1024) throw new Error('Desktop configuration payload is too large.');
}
const configuration = JSON.parse(input);
await applyConfiguration({
  ...configuration,
  settings: {
    'terminal.integrated.gpuAcceleration': 'off',
    'workbench.startupEditor': 'none',
    ...configuration.settings,
    'window.titleBarStyle': 'native',
    'window.menuBarVisibility': 'classic',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'security.workspace.trust.enabled': false,
  },
});
await writeFile('/tmp/vspod-launch.pending', JSON.stringify({ restricted: configuration.restricted === true }),
  { mode: 0o600, flag: 'wx' });
await rename('/tmp/vspod-launch.pending', '/tmp/vspod-launch.json');
