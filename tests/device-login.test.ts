import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceChallengePresenter, loginClientId } from '../apps/cli/src/device-login.ts';

test('GitHub uses the VSPod registration with explicit > environment > shipped default precedence; Azure has no default', () => {
  assert.equal(loginClientId('github', undefined, {}), 'Ov23liDC7oUEtbmsxOVh');
  assert.equal(loginClientId('github', undefined, { VSPOD_GITHUB_CLIENT_ID: '' }), 'Ov23liDC7oUEtbmsxOVh');
  assert.equal(loginClientId('github', undefined, { VSPOD_GITHUB_CLIENT_ID: 'custom-registration' }), 'custom-registration');
  assert.equal(loginClientId('github', 'explicit-registration', { VSPOD_GITHUB_CLIENT_ID: 'custom-registration' }), 'explicit-registration');
  assert.equal(loginClientId('github', '', {}), '');
  assert.equal(loginClientId('azure', undefined, {}), undefined);
  assert.equal(loginClientId('azure', undefined, { VSPOD_AZURE_CLIENT_ID: 'azure-registration' }), 'azure-registration');
  assert.equal(loginClientId('azure', 'explicit-registration', { VSPOD_AZURE_CLIENT_ID: 'azure-registration' }), 'explicit-registration');
});

for (const provider of ['github', 'azure'] as const) {
  const url = provider === 'github' ? 'https://github.com/login/device' : 'https://microsoft.com/devicelogin';
  const challenge = { userCode: 'ABCD-EFGH', verificationUri: url, expiresAt: Date.now() + 60_000 };
  test(`${provider} displays instructions before opening the exact verification URL once`, async () => {
    const events: string[] = [];
    const present = deviceChallengePresenter(provider, {
      browser: true, info: (message) => events.push(message), warn: assert.fail,
      openBrowser: async (target) => { assert.equal(target, url); events.push('opened'); },
    });
    await present(challenge);
    await present(challenge);
    assert.match(events[0], /ABCD-EFGH.*expires at/);
    assert.match(events[1], /only a login and code you just requested/);
    assert.equal(events[2], 'opened');
    assert.equal(events.filter((event) => event === 'opened').length, 1);
    assert.ok(events.every((event) => !event.includes('access_token')));
  });
  test(`${provider} manual mode never opens a browser and opener failure continues with a visible warning`, async () => {
    const messages: string[] = [];
    const warnings: string[] = [];
    const options = {
      browser: false, info: (message: string) => messages.push(message),
      warn: (message: string) => warnings.push(message),
      openBrowser: async () => { throw new Error('OPENER_INTERNAL_DETAILS'); },
    };
    await deviceChallengePresenter(provider, options)(challenge);
    assert.equal(warnings.length, 0);
    await deviceChallengePresenter(provider, { ...options, browser: true })(challenge);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /manually.*still waiting/);
    assert.doesNotMatch(warnings[0], /OPENER_INTERNAL_DETAILS/);
    assert.ok(messages.some((message) => message.includes(url)));
  });
  test(`${provider} rejects unsafe URLs and cancellation without opening or masking aborts`, async () => {
    let opens = 0;
    const abort = new AbortController();
    const present = deviceChallengePresenter(provider, {
      browser: true, signal: abort.signal, info: () => {}, warn: assert.fail,
      openBrowser: async () => { opens++; abort.abort(); abort.signal.throwIfAborted(); },
    });
    for (const verificationUri of ['https://evil.example/login', `${url}?token=secret`, `${url}#code`, 'file:///tmp/login']) {
      await assert.rejects(present({ ...challenge, verificationUri }), { code: 'ACCOUNT_CHALLENGE_INVALID' });
    }
    assert.equal(opens, 0);
    await assert.rejects(present(challenge), { name: 'AbortError' });
    assert.equal(opens, 1);
    await assert.rejects(present(challenge), { name: 'AbortError' });
    assert.equal(opens, 1);
  });
}
