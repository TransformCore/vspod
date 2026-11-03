import { IdentityError } from './errors.ts';
import type { DeviceChallenge, IdentityProvider, StoredCredential } from './types.ts';

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

const GITHUB_DEVICE_ENDPOINT = 'https://github.com/login/device/code';
const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_ENDPOINT = 'https://api.github.com/user';
const AZURE_GRAPH_USER_ENDPOINT = 'https://graph.microsoft.com/v1.0/me';
const AZURE_SCOPES = 'openid profile offline_access User.Read';
const AZURE_TENANT_NAMES = new Set(['common', 'organizations', 'consumers']);
const DEVICE_POLL_LIMIT_MS = 15 * 60_000;

export interface ProviderIdentity {
  subject: string;
  displayName?: string;
  tenantId?: string;
  credential: StoredCredential;
}

export class DeviceProviderClient {
  constructor(private readonly request: FetchLike = fetch) {}

  async authorize(
    provider: IdentityProvider,
    clientId: string,
    tenantId: string | undefined,
    onChallenge: (challenge: DeviceChallenge) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<ProviderIdentity> {
    if (provider !== 'github' && provider !== 'azure') throw new IdentityError('INVALID_CONFIGURATION');
    requireClientId(clientId);
    if (provider === 'github') return this.authorizeGitHub(clientId, onChallenge, signal);
    const tenant = validateTenantId(tenantId);
    return this.authorizeAzure(clientId, tenant, onChallenge, signal);
  }

  async refresh(
    provider: IdentityProvider,
    clientId: string,
    tenantId: string | undefined,
    prior: StoredCredential,
  ): Promise<StoredCredential> {
    if (provider !== 'github' && provider !== 'azure') throw new IdentityError('INVALID_CONFIGURATION');
    requireClientId(clientId);
    if (!prior.refreshToken) throw new IdentityError('AUTHORIZATION_DENIED');
    const endpoint = provider === 'github'
      ? GITHUB_TOKEN_ENDPOINT
      : `${azureAuthority(validateTenantId(tenantId))}/oauth2/v2.0/token`;
    const parameters = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: prior.refreshToken,
    });
    if (provider === 'azure') parameters.set('scope', AZURE_SCOPES);
    const response = await this.postForm(endpoint, parameters);
    return parseCredential(response, prior);
  }

  private async authorizeGitHub(clientId: string, onChallenge: (challenge: DeviceChallenge) => Promise<void> | void, signal?: AbortSignal): Promise<ProviderIdentity> {
    const device = await this.postForm(GITHUB_DEVICE_ENDPOINT, new URLSearchParams({ client_id: clientId, scope: 'read:user' }));
    const deviceCode = requiredString(device.device_code);
    const expiresAt = Date.now() + boundedSeconds(device.expires_in) * 1000;
    const challenge = {
      userCode: requiredString(device.user_code),
      verificationUri: validatedVerificationUri(device.verification_uri, 'https://github.com/login/device'),
      expiresAt,
    };
    await onChallenge(challenge);
    const credential = await this.pollForToken(GITHUB_TOKEN_ENDPOINT, clientId, deviceCode, expiresAt, boundedSeconds(device.interval, 5), signal, false);
    const user = await this.getJson(GITHUB_USER_ENDPOINT, credential.accessToken);
    const subject = requiredString(user.id);
    return { subject, displayName: optionalString(user.login), credential };
  }

  private async authorizeAzure(clientId: string, tenantId: string, onChallenge: (challenge: DeviceChallenge) => Promise<void> | void, signal?: AbortSignal): Promise<ProviderIdentity> {
    const authority = azureAuthority(tenantId);
    const device = await this.postForm(`${authority}/oauth2/v2.0/devicecode`, new URLSearchParams({ client_id: clientId, scope: AZURE_SCOPES }));
    const deviceCode = requiredString(device.device_code);
    const expiresAt = Date.now() + boundedSeconds(device.expires_in) * 1000;
    const challenge = {
      userCode: requiredString(device.user_code),
      verificationUri: validatedVerificationUri(device.verification_uri, 'https://microsoft.com/devicelogin'),
      message: optionalString(device.message),
      expiresAt,
    };
    await onChallenge(challenge);
    const credential = await this.pollForToken(`${authority}/oauth2/v2.0/token`, clientId, deviceCode, expiresAt, boundedSeconds(device.interval, 5), signal, true);
    const user = await this.getJson(AZURE_GRAPH_USER_ENDPOINT, credential.accessToken);
    const subject = requiredString(user.id);
    return { subject, displayName: optionalString(user.displayName), tenantId, credential };
  }

  private async pollForToken(endpoint: string, clientId: string, deviceCode: string, expiresAt: number, interval: number, signal: AbortSignal | undefined, azure: boolean): Promise<StoredCredential> {
    const deadline = Math.min(expiresAt, Date.now() + DEVICE_POLL_LIMIT_MS);
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new IdentityError('AUTHORIZATION_DENIED');
      await sleep(interval * 1000, signal);
      const parameters = new URLSearchParams({
        client_id: clientId,
        grant_type: azure ? 'urn:ietf:params:oauth:grant-type:device_code' : 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      });
      const result = await this.postForm(endpoint, parameters, true);
      if (result.error === 'authorization_pending') continue;
      if (result.error === 'slow_down') {
        interval += 5;
        continue;
      }
      if (typeof result.error === 'string') throw new IdentityError('AUTHORIZATION_DENIED');
      return parseCredential(result);
    }
    throw new IdentityError('AUTHORIZATION_EXPIRED');
  }

  private async postForm(endpoint: string, body: URLSearchParams, allowOAuthError = false): Promise<JsonRecord> {
    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      throw new IdentityError('NETWORK_FAILURE');
    }
    const result = await readJson(response);
    if (!response.ok && !(allowOAuthError && typeof result.error === 'string')) throw new IdentityError('PROVIDER_FAILURE');
    return result;
  }

  private async getJson(endpoint: string, accessToken: string): Promise<JsonRecord> {
    let response: Response;
    try {
      response = await this.request(endpoint, { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } });
    } catch {
      throw new IdentityError('NETWORK_FAILURE');
    }
    if (!response.ok) throw new IdentityError('PROVIDER_FAILURE');
    return readJson(response);
  }
}

export function validateTenantId(value: string | undefined): string {
  if (typeof value !== 'string' || !(AZURE_TENANT_NAMES.has(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
    throw new IdentityError('INVALID_CONFIGURATION');
  }
  return value;
}

function azureAuthority(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}`;
}

function requireClientId(value: string): void {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw new IdentityError('INVALID_CONFIGURATION');
  }
}

function parseCredential(value: JsonRecord, previous?: StoredCredential): StoredCredential {
  const accessToken = requiredString(value.access_token);
  const refreshToken = optionalString(value.refresh_token) ?? previous?.refreshToken;
  const expiresIn = Number(value.expires_in);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    tokenType: optionalString(value.token_type) ?? previous?.tokenType ?? 'Bearer',
    ...(optionalString(value.scope) ? { scope: optionalString(value.scope) } : previous?.scope ? { scope: previous.scope } : {}),
  };
}

async function readJson(response: Response): Promise<JsonRecord> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as JsonRecord;
  } catch {
    throw new IdentityError('PROVIDER_FAILURE');
  }
}

function requiredString(value: unknown): string {
  const result = typeof value === 'number' ? String(value) : value;
  if (typeof result !== 'string' || result.length === 0 || result.length > 16_384) throw new IdentityError('PROVIDER_FAILURE');
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 ? value : undefined;
}

function boundedSeconds(value: unknown, fallback = 10): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(900, Math.max(1, number)) : fallback;
}

function validatedVerificationUri(value: unknown, expected: string): string {
  if (typeof value !== 'string') throw new IdentityError('PROVIDER_FAILURE');
  let actual: URL;
  try {
    actual = new URL(value);
  } catch {
    throw new IdentityError('PROVIDER_FAILURE');
  }
  const allowed = new URL(expected);
  if (actual.protocol !== 'https:' || actual.origin !== allowed.origin || actual.pathname !== allowed.pathname) {
    throw new IdentityError('PROVIDER_FAILURE');
  }
  return expected;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new IdentityError('AUTHORIZATION_DENIED'));
    }, { once: true });
  });
}
