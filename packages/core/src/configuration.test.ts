import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveWorkspace } from '@vspod/workspace';
import { assertConfigurationActivatable, inspectConfiguration } from './configuration.ts';
import { createProfile, switchProfile } from './profiles.ts';
import { openWorkspace } from './open.ts';
import type { ContainerRuntime } from './runtime.ts';
import { trustConfiguration, configurationTrusted, revokeConfigurationTrust } from './trust.ts';
import { setCompatibility } from './configuration.ts';

test('settings resolve for activation while executable configuration and account requirements fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-configuration-'));
  const oldConfig = process.env.VSPOD_CONFIG_DIR;
  process.env.VSPOD_CONFIG_DIR = join(root, 'configuration');
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo]);
    const workspace = await resolveWorkspace(repo);
    await assertConfigurationActivatable(workspace);
    await createProfile('work');
    await switchProfile('work', workspace.id);
    await writeFile(join(process.env.VSPOD_CONFIG_DIR, 'profiles/work/profile.yml'), 'schemaVersion: 1\nsettings:\n  editor.tabSize: 8\n');
    assert.equal((await inspectConfiguration(workspace)).resolved.settings['editor.tabSize'], 8);
    await assertConfigurationActivatable(workspace);
    await switchProfile('default', workspace.id);
    await mkdir(join(repo, '.vspod'));
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\nsettings:\n  editor.tabSize: 2\n');
    const inspection = await inspectConfiguration(workspace);
    assert.equal(inspection.activation, 'supported-settings');
    assert.equal(inspection.resolved.settings['editor.tabSize'], 2);
    let runtimeCalls = 0;
    const unexpected = async (): Promise<never> => { runtimeCalls++; throw new Error('Runtime must not be used'); };
    const runtime: ContainerRuntime = {
      ensureAvailable: unexpected, ensureImage: unexpected, inspect: unexpected, create: unexpected,
      start: unexpected, stop: unexpected, exec: unexpected, logs: unexpected, replace: unexpected,
    };
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\ntasks:\n  startup:\n    - npm install\n');
    await assert.rejects(assertConfigurationActivatable(workspace), { code: 'CONFIG_TRUST_REQUIRED' });
    const snapshot = (await inspectConfiguration(workspace)).resolved;
    await trustConfiguration(workspace, snapshot);
    assert.equal(await configurationTrusted(workspace, snapshot), true);
    await assertConfigurationActivatable(workspace);
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\ntasks:\n  startup:\n    - npm ci\n');
    assert.equal(await configurationTrusted(workspace, (await inspectConfiguration(workspace)).resolved), false);
    await revokeConfigurationTrust(workspace);
    assert.equal(await configurationTrusted(workspace, snapshot), false);
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\naccounts:\n  required: [github]\n');
    await assert.rejects(assertConfigurationActivatable(workspace), { code: 'ACCOUNT_RUNTIME_UNSUPPORTED' });
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 9\n');
    await assert.rejects(inspectConfiguration(workspace), { code: 'CONFIG_VERSION_UNSUPPORTED' });
    assert.equal(runtimeCalls, 0);
  } finally {
    if (oldConfig === undefined) delete process.env.VSPOD_CONFIG_DIR;
    else process.env.VSPOD_CONFIG_DIR = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('host compatibility preferences control runtime resolution, with repository settings highest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-compatibility-'));
  const oldConfig = process.env.VSPOD_CONFIG_DIR;
  process.env.VSPOD_CONFIG_DIR = join(root, 'config');
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo]);
    await mkdir(join(repo, '.vscode'));
    await writeFile(join(repo, '.vscode/settings.json'), '{"editor.tabSize":7}');
    const workspace = await resolveWorkspace(repo);
    assert.equal((await inspectConfiguration(workspace)).resolved.settings['editor.tabSize'], 4);
    await setCompatibility(workspace, true);
    assert.equal((await inspectConfiguration(workspace)).resolved.settings['editor.tabSize'], 7);
    await mkdir(join(repo, '.vspod'));
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\nsettings:\n  editor.tabSize: 2\n');
    assert.equal((await inspectConfiguration(workspace)).resolved.settings['editor.tabSize'], 2);
    await setCompatibility(workspace, false);
    assert.equal((await inspectConfiguration(workspace)).compatibility, false);
  } finally {
    if (oldConfig === undefined) delete process.env.VSPOD_CONFIG_DIR;
    else process.env.VSPOD_CONFIG_DIR = oldConfig;
    await rm(root, { force: true, recursive: true });
  }
});
