import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveWorkspace } from '@vspod/workspace';
import type { ContainerRuntime } from './runtime.ts';
import { assertWorkspaceExtensions, syncWorkspaceExtensions } from './extensions.ts';
import { inspectConfiguration } from './configuration.ts';
import { trustConfiguration } from './trust.ts';
import { privateDirectory, readPrivate, writePrivate } from './state.ts';

test('extension activation requires matching receipts and exact required installed versions; reconciliation never changes a running editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vspod-extensions-core-'));
  const previous = process.env.VSPOD_STATE_DIR;
  const previousConfig = process.env.VSPOD_CONFIG_DIR;
  process.env.VSPOD_STATE_DIR = join(root, 'state');
  process.env.VSPOD_CONFIG_DIR = join(root, 'configuration');
  let running = false;
  let mutations = 0;
  let installed = [{ id: 'local.manual', version: '1.0.0' }];
  const instance = { id: 'container', running: false, compatible: true };
  const runtime: ContainerRuntime = {
    ensureAvailable: async () => {}, ensureImage: async () => {}, inspect: async () => ({ ...instance, running }),
    create: async () => {}, start: async () => instance, stop: async () => {},
    exec: async () => 0, logs: async () => 0, replace: async () => instance,
    extensionAdapter: () => ({
      list: async () => installed,
      install: async () => { mutations++; }, uninstall: async () => { mutations++; },
    }),
  };
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo]);
    const workspace = await resolveWorkspace(repo);
    const state = join(process.env.VSPOD_STATE_DIR, workspace.id);
    const empty = (await inspectConfiguration(workspace)).resolved;
    await assertWorkspaceExtensions(runtime, workspace, state, empty);
    const outcomes = await syncWorkspaceExtensions(runtime, workspace);
    assert.deepEqual(outcomes, []);
    assert.deepEqual(installed, [{ id: 'local.manual', version: '1.0.0' }]);
    assert.equal(mutations, 0);
    assert.ok(await readPrivate(join(state, 'extensions-applied.json')));
    running = true;
    await assert.rejects(syncWorkspaceExtensions(runtime, workspace), { code: 'EXTENSIONS_STOP_REQUIRED' });
    assert.equal(mutations, 0);
    running = false;
    await mkdir(join(repo, '.vspod'));
    await writeFile(join(repo, '.vspod/vspod.yml'), 'schemaVersion: 1\nextensions:\n  required: [test.required@1.2.3]\n  optional: [test.optional]\n');
    const configuration = (await inspectConfiguration(workspace)).resolved;
    await assert.rejects(syncWorkspaceExtensions(runtime, workspace), { code: 'CONFIG_TRUST_REQUIRED' });
    await trustConfiguration(workspace, configuration);
    await assert.rejects(assertWorkspaceExtensions(runtime, workspace, state, configuration), { code: 'EXTENSIONS_SYNC_REQUIRED' });
    await privateDirectory(state);
    await writePrivate(join(state, 'extensions-applied.json'), {
      schemaVersion: 1,
      intentHash: createHash('sha256').update(JSON.stringify(configuration.extensions)).digest('hex'),
      includeOptional: false,
      outcomes: [
        { id: 'test.required', version: '1.2.3', status: 'installed', required: true },
        { id: 'test.optional', status: 'failed', required: false },
      ],
    });
    await assert.rejects(assertWorkspaceExtensions(runtime, workspace, state, configuration), { code: 'EXTENSION_REQUIRED_UNAVAILABLE' });
    installed = [...installed, { id: 'test.required', version: '1.2.3' }];
    await assertWorkspaceExtensions(runtime, workspace, state, configuration);
    installed = installed.map((item) => item.id === 'test.required' ? { ...item, version: '1.2.4' } : item);
    await assert.rejects(assertWorkspaceExtensions(runtime, workspace, state, configuration), { code: 'EXTENSION_REQUIRED_UNAVAILABLE' });
    assert.equal(mutations, 0);
  } finally {
    if (previous === undefined) delete process.env.VSPOD_STATE_DIR; else process.env.VSPOD_STATE_DIR = previous;
    if (previousConfig === undefined) delete process.env.VSPOD_CONFIG_DIR; else process.env.VSPOD_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
