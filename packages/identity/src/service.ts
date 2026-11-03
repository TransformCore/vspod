import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { IdentityError } from './errors.ts';
import { FileAccountMetadataStore } from './metadata-store.ts';
import { DeviceProviderClient } from './providers.ts';
import type { AccountMetadataStore } from './metadata-store.ts';
import type { SecureStore } from './secure-store.ts';
import type { AccountMetadata, Capability, IdentityAccount, IdentityProvider, LoginOptions, RuntimeAuthorization } from './types.ts';
import type { StoredCredential } from './types.ts';

const SECRET_PREFIX = 'account:';
const RUNTIME_CAPABILITIES = new Set<Capability>(['repository.read', 'repository.write', 'cloud.deploy']);

export interface IdentityServiceOptions {
  secureStore: SecureStore;
  metadataStore?: AccountMetadataStore;
  rootDirectory?: string;
  metadataPath?: string;
  providerClient?: DeviceProviderClient;
}

interface CredentialRecord {
  credential: StoredCredential;
  clientId: string;
}

export class IdentityService {
  private readonly metadata: AccountMetadataStore;
  private readonly providers: DeviceProviderClient;
  private readonly refreshes = new Map<string, Promise<StoredCredential>>();

  constructor(private readonly options: IdentityServiceOptions) {
    this.metadata = options.metadataStore ?? new FileAccountMetadataStore(
      options.metadataPath ?? (options.rootDirectory ? join(resolve(options.rootDirectory), 'identity', 'accounts.json') : undefined),
    );
    this.providers = options.providerClient ?? new DeviceProviderClient();
  }

  async login(provider: IdentityProvider, options: LoginOptions): Promise<IdentityAccount> {
    const authorized = await this.providers.authorize(provider, options.clientId, options.tenantId, options.onDeviceChallenge, options.signal);
    const metadata: AccountMetadata = {
      id: randomUUID(),
      provider,
      subject: authorized.subject,
      ...(authorized.displayName ? { displayName: authorized.displayName } : {}),
      ...(authorized.tenantId ? { tenantId: authorized.tenantId } : {}),
      createdAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify({ credential: authorized.credential, clientId: options.clientId } satisfies CredentialRecord);
    await this.options.secureStore.set(secretKey(metadata.id), serialized);
    try {
      await this.metadata.save(metadata);
    } catch (error) {
      await this.options.secureStore.delete(secretKey(metadata.id)).catch(() => undefined);
      throw error;
    }
    return { metadata };
  }

  async list(): Promise<IdentityAccount[]> {
    return (await this.metadata.list()).map((metadata) => ({ metadata }));
  }

  async logout(accountId: string): Promise<{ localCredentialsRemoved: true; upstreamRevocation: 'unsupported' }> {
    const account = await this.find(accountId);
    await this.options.secureStore.delete(secretKey(account.id));
    await this.metadata.remove(account.id);
    return { localCredentialsRemoved: true, upstreamRevocation: 'unsupported' };
  }

  async getAccessToken(accountId: string, clientId?: string): Promise<string> {
    const account = await this.find(accountId);
    const record = await this.readCredentialRecord(account.id);
    const stored = record.credential;
    if (!stored.expiresAt || stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
    if (!stored.refreshToken) throw new IdentityError('AUTHORIZATION_DENIED');
    const effectiveClientId = clientId ?? record.clientId;
    if (!effectiveClientId) throw new IdentityError('INVALID_CONFIGURATION');
    const existing = this.refreshes.get(account.id);
    if (existing) return (await existing).accessToken;
    const pending = this.providers.refresh(account.provider, effectiveClientId, account.tenantId, stored)
      .then(async (rotated) => {
        await this.options.secureStore.set(secretKey(account.id), JSON.stringify({ credential: rotated, clientId: effectiveClientId } satisfies CredentialRecord));
        return rotated;
      })
      .finally(() => this.refreshes.delete(account.id));
    this.refreshes.set(account.id, pending);
    return (await pending).accessToken;
  }

  async createGrant(accountId: string, capabilities: readonly Capability[], resource: string, expiresAt: number) {
    await this.find(accountId);
    if (!capabilities.length || capabilities.some((capability) => !RUNTIME_CAPABILITIES.has(capability))
      || !resource || resource.length > 512 || expiresAt <= Date.now()) {
      throw new IdentityError('INVALID_CONFIGURATION');
    }
    return { accountId, capabilities: [...new Set(capabilities)], resource, expiresAt };
  }

  runtimeAuthorization(): RuntimeAuthorization {
    return {
      acquireLease: async () => { throw new IdentityError('UNSUPPORTED_RUNTIME_AUTHORIZATION'); },
      releaseLease: async () => { throw new IdentityError('UNSUPPORTED_RUNTIME_AUTHORIZATION'); },
    };
  }

  private async find(accountId: string): Promise<AccountMetadata> {
    const account = (await this.metadata.list()).find((candidate) => candidate.id === accountId);
    if (!account) throw new IdentityError('ACCOUNT_NOT_FOUND');
    return account;
  }

  private async readCredentialRecord(accountId: string): Promise<CredentialRecord> {
    const value = await this.options.secureStore.get(secretKey(accountId));
    if (!value) throw new IdentityError('ACCOUNT_NOT_FOUND');
    try {
      const parsed = JSON.parse(value) as CredentialRecord | StoredCredential;
      if ('credential' in parsed) {
        if (typeof parsed.clientId !== 'string' || typeof parsed.credential.accessToken !== 'string' || typeof parsed.credential.tokenType !== 'string') throw new Error();
        return parsed;
      }
      if (typeof parsed.accessToken !== 'string' || typeof parsed.tokenType !== 'string') throw new Error();
      return { credential: parsed, clientId: '' };
    } catch {
      throw new IdentityError('SECURE_STORE_UNAVAILABLE');
    }
  }
}

function secretKey(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}
