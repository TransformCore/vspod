import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IdentityError } from './errors.ts';
import type { AccountMetadata } from './types.ts';

export interface AccountMetadataStore {
  list(): Promise<AccountMetadata[]>;
  save(account: AccountMetadata): Promise<void>;
  remove(id: string): Promise<void>;
}

export class FileAccountMetadataStore implements AccountMetadataStore {
  constructor(filePath?: string) {
    const root = process.env.VSPOD_STATE_DIR ?? process.env.VSPOD_CONFIG_DIR;
    this.filePath = resolve(filePath ?? (root
      ? join(root, 'identity', 'accounts.json')
      : join(homedir(), 'Library', 'Application Support', 'VSPod', 'identity', 'accounts.json')));
  }

  private readonly filePath: string;

  async list(): Promise<AccountMetadata[]> {
    const content = await readPrivateFile(this.filePath);
    if (!content) return [];
    try {
      const accounts = JSON.parse(content) as unknown;
      if (!Array.isArray(accounts) || !accounts.every(isAccountMetadata)) throw new Error();
      return accounts;
    } catch {
      throw new IdentityError('PROVIDER_FAILURE');
    }
  }

  async save(account: AccountMetadata): Promise<void> {
    const accounts = (await this.list()).filter((existing) => existing.id !== account.id);
    accounts.push(account);
    await writePrivateFile(this.filePath, accounts);
  }

  async remove(id: string): Promise<void> {
    const accounts = (await this.list()).filter((existing) => existing.id !== id);
    await writePrivateFile(this.filePath, accounts);
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

async function writePrivateFile(path: string, value: AccountMetadata[]): Promise<void> {
  const directory = resolve(dirname(path));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0 || directoryInfo.uid !== process.getuid?.()) {
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

function isAccountMetadata(value: unknown): value is AccountMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AccountMetadata>;
  return typeof candidate.id === 'string'
    && (candidate.provider === 'github' || candidate.provider === 'azure')
    && typeof candidate.subject === 'string'
    && typeof candidate.createdAt === 'string'
    && (candidate.displayName === undefined || typeof candidate.displayName === 'string')
    && (candidate.tenantId === undefined || typeof candidate.tenantId === 'string');
}
