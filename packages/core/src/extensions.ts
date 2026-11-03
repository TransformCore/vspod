import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ExtensionManager, RequiredExtensionFailure } from '@vspod/extensions';
import type { ExtensionArtifactApproval, ExtensionArtifactApprovalRequest, ExtensionOutcome } from '@vspod/extensions';
import type { ResolvedConfiguration } from '@vspod/config';
import type { Workspace } from '@vspod/workspace';
import type { ContainerRuntime } from './runtime.ts';
import { configurationDirectory } from './profiles.ts';
import { inspectConfiguration } from './configuration.ts';
import { assertConfigurationTrust } from './trust.ts';
import { privateDirectory, readPrivate, withProjectLock, writePrivate } from './state.ts';
import { VspodError } from './errors.ts';

interface ExtensionReceipt {
  schemaVersion: 1;
  intentHash: string;
  includeOptional: boolean;
  outcomes: readonly ExtensionOutcome[];
}

const intentHash = (configuration: ResolvedConfiguration) =>
  createHash('sha256').update(JSON.stringify(configuration.extensions)).digest('hex');
const receiptPath = (state: string) => join(state, 'extensions-applied.json');

export async function assertWorkspaceExtensions(runtime: ContainerRuntime, workspace: Workspace, state: string, configuration: ResolvedConfiguration): Promise<void> {
  const receipt = await readPrivate<ExtensionReceipt>(receiptPath(state), 262_144);
  if (!configuration.extensions.length && !receipt) return;
  if (receipt?.schemaVersion !== 1 || receipt.intentHash !== intentHash(configuration) || !Array.isArray(receipt.outcomes)) {
    throw new VspodError('EXTENSIONS_SYNC_REQUIRED', 'Extension choices have not been reconciled.',
      'Run vspod extensions sync to review exact artifacts before opening, or use vspod open --restricted.');
  }
  if (!runtime.extensionAdapter) throw new VspodError('EXTENSIONS_RUNTIME_UNSUPPORTED', 'The runtime cannot verify managed extensions.', 'Use the maintained Docker runtime.');
  const installed = await runtime.extensionAdapter(workspace).list();
  for (const intent of configuration.extensions.filter((item) => item.required || item.selected)) {
    const outcome = receipt.outcomes.find((item) => item.id === intent.id);
    if (!outcome || !['installed', 'unchanged', 'preserved'].includes(outcome.status) ||
        !installed.some((item) => item.id === intent.id && item.version === outcome.version) ||
        (intent.version && outcome.version !== intent.version)) {
      if (!intent.required) continue;
      throw new VspodError('EXTENSION_REQUIRED_UNAVAILABLE', 'A required extension is missing or has changed.',
        `Run vspod extensions sync and review ${intent.id}. Running editors are never silently updated.`);
    }
  }
}

export interface SyncExtensionsOptions {
  refresh?: boolean;
  includeOptional?: boolean;
  approveArtifacts?: (artifacts: readonly ExtensionArtifactApprovalRequest[]) => Promise<readonly ExtensionArtifactApproval[]>;
}

export async function syncWorkspaceExtensions(runtime: ContainerRuntime, workspace: Workspace, options: SyncExtensionsOptions = {}): Promise<readonly ExtensionOutcome[]> {
  return withProjectLock(workspace, async (state) => {
    const configuration = (await inspectConfiguration(workspace)).resolved;
    await assertConfigurationTrust(workspace, configuration);
    await runtime.ensureAvailable();
    const instance = await runtime.inspect(workspace);
    if (instance?.running) throw new VspodError('EXTENSIONS_STOP_REQUIRED', 'Stop the workspace before changing managed extensions.',
      'Finish terminal work, run vspod stop, then retry. No running extensions were changed.');
    if (!runtime.extensionAdapter) throw new VspodError('EXTENSIONS_RUNTIME_UNSUPPORTED', 'The runtime cannot manage extensions.', 'Use the maintained Docker runtime.');
    await runtime.ensureImage();
    if (!instance) await runtime.create(workspace);
    const root = configurationDirectory();
    await privateDirectory(root);
    const cacheDirectory = join(root, 'cache', 'extensions');
    await privateDirectory(join(root, 'cache'));
    await privateDirectory(cacheDirectory);
    const previous = await readPrivate<ExtensionReceipt>(receiptPath(state), 262_144);
    const includeOptional = options.includeOptional ?? previous?.includeOptional ?? false;
    const intents = configuration.extensions.map((item) => ({ ...item, selected: item.selected || includeOptional }));
    const manager = new ExtensionManager({
      cacheDirectory, manifestPath: join(state, 'managed-extensions.json'),
      vscodeVersion: '1.106.3', adapter: runtime.extensionAdapter(workspace),
      approveArtifacts: options.approveArtifacts,
    });
    let outcomes: readonly ExtensionOutcome[];
    try { outcomes = await manager.reconcile(intents, { refresh: options.refresh }); }
    catch (error) {
      if (!(error instanceof RequiredExtensionFailure)) throw error;
      throw new VspodError('EXTENSION_REQUIRED_UNAVAILABLE', 'Required extensions could not be reconciled.',
        `${error.failed.map((item) => `${item.id}: ${item.status}${item.message ? ` (${item.message})` : ''}`).join('; ')}. No successful receipt was recorded; retry sync after reviewing approvals or registry availability.`);
    }
    await writePrivate(receiptPath(state), {
      schemaVersion: 1, intentHash: intentHash(configuration), includeOptional, outcomes,
    } satisfies ExtensionReceipt);
    return outcomes;
  });
}
