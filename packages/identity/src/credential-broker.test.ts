import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CredentialBroker, normalizeGitHubRepository } from './credential-broker.ts';
import { IdentityError } from './errors.ts';
import type { AccountMetadataStore } from './metadata-store.ts';
import type { SecureStore } from './secure-store.ts';
import { IdentityService } from './service.ts';
import type { AccountMetadata, GitOperationLease, RuntimeBinding, WorkspaceGrant } from './types.ts';
import type { WorkspaceGrantStore } from './grant-store.ts';

class TestSecureStore implements SecureStore {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

class TestMetadataStore implements AccountMetadataStore {
  accounts: AccountMetadata[] = [];
  async list() { return [...this.accounts]; }
  async save(account: AccountMetadata) { this.accounts.push(account); }
  async remove(id: string) { this.accounts = this.accounts.filter((account) => account.id !== id); }
}

class TestGrantStore implements WorkspaceGrantStore {
  grants: WorkspaceGrant[] = [];
  async list() { return structuredClone(this.grants); }
  async save(grant: WorkspaceGrant) { this.grants = [...this.grants.filter((item) => item.workspaceId !== grant.workspaceId), structuredClone(grant)]; }
  async remove(workspaceId: string) { this.grants = this.grants.filter((grant) => grant.workspaceId !== workspaceId); }
}

async function loggedInIdentity() {
  const secure = new TestSecureStore();
  const metadata = new TestMetadataStore();
  const identity = new IdentityService({
    secureStore: secure,
    metadataStore: metadata,
    providerClient: {
      authorize: async () => ({
        subject: 'github-subject',
        credential: { accessToken: 'secret-token', refreshToken: 'refresh-token', expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer' },
      }),
      refresh: async () => ({
        accessToken: 'rotated-token',
        refreshToken: 'rotated-refresh',
        expiresAt: Date.now() + 3_600_000,
        tokenType: 'Bearer',
      }),
    } as never,
  });
  const account = await identity.login('github', { clientId: 'configured-github-id', onDeviceChallenge() {} });
  return { identity, account };
}

test('workspace Git grants persist normalized exact repositories and reject arbitrary URLs', async () => {
  const { identity, account } = await loggedInIdentity();
  const grantStore = new TestGrantStore();
  const broker = new CredentialBroker({ identity, grantStore });
  const grant = await broker.grantWorkspace(
    'workspace-1',
    account.metadata.id,
    ['https://github.com/acme/widget.git'],
    ['read'],
  );
  assert.deepEqual(grant.repositories, ['acme/widget']);
  assert.deepEqual((await broker.listWorkspaceGrants()).map((item) => item.workspaceId), ['workspace-1']);
  assert.throws(() => normalizeGitHubRepository('https://github.com/acme/widget/../../other'), IdentityError);
  assert.throws(() => normalizeGitHubRepository('https://github.com.evil/acme/widget'), IdentityError);
  assert.throws(() => normalizeGitHubRepository('https://github.com/acme/widget?redirect=evil'), IdentityError);
});

test('Git operation lease is runtime-bound, short-lived, and single-use', async () => {
  const { identity, account } = await loggedInIdentity();
  const grantStore = new TestGrantStore();
  const calls: Array<{ lease: GitOperationLease; accessToken: string }> = [];
  const broker = new CredentialBroker({
    identity,
    grantStore,
    leaseTtlMs: 5_000,
    transport: {
      performGitOperation: async (request) => {
        calls.push(request);
        return { success: true };
      },
    },
  });
  await broker.grantWorkspace('workspace-1', account.metadata.id, ['https://github.com/acme/widget'], ['read']);
  const binding: RuntimeBinding = { containerId: 'container-42', startedAt: new Date().toISOString() };
  const lease = await broker.acquireGitLease('workspace-1', binding, 'https://github.com/acme/widget.git', 'read');
  assert.ok(lease.expiresAt - lease.issuedAt <= 5_000);
  await assert.rejects(
    broker.executeGitOperation(lease, { ...binding, containerId: 'another-container' }),
    (error: unknown) => error instanceof IdentityError && error.code === 'AUTHORIZATION_DENIED',
  );
  await assert.rejects(broker.executeGitOperation(lease, binding), IdentityError);

  const validLease = await broker.acquireGitLease('workspace-1', binding, 'https://github.com/acme/widget', 'read');
  assert.deepEqual(await broker.executeGitOperation(validLease, binding), { success: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.lease.binding.containerId, binding.containerId);
  assert.equal(calls[0]?.accessToken, 'secret-token');
  await assert.rejects(
    broker.executeGitOperation(validLease, binding),
    (error: unknown) => error instanceof IdentityError && error.code === 'AUTHORIZATION_DENIED',
  );
});

test('logout reports upstream revocation unsupported and removes local credential access', async () => {
  const { identity, account } = await loggedInIdentity();
  const result = await identity.logout(account.metadata.id);
  assert.deepEqual(result, { localCredentialsRemoved: true, upstreamRevocation: 'unsupported' });
  await assert.rejects(
    identity.getAccessToken(account.metadata.id),
    (error: unknown) => error instanceof IdentityError && error.code === 'ACCOUNT_NOT_FOUND',
  );
});
