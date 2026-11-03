export type IdentityErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'ACCOUNT_NOT_FOUND'
  | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_EXPIRED'
  | 'NETWORK_FAILURE'
  | 'PROVIDER_FAILURE'
  | 'SECURE_STORE_UNAVAILABLE'
  | 'UNSUPPORTED_RUNTIME_AUTHORIZATION';

const publicMessages: Record<IdentityErrorCode, string> = {
  INVALID_CONFIGURATION: 'Identity configuration is invalid.',
  ACCOUNT_NOT_FOUND: 'The requested identity account was not found.',
  AUTHORIZATION_DENIED: 'The identity provider denied authorization.',
  AUTHORIZATION_EXPIRED: 'The device authorization request expired.',
  NETWORK_FAILURE: 'The identity provider could not be reached.',
  PROVIDER_FAILURE: 'The identity provider returned an unsupported response.',
  SECURE_STORE_UNAVAILABLE: 'The operating-system secure credential store is unavailable.',
  UNSUPPORTED_RUNTIME_AUTHORIZATION: 'Runtime credential brokering is not available on this host.',
};

export class IdentityError extends Error {
  public readonly hint: string;

  constructor(public readonly code: IdentityErrorCode) {
    super(publicMessages[code]);
    this.name = 'IdentityError';
    this.hint = code === 'UNSUPPORTED_RUNTIME_AUTHORIZATION'
      ? 'Runtime credential relay is not wired on this host. No credential was provided to the runtime.'
      : 'Check identity configuration and retry. Sensitive provider details are intentionally omitted.';
  }
}

export function identityError(code: IdentityErrorCode): IdentityError {
  return new IdentityError(code);
}
