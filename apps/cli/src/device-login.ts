import type { DeviceChallenge, IdentityProvider } from '@vspod/identity';
import { execute } from '@vspod/core/process';
import { VspodError } from '@vspod/core';

export function loginClientId(provider: IdentityProvider, explicit: string | undefined, environment: NodeJS.ProcessEnv): string | undefined {
  return explicit ?? (provider === 'github'
    ? environment.VSPOD_GITHUB_CLIENT_ID || 'Ov23liDC7oUEtbmsxOVh'
    : environment.VSPOD_AZURE_CLIENT_ID);
}

interface DeviceLoginPresentation {
  browser: boolean;
  signal?: AbortSignal;
  info(message: string): void;
  warn(message: string): void;
  openBrowser?: (url: string, signal?: AbortSignal) => Promise<void>;
}

async function openSystemBrowser(url: string, signal?: AbortSignal): Promise<void> {
  await execute('/usr/bin/open', [url], { timeout: 5_000, signal });
}

export function deviceChallengePresenter(provider: IdentityProvider, options: DeviceLoginPresentation) {
  const expected = provider === 'github' ? 'https://github.com/login/device' : 'https://microsoft.com/devicelogin';
  const opened = new Set<string>();
  return async (challenge: DeviceChallenge): Promise<void> => {
    options.signal?.throwIfAborted();
    if (challenge.verificationUri !== expected || !Number.isFinite(new Date(challenge.expiresAt).getTime())) {
      throw new VspodError('ACCOUNT_CHALLENGE_INVALID', 'The provider returned an invalid device challenge.', 'Retry login. No browser was opened.');
    }
    const expires = new Date(challenge.expiresAt).toISOString();
    options.info(`${provider === 'github' ? 'GitHub' : 'Azure'} sign-in: visit ${expected} and enter ${challenge.userCode}. Code expires at ${expires}.`);
    options.info('Approve only a login and code you just requested in VSPod. Do not share the code.');
    if (!options.browser || opened.has(challenge.userCode)) return;
    opened.add(challenge.userCode);
    try {
      await (options.openBrowser ?? openSystemBrowser)(expected, options.signal);
    } catch {
      options.signal?.throwIfAborted();
      options.warn(`Could not open the system browser. Open ${expected} manually and enter the code shown above. VSPod is still waiting for authorization.`);
    }
  };
}
