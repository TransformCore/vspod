import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { IdentityError } from './errors.ts';
import { FileWorkspaceGrantStore } from './grant-store.ts';
import type { IdentityService } from './service.ts';
import type { GitOperation, GitOperationLease, RuntimeBinding, RuntimeGitTransport, WorkspaceGrant } from './types.ts';
import type { WorkspaceGrantStore } from './grant-store.ts';

const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_LEASE_TTL_MS = 120_000;
const MAX_LEASES = 10_000;

export interface CredentialBrokerOptions {
  identity: IdentityService;
  grantStore?: WorkspaceGrantStore;
  grantPath?: string;
  rootDirectory?: string;
  transport?: RuntimeGitTransport;
  leaseTtlMs?: number;
}

export class CredentialBroker {
  private readonly grants: WorkspaceGrantStore;
  private readonly transport: RuntimeGitTransport;
  private readonly leases = new Map<string, GitOperationLease>();
  private readonly ttl: number;

  constructor(private readonly options: CredentialBrokerOptions) {
    const root = options.rootDirectory
      ?? process.env.VSPOD_STATE_DIR
      ?? process.env.VSPOD_CONFIG_DIR
      ?? join(homedir(), 'Library', 'Application Support', 'VSPod');
    this.grants = options.grantStore ?? new FileWorkspaceGrantStore(
      options.grantPath ?? join(resolve(root), 'identity', 'workspace-grants.json'),
    );
    this.transport = options.transport ?? {
      performGitOperation: async () => {
        throw new IdentityError('UNSUPPORTED_RUNTIME_AUTHORIZATION');
      },
    };
    const requested = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.ttl = Math.min(MAX_LEASE_TTL_MS, Math.max(1_000, requested));
  }

  async grantWorkspace(
    workspaceId: string,
    accountId: string,
    repositories: readonly string[],
    operations: readonly GitOperation[],
  ): Promise<WorkspaceGrant> {
    validateIdentifier(workspaceId);
    validateIdentifier(accountId);
    if (!(await this.options.identity.list()).some((account) => account.metadata.id === accountId)) {
      throw new IdentityError('ACCOUNT_NOT_FOUND');
    }
    const repositorySet = [...new Set(repositories.map(normalizeGitHubRepository))];
    const operationSet = [...new Set(operations)];
    if (!repositorySet.length || !operationSet.length || operationSet.some((operation) => operation !== 'read' && operation !== 'write')) {
      throw new IdentityError('INVALID_CONFIGURATION');
    }
    const grant: WorkspaceGrant = {
      workspaceId,
      accountId,
      repositories: repositorySet,
      operations: operationSet,
      createdAt: new Date().toISOString(),
    };
    await this.grants.save(grant);
    return grant;
  }

  async listWorkspaceGrants(): Promise<WorkspaceGrant[]> {
    return this.grants.list();
  }

  async revokeWorkspaceGrant(workspaceId: string): Promise<void> {
    await this.grants.remove(workspaceId);
    for (const [leaseId, lease] of this.leases) {
      if (lease.workspaceId === workspaceId) this.leases.delete(leaseId);
    }
  }

  async acquireGitLease(
    workspaceId: string,
    binding: RuntimeBinding,
    repositoryUrl: string,
    operation: GitOperation,
  ): Promise<GitOperationLease> {
    validateBinding(binding);
    const repository = normalizeGitHubRepository(repositoryUrl);
    const grant = (await this.grants.list()).find((candidate) => candidate.workspaceId === workspaceId);
    if (!grant || !grant.repositories.includes(repository) || !grant.operations.includes(operation)) {
      throw new IdentityError('AUTHORIZATION_DENIED');
    }
    if (this.leases.size >= MAX_LEASES) {
      const now = Date.now();
      for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
      if (this.leases.size >= MAX_LEASES) throw new IdentityError('UNSUPPORTED_RUNTIME_AUTHORIZATION');
    }
    const issuedAt = Date.now();
    const lease: GitOperationLease = {
      leaseId: randomUUID(),
      workspaceId,
      accountId: grant.accountId,
      repository,
      operation,
      binding: { containerId: binding.containerId, startedAt: binding.startedAt },
      issuedAt,
      expiresAt: issuedAt + this.ttl,
    };
    this.leases.set(lease.leaseId, lease);
    return structuredClone(lease);
  }

  async executeGitOperation(lease: GitOperationLease, binding: RuntimeBinding): Promise<{ success: boolean }> {
    const issued = this.leases.get(lease.leaseId);
    if (!issued || !sameLease(issued, lease) || !sameBinding(issued.binding, binding) || issued.expiresAt <= Date.now()) {
      this.leases.delete(lease.leaseId);
      throw new IdentityError('AUTHORIZATION_DENIED');
    }
    this.leases.delete(lease.leaseId);
    const currentGrant = (await this.grants.list()).find((grant) => grant.workspaceId === issued.workspaceId);
    if (!currentGrant || currentGrant.accountId !== issued.accountId
      || !currentGrant.repositories.includes(issued.repository) || !currentGrant.operations.includes(issued.operation)) {
      throw new IdentityError('AUTHORIZATION_DENIED');
    }
    const accessToken = await this.options.identity.getAccessToken(issued.accountId);
    return this.transport.performGitOperation({ lease: structuredClone(issued), accessToken });
  }
}

export function normalizeGitHubRepository(value: string): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})(?:\.git)?$/i.exec(value);
  if (!match) throw new IdentityError('INVALID_CONFIGURATION');
  const owner = match[1] ?? '';
  const rawRepository = match[2] ?? '';
  const repository = rawRepository.endsWith('.git') ? rawRepository.slice(0, -4) : rawRepository;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository === '.' || repository === '..') {
    throw new IdentityError('INVALID_CONFIGURATION');
  }
  return `${owner}/${repository}`;
}

function validateIdentifier(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw new IdentityError('INVALID_CONFIGURATION');
}

function validateBinding(binding: RuntimeBinding): void {
  validateIdentifier(binding.containerId);
  const start = Date.parse(binding.startedAt);
  if (!Number.isFinite(start) || start > Date.now() + 60_000) throw new IdentityError('INVALID_CONFIGURATION');
}

function sameBinding(left: RuntimeBinding, right: RuntimeBinding): boolean {
  return left.containerId === right.containerId && left.startedAt === right.startedAt;
}

function sameLease(left: GitOperationLease, right: GitOperationLease): boolean {
  return left.leaseId === right.leaseId && left.workspaceId === right.workspaceId
    && left.accountId === right.accountId && left.repository === right.repository
    && left.operation === right.operation && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt && sameBinding(left.binding, right.binding);
}
