export type IdentityProvider = 'github' | 'azure';

export interface AccountMetadata {
  id: string;
  provider: IdentityProvider;
  subject: string;
  displayName?: string;
  tenantId?: string;
  createdAt: string;
}

export interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

export interface DeviceChallenge {
  userCode: string;
  verificationUri: string;
  message?: string;
  expiresAt: number;
}

export interface LoginOptions {
  clientId: string;
  tenantId?: string;
  onDeviceChallenge(challenge: DeviceChallenge): Promise<void> | void;
  signal?: AbortSignal;
}

export interface IdentityAccount {
  metadata: AccountMetadata;
  credential?: never;
}

export type Capability = 'repository.read' | 'repository.write' | 'cloud.deploy';

export interface AuthorizationGrant {
  accountId: string;
  capabilities: readonly Capability[];
  resource: string;
  expiresAt: number;
}

export interface RuntimeLease {
  grant: AuthorizationGrant;
  leaseId: string;
  expiresAt: number;
}

export interface RuntimeAuthorization {
  acquireLease(grant: AuthorizationGrant): Promise<RuntimeLease>;
  releaseLease(lease: RuntimeLease): Promise<void>;
}

export type GitOperation = 'read' | 'write';

export interface RuntimeBinding {
  containerId: string;
  startedAt: string;
}

export interface WorkspaceGrant {
  workspaceId: string;
  accountId: string;
  repositories: readonly string[];
  operations: readonly GitOperation[];
  createdAt: string;
}

export interface GitOperationLease {
  leaseId: string;
  workspaceId: string;
  accountId: string;
  repository: string;
  operation: GitOperation;
  binding: RuntimeBinding;
  issuedAt: number;
  expiresAt: number;
}

export interface RuntimeGitRequest {
  lease: GitOperationLease;
  accessToken: string;
}

export interface RuntimeGitTransport {
  performGitOperation(request: RuntimeGitRequest): Promise<{ success: boolean }>;
}

export interface LogoutResult {
  localCredentialsRemoved: true;
  upstreamRevocation: 'unsupported';
}
