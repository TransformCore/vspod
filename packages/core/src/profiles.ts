import { randomBytes } from 'node:crypto';
import { link, lstat, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { stringify } from 'yaml';
import { loadProfile, validateDocument } from '@vspod/config';
import type { ProfileV1 } from '@vspod/config';
import { privateDirectory, readPrivate, stateDirectory, writePrivate } from './state.ts';
import { VspodError } from './errors.ts';

export const configurationDirectory = () => resolve(process.env.VSPOD_CONFIG_DIR ??
  (process.env.VSPOD_STATE_DIR ? join(stateDirectory(), 'configuration') :
    join(homedir(), 'Library', 'Application Support', 'VSPod')));

interface Selections {
  schemaVersion: 1;
  defaultProfile: string;
  workspaces: Record<string, string>;
}

function assertProfileName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new VspodError('PROFILE_NAME_INVALID', 'Invalid profile name.', 'Use 1-64 lowercase letters, digits or hyphens, beginning with a letter or digit.');
  }
}

async function prepare(root: string): Promise<string> {
  await privateDirectory(root);
  const profiles = join(root, 'profiles');
  await privateDirectory(profiles);
  return profiles;
}

async function readSelections(root: string): Promise<Selections> {
  const value = await readPrivate<unknown>(join(root, 'profile-selections.json'), 256 * 1024).catch(() => {
    throw new VspodError('PROFILE_STATE_INVALID', 'Profile selection metadata could not be read safely.', 'Check ownership, private permissions and JSON syntax of profile-selections.json. It was not overwritten.');
  });
  if (value === undefined) return { schemaVersion: 1, defaultProfile: 'default', workspaces: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('schemaVersion' in value) || value.schemaVersion !== 1 ||
      !('defaultProfile' in value) || typeof value.defaultProfile !== 'string' ||
      !('workspaces' in value) || !value.workspaces || typeof value.workspaces !== 'object' || Array.isArray(value.workspaces) ||
      Object.keys(value).some((key) => !['schemaVersion', 'defaultProfile', 'workspaces'].includes(key))) {
    throw new VspodError('PROFILE_STATE_INVALID', 'Profile selection metadata is invalid.', 'Restore profile-selections.json from a trusted backup. It was not overwritten.');
  }
  assertProfileName(value.defaultProfile);
  if (Object.keys(value.workspaces).length > 1000) {
    throw new VspodError('PROFILE_STATE_LIMIT', 'Too many repository profile selections.', 'Keep at most 1000 repository selections in profile-selections.json.');
  }
  const workspaces: Record<string, string> = {};
  for (const [id, name] of Object.entries(value.workspaces)) {
    if (!/^[a-f0-9]{20}$/.test(id) || typeof name !== 'string') {
      throw new VspodError('PROFILE_STATE_INVALID', 'Profile workspace selection metadata is invalid.', 'Restore profile-selections.json from a trusted backup. It was not overwritten.');
    }
    assertProfileName(name);
    workspaces[id] = name;
  }
  return { schemaVersion: 1, defaultProfile: value.defaultProfile, workspaces };
}

async function withProfileLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await prepare(root);
  let compromised: Error | undefined;
  const release = await lockfile.lock(root, {
    lockfilePath: join(root, 'profiles.lock'), realpath: false, stale: 30_000, update: 10_000,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 100 },
    onCompromised: (error) => { compromised = error; },
  });
  try {
    const result = await action();
    if (compromised) throw compromised;
    return result;
  } finally {
    try { await release(); } catch (error) { if (!compromised) throw error; }
  }
}

export async function readProfile(name: string, root = configurationDirectory()): Promise<ProfileV1> {
  assertProfileName(name);
  const profiles = await prepare(root);
  const directory = join(profiles, name);
  const path = join(directory, 'profile.yml');
  let directoryExists = false;
  try {
    const info = await lstat(directory);
    directoryExists = true;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      throw new VspodError('PROFILE_PATH_UNSAFE', 'Profile directory is not private and owned by you.', 'Use a real owner-only directory inside the VSPod profiles directory.');
    }
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077)) {
      throw new VspodError('PROFILE_PATH_UNSAFE', 'Profile is not a private regular file owned by you.', 'Use an owner-only profile.yml file, not a symlink.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (name === 'default' && !directoryExists) return { schemaVersion: 1, name: 'default' };
    throw new VspodError('PROFILE_NOT_FOUND', `Profile "${name}" does not exist.`, `Run vspod profile create ${name}.`);
  }
  const profile = await loadProfile(path, profiles);
  if (!profile) throw new VspodError('PROFILE_NOT_FOUND', `Profile "${name}" disappeared.`, 'Retry after other profile changes finish.');
  return profile;
}

export async function createProfile(name: string, from?: string, root = configurationDirectory()): Promise<void> {
  assertProfileName(name);
  await withProfileLock(root, async () => {
    const profile = from ? { ...await readProfile(from, root), name } : { schemaVersion: 1 as const, name };
    validateDocument(profile, 'profile', `profile:${name}`);
    const directory = join(root, 'profiles', name);
    await privateDirectory(directory);
    const temporary = join(directory, `${randomBytes(8).toString('hex')}.pending`);
    try {
      await writeFile(temporary, stringify(profile), { mode: 0o600, flag: 'wx' });
      await link(temporary, join(directory, 'profile.yml'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VspodError('PROFILE_EXISTS', `Profile "${name}" already exists.`, 'Choose another name. The existing profile was not changed.');
      }
      throw error;
    } finally { await rm(temporary, { force: true }); }
  });
}

export async function selectedProfile(workspaceId?: string, root = configurationDirectory()): Promise<{
  name: string; scope: 'workspace' | 'global'; profile: ProfileV1;
}> {
  await prepare(root);
  const selections = await readSelections(root);
  const local = workspaceId ? selections.workspaces[workspaceId] : undefined;
  const name = local ?? selections.defaultProfile;
  return { name, scope: local ? 'workspace' : 'global', profile: await readProfile(name, root) };
}

export async function switchProfile(name: string, workspaceId?: string, root = configurationDirectory()): Promise<void> {
  assertProfileName(name);
  if (workspaceId && !/^[a-f0-9]{20}$/.test(workspaceId)) {
    throw new VspodError('PROFILE_STATE_INVALID', 'Invalid canonical workspace identity.', 'Select a Git repository through VSPod.');
  }
  await withProfileLock(root, async () => {
    await readProfile(name, root);
    const selections = await readSelections(root);
    if (workspaceId) selections.workspaces[workspaceId] = name;
    else selections.defaultProfile = name;
    if (Object.keys(selections.workspaces).length > 1000) {
      throw new VspodError('PROFILE_STATE_LIMIT', 'Too many repository profile selections.', 'Keep at most 1000 repository selections in profile-selections.json.');
    }
    await writePrivate(join(root, 'profile-selections.json'), selections);
  });
}

export async function listProfiles(root = configurationDirectory()): Promise<readonly string[]> {
  const directory = await prepare(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const names = new Set(['default']);
  for (const entry of entries) {
    assertProfileName(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new VspodError('PROFILE_PATH_UNSAFE', 'Unexpected entry in the profiles directory.', 'Keep only named, private profile directories in this location.');
    }
    await readProfile(entry.name, root);
    names.add(entry.name);
  }
  return [...names].sort();
}
