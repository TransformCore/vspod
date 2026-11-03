import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { installationRoot } from '@vspod/core/installation';

const execute = promisify(execFile);

test('CLI first-run history is empty and recovery errors have a next step without a stack', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vspod-cli-'));
  const environment = { ...process.env, CI: '1', VSPOD_STATE_DIR: join(directory, 'state') };
  const cli = join(installationRoot(), 'bin/vspod.mjs');
  try {
    const recent = await execute(process.execPath, [cli, 'recent', '--json'], { cwd: directory, env: environment });
    assert.deepEqual(JSON.parse(recent.stdout), []);
    const restore = await execute(process.execPath, [cli, 'restore'], { cwd: directory, env: environment });
    assert.match(restore.stdout, /No windows to restore/);
    await assert.rejects(execute(process.execPath, [cli, 'reopen'], { cwd: directory, env: environment }), (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Open your first repository/);
      assert.match(result.stderr, /NO_RECENT_FOLDERS/);
      assert.doesNotMatch(result.stderr, /at .*\.ts:/);
      return true;
    });

    const quit = await execute(process.execPath, [cli, 'quit'], { cwd: directory, env: environment });
    assert.match(quit.stdout, /Closed 0 windows/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('CLI profiles and configuration inspection work without Docker and enforce executable trust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-cli-config-'));
  const environment = { ...process.env, CI: '1', VSPOD_STATE_DIR: join(root, 'state'), VSPOD_CONFIG_DIR: join(root, 'config') };
  const cli = join(installationRoot(), 'bin/vspod.mjs');
  const run = (args: string[], cwd = root) => execute(process.execPath, [cli, ...args], { cwd, env: environment });
  try {
    assert.equal(JSON.parse((await run(['profile', '--json'])).stdout).selected, 'default');
    await run(['profile', 'create', 'work']);
    await writeFile(join(root, 'config/profiles/work/profile.yml'), 'schemaVersion: 1\ntheme: one-dark\n');
    await run(['profile', 'switch', 'work', '--global']);
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo]);
    await mkdir(join(repo, '.vspod'));
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\nsettings:\n  editor.tabSize: 2\n');
    const preview = JSON.parse((await run(['config', 'explain', '--json'], repo)).stdout);
    assert.equal(preview.activation, 'supported-settings');
    assert.equal(preview.profile.name, 'work');
    assert.equal(preview.resolved.settings['editor.tabSize'], 2);
    assert.equal(preview.resolved.settings['workbench.colorTheme'], 'one-dark');
    await run(['profile', 'switch', 'default'], repo);
    assert.equal(JSON.parse((await run(['profile', '--json'], repo)).stdout).scope, 'workspace');
    assert.equal(JSON.parse((await run(['profile', '--json'])).stdout).selected, 'work');
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\ntasks:\n  startup: ["npm ci"]\n');
    await assert.rejects(run(['trust'], repo), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /CONFIG_TRUST_REQUIRED/);
      return true;
    });
    await run(['trust', '--yes'], repo);
    await run(['trust', '--revoke'], repo);
    await assert.rejects(run(['extensions', 'sync', repo, '--include-optional', '--exclude-optional']), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /EXTENSIONS_USAGE/);
      return true;
    });
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\npassword: DO_NOT_ECHO\n');
    await assert.rejects(run(['config', 'explain'], repo), (error: unknown) => {
      const { stderr } = error as { stderr: string };
      assert.match(stderr, /CONFIG_SECRET_FORBIDDEN/);
      assert.doesNotMatch(stderr, /DO_NOT_ECHO|at .*\.ts:/);
      return true;
    });
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('bundled CLI resolves ESM parser dependencies and persists host selections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-cli-bundle-'));
  const cli = join(root, 'cli.mjs');
  const environment = { ...process.env, CI: '1', VSPOD_STATE_DIR: join(root, 'state'), VSPOD_CONFIG_DIR: join(root, 'config') };
  const run = (args: string[]) => execute(process.execPath, [cli, ...args], { cwd: root, env: environment });
  try {
    await execute(process.execPath, ['scripts/build.mjs', cli], { cwd: installationRoot() });
    assert.equal(JSON.parse((await run(['profile', '--json'])).stdout).selected, 'default');
    await run(['profile', 'create', 'work']);
    await run(['profile', 'switch', 'work', '--global']);
    execFileSync('git', ['init', '--quiet', root]);
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/settings.json'), '{/*JSONC*/"editor.tabSize":2,}');
    const result = JSON.parse((await run(['config', 'explain', '--compatibility', '--json'])).stdout);
    assert.equal(result.activation, 'supported-settings');
    assert.equal(result.profile.name, 'work');
    assert.equal(result.resolved.settings['editor.tabSize'], 2);
    assert.equal(result.resolved.provenance['editor.tabSize'], 'compatibility');
    assert.match((await run(['extensions', 'update', '--help'])).stdout, /approve/);
    await assert.rejects(run(['extensions', 'sync', '--include-optional', '--exclude-optional']), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /EXTENSIONS_USAGE/);
      return true;
    });
  } finally { await rm(root, { force: true, recursive: true }); }
});