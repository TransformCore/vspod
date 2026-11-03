export { IdentityError } from './errors.ts';
export type { IdentityErrorCode } from './errors.ts';
export { FileAccountMetadataStore } from './metadata-store.ts';
export { DeviceProviderClient, validateTenantId } from './providers.ts';
export { CredentialBroker, normalizeGitHubRepository } from './credential-broker.ts';
export { FileWorkspaceGrantStore } from './grant-store.ts';
export { IdentityService } from './service.ts';
export { MacKeychainSecureStore } from './secure-store.ts';
export type { AccountMetadataStore } from './metadata-store.ts';
export type { CredentialBrokerOptions } from './credential-broker.ts';
export type { WorkspaceGrantStore } from './grant-store.ts';
export type { IdentityServiceOptions } from './service.ts';
export type { SecureStore } from './secure-store.ts';
export type {
  AccountMetadata,
  AuthorizationGrant,
  Capability,
  DeviceChallenge,
  IdentityAccount,
  IdentityProvider,
  GitOperation,
  GitOperationLease,
  LoginOptions,
  LogoutResult,
  RuntimeBinding,
  RuntimeAuthorization,
  RuntimeGitRequest,
  RuntimeGitTransport,
  RuntimeLease,
  StoredCredential,
  WorkspaceGrant,
} from './types.ts';

import { IdentityService } from './service.ts';
import type { IdentityServiceOptions } from './service.ts';

export function createHostIdentity(options: IdentityServiceOptions): IdentityService {
  return new IdentityService(options);
}
