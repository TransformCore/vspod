import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { ResolvedConfiguration } from '@vspod/config';
import type { Workspace } from '@vspod/workspace';
import { configurationDirectory } from './profiles.ts';
import { privateDirectory, readPrivate, writePrivate } from './state.ts';
import { VspodError } from './errors.ts';

export function needsConfigurationTrust(configuration: ResolvedConfiguration): boolean {
  return configuration.startupTasks.length > 0 || configuration.keybindings.length > 0 ||
    configuration.extensions.some((extension) => extension.selected);
}

export async function configurationTrusted(workspace: Workspace, configuration: ResolvedConfiguration): Promise<boolean> {
  if (!needsConfigurationTrust(configuration)) return true;
  const directory = join(configurationDirectory(), 'trust');
  await privateDirectory(configurationDirectory());
  await privateDirectory(directory);
  const grant = await readPrivate<unknown>(join(directory, `${workspace.id}.json`));
  if (grant === undefined) return false;
  if (!grant || typeof grant !== 'object' || !('schemaVersion' in grant) || grant.schemaVersion !== 1 ||
      !('fingerprint' in grant) || typeof grant.fingerprint !== 'string' ||
      !('workspaceId' in grant) || grant.workspaceId !== workspace.id) {
    throw new VspodError('TRUST_STATE_INVALID', 'Repository trust metadata is invalid.', 'Review or revoke this repository trust using vspod trust --revoke.');
  }
  return grant.fingerprint === configuration.fingerprint;
}

export async function trustConfiguration(workspace: Workspace, configuration: ResolvedConfiguration): Promise<void> {
  const directory = join(configurationDirectory(), 'trust');
  await privateDirectory(configurationDirectory());
  await privateDirectory(directory);
  await writePrivate(join(directory, `${workspace.id}.json`), {
    schemaVersion: 1, workspaceId: workspace.id, fingerprint: configuration.fingerprint,
    approvedAt: new Date().toISOString(),
  });
}

export async function revokeConfigurationTrust(workspace: Workspace): Promise<void> {
  const root = configurationDirectory();
  await privateDirectory(root);
  const directory = join(root, 'trust');
  await privateDirectory(directory);
  await rm(join(directory, `${workspace.id}.json`), { force: true });
}

export async function assertConfigurationTrust(workspace: Workspace, configuration: ResolvedConfiguration): Promise<void> {
  if (!await configurationTrusted(workspace, configuration)) {
    throw new VspodError('CONFIG_TRUST_REQUIRED', 'Executable configuration requires approval.',
      'Run vspod trust to review selected extensions, keybindings and startup commands. Changed configuration requires renewed approval; open --yes does not grant trust.');
  }
}
