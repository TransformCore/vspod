import { build } from 'esbuild';

await build({
  entryPoints: ['apps/cli/src/index.ts'],
  outfile: process.argv[2] ?? 'dist/cli.mjs',
  bundle: true,
  platform: 'node',
  // Prefer JSONC's ESM entry; its UMD entry leaves relative requires in a bundle.
  mainFields: ['module', 'main'],
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});