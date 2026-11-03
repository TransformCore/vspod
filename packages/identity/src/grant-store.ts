import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IdentityError } from './errors.ts';
import type { WorkspaceGrant } from './types.ts';

export interface WorkspaceGrantStore {
  list(): Promise<WorkspaceGrant[]>;
  save(grant: WorkspaceGrant): Promise<void>;
  remove(workspaceId: string): Promise<void>;
}

export class FileWorkspaceGrantStore implements WorkspaceGrantStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    const root = process.env.VSPOD_STATE_DIR ?? process.env.VSPOD_CONFIG_DIR;
    this.filePath = resolve(filePath ?? (root
      ? join(root, 'identity', 'workspace-grants.json')
      : join(homedir(), 'Library', 'Application Support', 'VSPod', 'identity', 'workspace-grants.json')));
  }

  async list(): Promise<WorkspaceGrant[]> {
    const content = await readPrivateFile(this.filePath);
    if (!content) return [];
    try {
      const grants: unknown = JSON.parse(content);
      if (!Array.isArray(grants) || !grants.every(isWorkspaceGrant)) throw new Error();
      return grants;
    } catch {
      throw new IdentityError('SECURE_STORE_UNAVAILABLE');
    }
  }

  async save(grant: WorkspaceGrant): Promise<void> {
    const grants = (await this.list()).filter((existing) => existing.workspaceId !== grant.workspaceId);
    grants.push(grant);
    await writePrivateFile(this.filePath, grants);
  }

  async remove(workspaceId: string): Promise<void> {
    const grants = (await this.list()).filter((existing) => existing.workspaceId !== workspaceId);
    await writePrivateFile(this.filePath, grants);
  }
}

async function readPrivateFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new IdentityError('SECURE_STORE_UNAVAILABLE');
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof IdentityError) throw error;
    throw new IdentityError('SECURE_STORE_UNAVAILABLE');
  }
}

async function writePrivateFile(path: string, value: WorkspaceGrant[]): Promise<void> {
  const directory = resolve(dirname(path));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new IdentityError('SECURE_STORE_UNAVAILABLE');
  }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.pending`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch {
    throw new IdentityError('SECURE_STORE_UNAVAILABLE');
  } finally {
    await rm(temporary, { force: true });
  }
}

function isWorkspaceGrant(value: unknown): value is WorkspaceGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<WorkspaceGrant>;
  return typeof grant.workspaceId === 'string'
    && typeof grant.accountId === 'string'
    && typeof grant.createdAt === 'string'
    && Array.isArray(grant.repositories) && grant.repositories.every((item) => typeof item === 'string')
    && Array.isArray(grant.operations) && grant.operations.every((item) => item === 'read' || item === 'write');
}
