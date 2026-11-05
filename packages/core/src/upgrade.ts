import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { resolveWorkspace } from '@vspod/workspace';
import { withProjectLock, writePrivate } from './state.ts';
import type { EditorBackend, EditorSession } from './backend.ts';
import { backendStateDirectory } from './backend.ts';
import { VspodError } from './errors.ts';
import { assertConfigurationActivatable, inspectConfiguration } from './configuration.ts';
import { assertWorkspaceExtensions } from './extensions.ts';
import { requestNativeAttachment } from './native-attachment.ts';
import { withCancellation } from './process.ts';

export async function upgradeWorkspace(backend: EditorBackend, directory: string, rebuild = false): Promise<boolean> {
  const runtime = backend.runtime;
  const workspace = await resolveWorkspace(directory);
  return withProjectLock(workspace, async (rootState) => {
    const state = await backendStateDirectory(rootState, backend);
    await runtime.ensureAvailable(true);
    const instance = await runtime.inspect(workspace);
    if (!instance) throw new VspodError('NO_WORKSPACE', 'This repository has no VSPod environment yet.', 'Run vspod open to create it.');
    if (instance.compatible !== false && !rebuild) return false;
    const configuration = (await inspectConfiguration(workspace)).resolved;
    await assertConfigurationActivatable(workspace, configuration);
    await assertWorkspaceExtensions(backend, workspace, state, configuration);
    await runtime.ensureImage({ rebuild });
    if (backend.nativePresenter) await requestNativeAttachment(rootState, 'close');
    let activated: EditorSession | undefined;
    let ready: EditorSession | undefined;
    try {
      const replacement = await runtime.replace(workspace, async () => {
        activated = await backend.start(workspace, configuration);
        await writePrivate(join(state, 'runtime.json'), activated);
        await backend.waitForReady(workspace, activated);
        for (const command of configuration.startupTasks) {
          if (!runtime.runStartupTask) throw new VspodError('HOOK_RUNTIME_UNSUPPORTED', 'The runtime cannot execute approved startup tasks.', 'Use the maintained Docker runtime.');
          await runtime.runStartupTask(workspace, command);
        }
        await writePrivate(join(state, 'configuration.json'), {
          backend: backend.id, fingerprint: configuration.fingerprint, containerId: activated.containerId, startedAt: activated.startedAt,
        });
        ready = activated;
      });
      await writePrivate(join(state, 'configuration.json'), {
        backend: backend.id, fingerprint: configuration.fingerprint, containerId: replacement.id, startedAt: replacement.startedAt,
      });
    } finally {
      const current = await withCancellation(undefined, () => runtime.inspect(workspace));
      const changed = current && (current.id !== instance.id || current.startedAt !== instance.startedAt);
      if (!current?.running || (changed && (!ready ||
          current.id !== ready.containerId || current.startedAt !== ready.startedAt))) {
        await rm(join(state, 'runtime.json'), { force: true });
        await rm(join(state, 'configuration.json'), { force: true });
      }
    }
    return true;
  });
}