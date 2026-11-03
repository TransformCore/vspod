import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityError } from './errors.ts';
import { IdentityService } from './service.ts';
import type { AccountMetadataStore } from './metadata-store.ts';
import type { SecureStore } from './secure-store.ts';
import type { AccountMetadata, StoredCredential } from './types.ts';

class MockSecureStore implements SecureStore {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

class MockMetadataStore implements AccountMetadataStore {
  readonly accounts: AccountMetadata[] = [];
  async list() { return [...this.accounts]; }
  async save(account: AccountMetadata) { this.accounts.push(account); }
  async remove(id: string) { const index = this.accounts.findIndex((account) => account.id === id); if (index >= 0) this.accounts.splice(index, 1); }
}

test('GitHub login persists secret separately from account metadata and list/logout work', async () => {
  const secure = new MockSecureStore();
  const metadata = new MockMetadataStore();
  const service = new IdentityService({
    secureStore: secure,
    metadataStore: metadata,
    providerClient: fakeClient({
      'https://github.com/login/device/code': { device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 300, interval: 1 },
      'https://github.com/login/oauth/access_token': { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'bearer', expires_in: 3600 },
      'https://api.github.com/user': { id: 44, login: 'test-user' },
    }),
  });

  const loggedIn = await service.login('github', { clientId: 'configured-github-public-client', onDeviceChallenge() {} });
  assert.equal(loggedIn.metadata.subject, '44');
  assert.equal(loggedIn.metadata.displayName, 'test-user');
  assert.deepEqual(Object.keys(loggedIn.metadata).sort(), ['createdAt', 'displayName', 'id', 'provider', 'subject']);
  const savedSecret = [...secure.values.values()][0];
  assert.match(savedSecret, /access-secret/);
  assert.equal(JSON.stringify(await service.list()).includes('access-secret'), false);

  await service.logout(loggedIn.metadata.id);
  assert.equal((await service.list()).length, 0);
  assert.equal(secure.values.size, 0);
});

test('explicit client ID required and errors do not expose provider details', async () => {
  const service = new IdentityService({ secureStore: new MockSecureStore(), metadataStore: new MockMetadataStore() });
  await assert.rejects(
    service.login('github', { clientId: '', onDeviceChallenge() {} }),
    (error: unknown) => error instanceof IdentityError && error.code === 'INVALID_CONFIGURATION' && !error.message.includes('secret'),
  );
});

test('refresh is single-flight, rotates stored refresh tokens, and returns access token', async () => {
  const secure = new MockSecureStore();
  const metadata = new MockMetadataStore();
  const account: AccountMetadata = { id: 'id-1', provider: 'azure', subject: 'subject', tenantId: 'organizations', createdAt: new Date().toISOString() };
  metadata.accounts.push(account);
  secure.values.set('account:id-1', JSON.stringify({
    accessToken: 'expired-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 10_000, tokenType: 'Bearer',
  } satisfies StoredCredential));
  let requests = 0;
  const client = fakeClient({
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/token': () => {
      requests += 1;
      return { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' };
    },
  });
  const service = new IdentityService({ secureStore: secure, metadataStore: metadata, providerClient: client });
  const tokens = await Promise.all([
    service.getAccessToken('id-1', 'explicit-azure-client'),
    service.getAccessToken('id-1', 'explicit-azure-client'),
  ]);
  assert.deepEqual(tokens, ['new-access', 'new-access']);
  assert.equal(requests, 1);
  assert.match(secure.values.get('account:id-1') ?? '', /new-refresh/);
});

test('Azure tenant is validated before constructing provider URLs', async () => {
  const { validateTenantId } = await import('./providers.ts');
  assert.equal(validateTenantId('organizations'), 'organizations');
  assert.throws(() => validateTenantId('evil.example/tenant'), (error: unknown) => error instanceof IdentityError);
});

test('runtime lease acquisition fails closed', async () => {
  const metadata = new MockMetadataStore();
  metadata.accounts.push({ id: 'id-1', provider: 'github', subject: '1', createdAt: new Date().toISOString() });
  const service = new IdentityService({ secureStore: new MockSecureStore(), metadataStore: metadata });
  const grant = await service.createGrant('id-1', ['repository.read'], 'repo:owner/name', Date.now() + 60_000);
  await assert.rejects(
    service.runtimeAuthorization().acquireLease(grant),
    (error: unknown) => error instanceof IdentityError && error.code === 'UNSUPPORTED_RUNTIME_AUTHORIZATION',
  );
});

function fakeClient(responses: Record<string, Record<string, unknown> | (() => Record<string, unknown>)>) {
  let polls = 0;
  return {
    authorize: async (provider: string, clientId: string, tenantId: string | undefined, onChallenge: (challenge: { userCode: string; verificationUri: string; expiresAt: number }) => void) => {
      const base = provider === 'github' ? 'https://github.com' : `https://login.microsoftonline.com/${tenantId}`;
      const deviceEndpoint = provider === 'github' ? `${base}/login/device/code` : `${base}/oauth2/v2.0/devicecode`;
      const tokenEndpoint = provider === 'github' ? `${base}/login/oauth/access_token` : `${base}/oauth2/v2.0/token`;
      const device = responses[deviceEndpoint];
      assert.ok(device);
      const deviceData = typeof device === 'function' ? device() : device;
      onChallenge({ userCode: 'CODE', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 10_000 });
      const tokenResponse = responses[tokenEndpoint];
      assert.ok(tokenResponse);
      const credential = typeof tokenResponse === 'function' ? tokenResponse() : tokenResponse;
      const profileEndpoint = provider === 'github' ? 'https://api.github.com/user' : 'https://graph.microsoft.com/v1.0/me';
      const profile = responses[profileEndpoint];
      assert.ok(profile);
      const user = typeof profile === 'function' ? profile() : profile;
      assert.ok(clientId);
      polls += 1;
      void deviceData;
      return {
        subject: String(user.id),
        displayName: String(user.login ?? user.displayName),
        ...(tenantId ? { tenantId } : {}),
        credential: {
          accessToken: String(credential.access_token),
          ...(credential.refresh_token ? { refreshToken: String(credential.refresh_token) } : {}),
          ...(credential.expires_in ? { expiresAt: Date.now() + Number(credential.expires_in) * 1000 } : {}),
          tokenType: String(credential.token_type ?? 'Bearer'),
          scope: typeof credential.scope === 'string' ? credential.scope : undefined,
        },
      };
    },
    refresh: async (_provider: string, clientId: string) => {
      assert.ok(clientId);
      const response = responses['https://login.microsoftonline.com/organizations/oauth2/v2.0/token'];
      assert.ok(response);
      const value = typeof response === 'function' ? response() : response;
      return {
        accessToken: String(value.access_token),
        refreshToken: String(value.refresh_token),
        expiresAt: Date.now() + Number(value.expires_in) * 1000,
        tokenType: String(value.token_type),
      };
    },
    get polls() { return polls; },
  } as never;
}
