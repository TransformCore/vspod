import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { installationRoot } from '@vspod/core/installation';

const execute = promisify(execFile);

for (const bundled of [false, true]) {
  test(`${bundled ? 'bundled' : 'source'} identity CLI lists isolated metadata and never initiates noninteractive OAuth`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'vspod-identity-cli-'));
    const env = {
      ...process.env, CI: '1', VSPOD_STATE_DIR: join(root, 'state'), VSPOD_CONFIG_DIR: join(root, 'config'),
      VSPOD_GITHUB_CLIENT_ID: '', VSPOD_AZURE_CLIENT_ID: '', VSPOD_AZURE_TENANT_ID: '',
    };
    const cli = bundled ? join(root, 'cli.mjs') : join(installationRoot(), 'bin/vspod.mjs');
    const run = (args: string[]) => execute(process.execPath, [cli, ...args], { cwd: root, env });
    try {
      if (bundled) {
        await writeFile(join(root, 'package.json'), '{"name":"vspod","type":"module"}');
        await execute(process.execPath, ['scripts/build.mjs', cli], { cwd: installationRoot() });
      }
      assert.deepEqual(JSON.parse((await run(['accounts', '--json'])).stdout), []);
      assert.match((await run(['logout', '--all'])).stdout, /No VSPod accounts/);
      for (const [args, expected] of [
        [['login', 'salesforce'], 'ACCOUNT_PROVIDER_UNSUPPORTED'],
        [['login', 'github'], 'ACCOUNT_CLIENT_CONFIGURATION'],
        [['login', 'azure', '--client-id', 'public-app'], 'ACCOUNT_CLIENT_CONFIGURATION'],
        [['login', 'github', '--client-id', 'public-app'], 'ACCOUNT_INTERACTIVE_REQUIRED'],
      ] as const) {
        await assert.rejects(run([...args]), (error: unknown) => {
          const failure = error as { code: number; stderr: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr, new RegExp(expected));
          assert.doesNotMatch(failure.stderr, /at .*\.ts:/);
          return true;
        });
      }
    } finally { await rm(root, { force: true, recursive: true }); }
  });
}
