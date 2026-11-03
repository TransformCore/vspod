import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadRepository } from '@vspod/config';
import { installationRoot } from '@vspod/core/installation';

const execute = promisify(execFile);

for (const bundled of [false, true]) {
  test(`${bundled ? 'bundled' : 'source'} CLI migration previews, promotes explicitly, writes once and reports JSON errors without leakage`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'vspod-migrate-cli-'));
    const repo = join(root, 'repo');
    const env = { ...process.env, CI: '1', VSPOD_STATE_DIR: join(root, 'state'), VSPOD_CONFIG_DIR: join(root, 'config') };
    const cli = bundled ? join(root, 'cli.mjs') : join(installationRoot(), 'bin/vspod.mjs');
    const run = (args: string[]) => execute(process.execPath, [cli, 'migrate', ...args], { cwd: repo, env });
    try {
      if (bundled) await execute(process.execPath, ['scripts/build.mjs', cli], { cwd: installationRoot() });
      await mkdir(repo);
      execFileSync('git', ['init', '--quiet', repo]);
      await mkdir(join(repo, '.vscode'));
      const settings = '{ // keep this comment\n"editor.tabSize":2,}';
      const extensions = '{"recommendations":["github.copilot","eamodio.gitlens"],"unwantedRecommendations":["eamodio.gitlens"]}';
      await writeFile(join(repo, '.vscode/settings.json'), settings);
      await writeFile(join(repo, '.vscode/extensions.json'), extensions);
      const preview = JSON.parse((await run(['--json'])).stdout);
      assert.equal(preview.status, 'preview');
      assert.equal(preview.activation, 'not-activated');
      assert.deepEqual(preview.definition.extensions, { optional: ['github.copilot'] });
      assert.equal(preview.notices[0].code, 'MIGRATION_IMPORT_EXCLUSIONS');
      assert.deepEqual((await readdir(repo)).sort(), ['.git', '.vscode']);
      assert.equal((await readdir(root)).includes('state'), false);
      const human = (await run([])).stdout;
      assert.match(human, /Nothing changed/);
      assert.match(human, /Migration never activates a runtime/);
      const promoted = JSON.parse((await run(['--recommendations-as-required', '--json'])).stdout);
      assert.deepEqual(promoted.definition.extensions, { required: ['github.copilot'] });
      const written = JSON.parse((await run(['--write', '--json'])).stdout);
      assert.equal(written.status, 'written');
      assert.deepEqual(await loadRepository(repo), preview.definition);
      assert.equal(await readFile(join(repo, '.vscode/settings.json'), 'utf8'), settings);
      assert.equal(await readFile(join(repo, '.vscode/extensions.json'), 'utf8'), extensions);
      await assert.rejects(run(['--write', '--json']), (error: unknown) => {
        const failure = error as { code: number; stdout: string; stderr: string };
        assert.equal(failure.code, 1);
        assert.equal(failure.stderr, '');
        assert.equal(JSON.parse(failure.stdout).error.code, 'MIGRATION_DESTINATION_EXISTS');
        return true;
      });
      await rm(join(repo, '.vspod/vspod.yml'));
      await writeFile(join(repo, '.vscode/settings.json'), '{"editor.tabSize":2,"password":"DO_NOT_ECHO"}');
      await assert.rejects(run(['--write', '--json']), (error: unknown) => {
        const failure = error as { code: number; stdout: string; stderr: string };
        const report = JSON.parse(failure.stdout);
        assert.equal(failure.code, 1);
        assert.equal(report.status, 'error');
        assert.equal(report.error.code, 'CONFIG_SECRET_FORBIDDEN');
        assert.equal(report.yaml, undefined);
        assert.doesNotMatch(failure.stdout + failure.stderr, /DO_NOT_ECHO|at .*\.ts:/);
        return true;
      });
      assert.deepEqual(await readdir(join(repo, '.vspod')), []);
    } finally { await rm(root, { force: true, recursive: true }); }
  });
}
