import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRepository, planMigration } from '@vspod/config';
import { resolveWorkspace } from '@vspod/workspace';
import { migrateWorkspace, writeMigration } from './migration.ts';

test('migration preview is read-only and write publishes a validated owner-only definition without changing source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-write-'));
  const oldState = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo]);
    await mkdir(join(repo, '.vscode'));
    const text = '{/* source */"editor.tabSize":2,}';
    await writeFile(join(repo, '.vscode/settings.json'), text);
    const workspace = await resolveWorkspace(repo);
    const preview = await migrateWorkspace(workspace);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.activation, 'not-activated');
    assert.deepEqual((await readdir(repo)).sort(), ['.git', '.vscode']);
    assert.deepEqual(await readdir(root), ['repo']);
    const result = await migrateWorkspace(workspace, { write: true });
    assert.equal(result.status, 'written');
    assert.equal(result.yaml, preview.yaml);
    assert.deepEqual(await loadRepository(repo), preview.definition);
    assert.equal(await readFile(join(repo, '.vscode/settings.json'), 'utf8'), text);
    assert.equal((await stat(join(repo, '.vspod/vspod.yml'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(repo, '.vspod')), ['vspod.yml']);
    await assert.rejects(migrateWorkspace(workspace), { code: 'MIGRATION_DESTINATION_EXISTS' });
    await assert.rejects(migrateWorkspace(workspace, { write: true }), { code: 'MIGRATION_DESTINATION_EXISTS' });
    assert.equal(await readFile(join(repo, '.vspod/vspod.yml'), 'utf8'), preview.yaml);
  } finally {
    if (oldState === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = oldState;
    await rm(root, { force: true, recursive: true });
  }
});

test('migration rejects destination files, directories and symlinks without altering their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-paths-'));
  const oldState = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo]);
    await mkdir(join(repo, '.vscode'));
    await writeFile(join(repo, '.vscode/settings.json'), '{"editor.tabSize":2}');
    const workspace = await resolveWorkspace(repo);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(repo, '.vspod'));
    await assert.rejects(migrateWorkspace(workspace, { write: true }), { code: 'MIGRATION_PATH_UNSAFE' });
    assert.deepEqual(await readdir(outside), []);
    await rm(join(repo, '.vspod'));
    await writeFile(join(repo, '.vspod'), 'leave alone');
    await assert.rejects(migrateWorkspace(workspace), { code: 'MIGRATION_PATH_UNSAFE' });
    await rm(join(repo, '.vspod'));
    await mkdir(join(repo, '.vspod'));
    await symlink(join(outside, 'missing'), join(repo, '.vspod/vspod.yml'));
    await assert.rejects(migrateWorkspace(workspace, { write: true }), { code: 'MIGRATION_DESTINATION_EXISTS' });
    assert.deepEqual(await readdir(outside), []);
    await rm(join(repo, '.vspod/vspod.yml'));
    await mkdir(join(repo, '.vspod/vspod.yml'));
    await assert.rejects(migrateWorkspace(workspace), { code: 'MIGRATION_DESTINATION_EXISTS' });
  } finally {
    if (oldState === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = oldState;
    await rm(root, { force: true, recursive: true });
  }
});

test('blocked inputs leave no repository destination or pending files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-blocked-'));
  const oldState = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  try {
    execFileSync('git', ['init', '--quiet', root]);
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2,"password":"DO_NOT_ECHO"}');
    await assert.rejects(migrateWorkspace(await resolveWorkspace(root), { write: true }), { code: 'CONFIG_SECRET_FORBIDDEN' });
    assert.equal((await readdir(root)).includes('.vspod'), false);
  } finally {
    if (oldState === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = oldState;
    await rm(root, { force: true, recursive: true });
  }
});

test('stale preview rejects changed source bytes, newly added inputs and tampered output before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-stale-'));
  const oldState = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  try {
    execFileSync('git', ['init', '--quiet', root]);
    await mkdir(join(root, '.vscode'));
    const path = join(root, '.vscode/settings.json');
    await writeFile(path, '{"editor.tabSize":2}');
    const workspace = await resolveWorkspace(root);
    const plan = await planMigration(root);
    await writeFile(path, '{/*changed bytes*/"editor.tabSize":2}');
    await assert.rejects(writeMigration(workspace, plan), { code: 'MIGRATION_INPUT_CHANGED' });
    await writeFile(path, '\uFEFF{"editor.tabSize":2}');
    await assert.rejects(writeMigration(workspace, plan), { code: 'MIGRATION_INPUT_CHANGED' });
    await writeFile(path, '{"editor.tabSize":2}');
    await writeFile(join(root, '.vscode/extensions.json'), '{"recommendations":["github.copilot"]}');
    await assert.rejects(writeMigration(workspace, plan), { code: 'MIGRATION_INPUT_CHANGED' });
    await rm(join(root, '.vscode/extensions.json'));
    await assert.rejects(writeMigration(workspace, { ...plan, yaml: 'schemaVersion: 1\naccounts:\n  required: [github]\n' }), { code: 'MIGRATION_INPUT_CHANGED' });
    assert.equal((await readdir(root)).includes('.vspod'), false);
  } finally {
    if (oldState === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = oldState;
    await rm(root, { force: true, recursive: true });
  }
});

test('concurrent migrations publish one complete definition and never replace the winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-concurrent-'));
  const oldState = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  try {
    execFileSync('git', ['init', '--quiet', root]);
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2}');
    const workspace = await resolveWorkspace(root);
    const results = await Promise.allSettled([
      migrateWorkspace(workspace, { write: true }),
      migrateWorkspace(workspace, { write: true }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.deepEqual(await loadRepository(root), { schemaVersion: 1, settings: { 'editor.tabSize': 2 } });
    assert.deepEqual(await readdir(join(root, '.vspod')), ['vspod.yml']);
  } finally {
    if (oldState === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = oldState;
    await rm(root, { force: true, recursive: true });
  }
});

test('a failed staging write preserves existing directory contents and publishes no definition', { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-migration-permissions-'));
  const oldState = process.env.VSPOD_STATE_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  const directory = join(root, '.vspod');
  try {
    execFileSync('git', ['init', '--quiet', root]);
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.vscode/settings.json'), '{"editor.tabSize":2}');
    await mkdir(directory);
    await writeFile(join(directory, 'keep.txt'), 'unchanged');
    await chmod(directory, 0o500);
    await assert.rejects(migrateWorkspace(await resolveWorkspace(root), { write: true }), { code: 'MIGRATION_WRITE' });
    assert.deepEqual(await readdir(directory), ['keep.txt']);
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'unchanged');
  } finally {
    await chmod(directory, 0o700);
    if (oldState === undefined) delete process.env.VSPOD_STATE_DIR;
    else process.env.VSPOD_STATE_DIR = oldState;
    await rm(root, { force: true, recursive: true });
  }
});
