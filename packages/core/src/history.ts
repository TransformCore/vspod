import { randomBytes } from 'node:crypto';
import { join, isAbsolute, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, readPrivate, stateDirectory, withProjectLock, writePrivate } from './state.ts';
import type { Workspace } from '@vspod/workspace';
import { requestNativeAttachment } from './native-attachment.ts';
import { waitForWindowShutdown } from './window-lifecycle.ts';

export interface RecentFolder {
  id: string;
  root: string;
  folder: string;
  name: string;
  lastOpened: string;
  windows: string[];
  restoreCount: number;
  runtimeSession?: string;
  backend?: string;
}

interface Catalog { version: 1; onboardingComplete: boolean; recent: RecentFolder[] }
const emptyCatalog = (): Catalog => ({ version: 1, onboardingComplete: false, recent: [] });

export async function readCatalog(): Promise<Catalog> {
  await privateDirectory(stateDirectory());
  const value = await readPrivate<Catalog>(join(stateDirectory(), 'catalog', 'history.json'), 131_072);
  if (!value) return emptyCatalog();
  if (value.version !== 1 || !Array.isArray(value.recent) || value.recent.length > 30 || value.recent.some((entry) =>
    !/^[a-f0-9]{20}$/.test(entry.id) || !isAbsolute(entry.root) || !isAbsolute(entry.folder)
    || !Array.isArray(entry.windows) || entry.windows.some((name) => !/^launch-[a-zA-Z0-9]+$/.test(name))
    || (entry.backend !== undefined && !['code-server', 'desktop'].includes(entry.backend))
    || !Number.isInteger(entry.restoreCount) || entry.restoreCount < 0 || entry.restoreCount > 8)) {
    throw new Error('Recent-folder history has an unsupported format. Your repository and container data were not changed.');
  }
  return value;
}

async function updateCatalog(change: (catalog: Catalog) => void | Promise<void>): Promise<void> {
  const root = stateDirectory();
  await withProjectLock({ id: 'catalog', name: 'catalog', root, containerName: '' }, async (directory) => {
    const catalog = await readCatalog();
    await change(catalog);
    await writePrivate(join(directory, 'history.json'), catalog);
  }, 5_000);
}

export async function completeOnboarding(): Promise<void> {
  await updateCatalog((catalog) => { catalog.onboardingComplete = true; });
}

export async function rememberFolder(workspace: Workspace, folder: string, launchDirectory: string, runtimeSession = '', backend = 'code-server'): Promise<void> {
  await updateCatalog(async (catalog) => {
    for (const entry of catalog.recent) {
      let active = 0;
      for (const window of entry.windows) {
        const ack = await readPrivate<{ stage: string }>(join(stateDirectory(), entry.id, window, 'ack.json'));
        if (ack && ack.stage !== 'closed' && ack.stage !== 'error') active++;
      }
      entry.restoreCount = Math.min(active, 8);
    }
    const previous = catalog.recent.find((entry) => entry.id === workspace.id && entry.folder === folder && (entry.backend ?? 'code-server') === backend);
    const windows = [...new Set([...(previous?.runtimeSession === runtimeSession ? previous.windows : []), basename(launchDirectory)])].slice(-8);
    catalog.recent = [{ id: workspace.id, root: workspace.root, folder, name: workspace.name,
      lastOpened: new Date().toISOString(), windows, runtimeSession, backend, restoreCount: Math.max(previous?.restoreCount ?? 0, 1) },
    ...catalog.recent.filter((entry) => entry.id !== workspace.id || entry.folder !== folder || (entry.backend ?? 'code-server') !== backend)].slice(0, 30);
  });
}

export async function closeWindows(filter?: { id: string; backend: string }, waitForStop = true): Promise<number> {
  const entries = (await recentFolders()).filter((entry) => !filter ||
    (entry.id === filter.id && (entry.backend ?? 'code-server') === filter.backend));
  let hasWindows = false;
  for (const entry of entries) {
    for (const window of entry.windows) {
      const ack = await readPrivate<{ stage: string }>(join(stateDirectory(), entry.id, window, 'ack.json'));
      if (ack && ack.stage !== 'closed' && ack.stage !== 'error') hasWindows = true;
    }
  }
  if (!hasWindows) return 0;
  await refreshWindowHistory();
  let closed = 0;
  const visited = new Set<string>();
  const shutdownDirectories = new Set<string>();
  for (const entry of entries) {
    if (entry.backend === 'desktop') {
      const root = join(stateDirectory(), entry.id);
      if (!visited.has(root)) {
        visited.add(root);
        const closedDirectory = await requestNativeAttachment(root, 'close');
        if (closedDirectory) {
          closed++;
          shutdownDirectories.add(closedDirectory);
        }
      }
      continue;
    }
    for (const window of entry.windows) {
      const directory = join(stateDirectory(), entry.id, window);
      if (visited.has(directory)) continue;
      visited.add(directory);
      const ack = await readPrivate<{ stage: string }>(join(directory, 'ack.json'));
      if (!ack || ack.stage === 'closed' || ack.stage === 'error') continue;
      const id = randomBytes(12).toString('hex');
      await writePrivate(join(directory, 'request.json'), { id, action: 'close' });
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const response = await readPrivate<{ id: string }>(join(directory, 'response.json'));
        if (response?.id === id) { closed++; shutdownDirectories.add(directory); break; }
        await delay(50);
      }
    }
  }
  if (waitForStop) {
    for (const directory of shutdownDirectories) await waitForWindowShutdown(directory);
  }
  return closed;
}

export async function recentFolders(): Promise<RecentFolder[]> {
  return (await readCatalog()).recent;
}

export async function restorableFolders(): Promise<RecentFolder[]> {
  const recent = await recentFolders();
  return recent.filter((entry) => entry.restoreCount > 0);
}

export async function refreshWindowHistory(): Promise<void> {
  const snapshot = await recentFolders();
  const counts = new Map<string, number>();
  for (const entry of snapshot) {
    let remaining = 0;
    for (const window of entry.windows) {
      const ack = await readPrivate<{ stage: string }>(join(stateDirectory(), entry.id, window, 'ack.json'));
      if (ack && ack.stage !== 'closed' && ack.stage !== 'error') remaining++;
    }
    counts.set(`${entry.id}:${entry.folder}:${entry.backend ?? 'code-server'}`, remaining);
  }
  await updateCatalog((catalog) => {
    for (const entry of catalog.recent) {
      const count = counts.get(`${entry.id}:${entry.folder}:${entry.backend ?? 'code-server'}`);
      if (count !== undefined) entry.restoreCount = Math.min(count, 8);
    }
  });
}

export async function focusFolder(workspace: Workspace, folder: string, runtimeSession: string): Promise<boolean> {
  const entry = (await recentFolders()).find((item) => item.id === workspace.id && item.folder === folder && item.runtimeSession === runtimeSession);
  for (const window of [...(entry?.windows ?? [])].reverse()) {
    const directory = join(stateDirectory(), workspace.id, window);
    const ack = await readPrivate<{ stage: string }>(join(directory, 'ack.json'));
    if (!ack || ack.stage === 'closed' || ack.stage === 'error') continue;
    const id = randomBytes(12).toString('hex');
    await writePrivate(join(directory, 'request.json'), { id, action: 'focus' });
    const deadline = Date.now() + 700;
    while (Date.now() < deadline) {
      const response = await readPrivate<{ id: string }>(join(directory, 'response.json'));
      if (response?.id === id) return true;
      await delay(50);
    }
  }
  return false;
}