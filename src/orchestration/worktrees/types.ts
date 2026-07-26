import type { GitObjectFormat } from '../../git/contracts.js';

export const WORKTREE_LEASES_VERSION = 1 as const;

export type WorktreeLeaseState =
  | 'provisioning'
  | 'active'
  | 'retained'
  | 'blocked'
  | 'cleanup-pending'
  | 'removed';

export interface WorktreeLeaseRecord {
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly ownerProfileId: string;
  readonly repositoryRoot: string;
  readonly commonGitDir: string;
  readonly objectFormat: GitObjectFormat;
  readonly checkoutPath: string;
  readonly branchRef: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly state: WorktreeLeaseState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedHead?: string | undefined;
  readonly lastVerifiedTree?: string | undefined;
  readonly blockedReason?: string | undefined;
}

export type PendingWorktreeOperationKind = 'provision' | 'cleanup';

export interface PendingWorktreeOperation {
  readonly operationId: string;
  readonly kind: PendingWorktreeOperationKind;
  readonly leaseId: string;
  readonly expectedBranchRef: string;
  readonly expectedCheckoutPath: string;
  readonly expectedHead: string;
  readonly createdAt: string;
}

export interface WorktreeLeasesFileV1 {
  readonly version: typeof WORKTREE_LEASES_VERSION;
  readonly revision: number;
  readonly leases: Readonly<Record<string, WorktreeLeaseRecord>>;
  readonly pendingOperations: Readonly<Record<string, PendingWorktreeOperation>>;
}

export type WorktreeLeaseStoreProblemKind = 'read' | 'parse' | 'write';

export interface WorktreeLeaseStoreProblem {
  readonly kind: WorktreeLeaseStoreProblemKind;
  readonly file: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface WorktreeLeaseStoreState {
  readonly file: string;
  readonly loaded: boolean;
  readonly fileExists: boolean;
  readonly data: WorktreeLeasesFileV1;
  readonly problem: WorktreeLeaseStoreProblem | undefined;
}
