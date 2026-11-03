import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { resolveWorkspace } from '@vspod/workspace';
import { withProjectLock, writePrivate } from './state.ts';
import type { ContainerRuntime } from './runtime.ts';
import { VspodError } from './errors.ts';
import { assertConfigurationActivatable, inspectConfiguration } from './configuration.ts';
import { assertWorkspaceExtensions } from './extensions.ts';

export async function upgradeWorkspace(runtime: ContainerRuntime, directory: string, rebuild = false): Promise<boolean> {
  const workspace = await resolveWorkspace(directory);
  return withProjectLock(workspace, async (state) => {
    await runtime.ensureAvailable(true);
    const instance = await runtime.inspect(workspace);
    if (!instance) throw new VspodError('NO_WORKSPACE', 'This repository has no VSPod environment yet.', 'Run vspod open to create it.');
    if (instance.compatible !== false && !rebuild) return false;
    const configuration = (await inspectConfiguration(workspace)).resolved;
    await assertConfigurationActivatable(workspace, configuration);
    await assertWorkspaceExtensions(runtime, workspace, state, configuration);
    await runtime.ensureImage({ rebuild });
    const password = randomBytes(32).toString('hex');
    try {
      const replacement = await runtime.replace(workspace, password, configuration);
      for (const command of configuration.startupTasks) {
        if (!runtime.runStartupTask) throw new VspodError('HOOK_RUNTIME_UNSUPPORTED', 'The runtime cannot execute approved startup tasks.', 'Use the maintained Docker runtime.');
        await runtime.runStartupTask(workspace, command);
      }
      await writePrivate(join(state, 'configuration.json'), {
        fingerprint: configuration.fingerprint, containerId: replacement.id, startedAt: replacement.startedAt,
      });
    } finally {
      const current = await runtime.inspect(workspace);
      if (current?.running && (current.id !== instance.id || current.startedAt !== instance.startedAt)) {
        await writePrivate(join(state, 'runtime.json'), { containerId: current.id, startedAt: current.startedAt ?? '', password });
      } else if (!current?.running) {
        await rm(join(state, 'runtime.json'), { force: true });
      }
    }
    return true;
  });
}