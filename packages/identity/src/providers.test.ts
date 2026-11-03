import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceProviderClient } from './providers.ts';

test('GitHub device flow uses fixed provider endpoints and configured client ID', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const replies = [
    { device_code: 'device-value', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 300, interval: 1 },
    { access_token: 'access-value', refresh_token: 'refresh-value', token_type: 'bearer', expires_in: 3600 },
    { id: 123, login: 'sample-user' },
  ];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const body = replies.shift();
    assert.ok(body);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new DeviceProviderClient(fetcher);
  let challengeSeen = false;
  const identity = await client.authorize('github', 'github-client-id-supplied-by-host', undefined, (challenge) => {
    challengeSeen = true;
    assert.equal(challenge.verificationUri, 'https://github.com/login/device');
  });

  assert.equal(challengeSeen, true);
  assert.equal(identity.subject, '123');
  assert.equal(identity.credential.accessToken, 'access-value');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://github.com/login/device/code',
    'https://github.com/login/oauth/access_token',
    'https://api.github.com/user',
  ]);
  assert.match(String(calls[0]?.init?.body), /client_id=github-client-id-supplied-by-host/);
  assert.equal(calls[2]?.init?.headers && new Headers(calls[2].init.headers).get('authorization'), 'Bearer access-value');
});

test('Azure tenant validation prevents arbitrary authority URLs', async () => {
  let called = false;
  const client = new DeviceProviderClient(async () => {
    called = true;
    return new Response('{}', { status: 200 });
  });
  await assert.rejects(client.authorize('azure', 'configured-azure-client', 'tenant.example/other', () => {}));
  assert.equal(called, false);
});

test('Azure device flow uses tenant-scoped authority and fixed Graph profile endpoint', async () => {
  const tenant = '12345678-1234-4234-8234-123456789abc';
  const calls: string[] = [];
  const replies = [
    { device_code: 'device-value', user_code: 'CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 300, interval: 1 },
    { access_token: 'azure-access', refresh_token: 'azure-refresh', token_type: 'Bearer', expires_in: 3600 },
    { id: 'principal-1', displayName: 'Sample User' },
  ];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    const body = replies.shift();
    assert.ok(body);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const identity = await new DeviceProviderClient(fetcher).authorize(
    'azure',
    'configured-azure-public-client',
    tenant,
    () => {},
  );
  assert.equal(identity.tenantId, tenant);
  assert.equal(identity.subject, 'principal-1');
  assert.deepEqual(calls, [
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    'https://graph.microsoft.com/v1.0/me',
  ]);
});
