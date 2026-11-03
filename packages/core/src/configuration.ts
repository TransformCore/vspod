import { loadCompatibility, loadRepository, resolveConfiguration } from '@vspod/config';
import type { ResolvedConfiguration } from '@vspod/config';
import type { Workspace } from '@vspod/workspace';
import { selectedProfile } from './profiles.ts';
import { VspodError } from './errors.ts';
import { assertConfigurationTrust } from './trust.ts';
import { join } from 'node:path';
import { configurationDirectory } from './profiles.ts';
import { privateDirectory, readPrivate, writePrivate } from './state.ts';

export async function compatibilityEnabled(workspace: Workspace): Promise<boolean> {
  const root = configurationDirectory();
  await privateDirectory(root);
  const directory = join(root, 'workspace-preferences');
  await privateDirectory(directory);
  const value = await readPrivate<unknown>(join(directory, `${workspace.id}.json`));
  if (value === undefined) return false;
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 ||
      !('compatibility' in value) || typeof value.compatibility !== 'boolean') {
    throw new VspodError('CONFIG_PREFERENCES_INVALID', 'Workspace compatibility preference is invalid.', 'Reset it explicitly using vspod config compatibility off.');
  }
  return value.compatibility;
}

export async function setCompatibility(workspace: Workspace, enabled: boolean): Promise<void> {
  await privateDirectory(configurationDirectory());
  const directory = join(configurationDirectory(), 'workspace-preferences');
  await privateDirectory(directory);
  await writePrivate(join(directory, `${workspace.id}.json`), { schemaVersion: 1, compatibility: enabled });
}

export async function inspectConfiguration(workspace: Workspace, compatibility?: boolean) {
  compatibility ??= await compatibilityEnabled(workspace);
  const [selection, repository, vscode] = await Promise.all([
    selectedProfile(workspace.id), loadRepository(workspace.root), loadCompatibility(workspace.root, compatibility),
  ]);
  return {
    activation: 'supported-settings' as const,
    profile: { name: selection.name, scope: selection.scope },
    compatibility,
    resolved: resolveConfiguration({ profile: selection.profile, repository, compatibility: vscode }),
    hasRepositoryDefinition: repository !== undefined,
  };
}

export async function assertConfigurationActivatable(workspace: Workspace, resolved?: ResolvedConfiguration): Promise<void> {
  resolved ??= (await inspectConfiguration(workspace)).resolved;
  if (resolved.accounts.required.length) {
    throw new VspodError('ACCOUNT_RUNTIME_UNSUPPORTED', 'Required accounts cannot yet be brokered into this runtime.',
      'Host login alone does not grant container access. Remove the requirement only if the project genuinely does not need it; credential injection remains gated.');
  }
  await assertConfigurationTrust(workspace, resolved);
}
