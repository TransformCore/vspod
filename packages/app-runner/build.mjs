import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(join(root, 'dist'), { recursive: true });
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/index.mjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
});
if (process.argv.includes('--host')) {
  if (process.platform !== 'darwin') throw new Error('The native application host currently requires macOS.');
  execFileSync('swiftc', ['-O', '-warnings-as-errors',
    ...['main.swift', 'Configuration.swift', 'Integrations.swift', 'InputView.swift'].map((file) => join(root, 'host/macos', file)),
    '-o', join(root, 'dist/app-host'), '-framework', 'AppKit', '-framework', 'MetalKit', '-framework', 'Metal'],
  { stdio: 'inherit' });
}
