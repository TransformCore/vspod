#!/usr/bin/env node
import { register } from 'tsx/esm/api';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('VSPod requires Node.js 22 or newer. Select a supported Node.js version and retry.');
  process.exit(1);
}
register();
await import('../apps/cli/src/index.ts');