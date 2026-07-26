import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  GitCheckoutInspection,
  GitPort,
  GitRepositoryIdentity,
} from '../git/contracts.js';
import type { WorktreeLeaseRecord as OwnedWorktreeLease } from '../orchestration/worktrees/types.js';
import type {
  BuiltIntegrationCandidate,
  IntegratedCandidate,
  MissionGitPort,
  VerifiedHandoff,
} from './coordinator.js';
import type {
  HandoffRecord,
  RepositoryTargetSnapshot,
  WorktreeLeaseRecord,
} from './types.js';

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface MissionGitWorkspace {
  readonly id: string;
  readonly canonicalPath: string;
  readonly trusted: boolean;
}

export interface MissionHandoffLeasePort {
  reconcile(leaseId: string): Promise<OwnedWorktreeLease>;
  retain(
    leaseId: string,
    expectedHead: string,
  ): Promise<OwnedWorktreeLease>;
}

export interface MissionGitAdapterOptions {
  readonly git: GitPort;
  readonly leases: MissionHandoffLeasePort;
  readonly workspace: MissionGitWorkspace;
  readonly platform?: NodeJS.Platform | undefined;
}

export class MissionGitAdapterError extends Error {
  override readonly name = 'MissionGitAdapterError';
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(value);
  return platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  return pathIdentity(left, platform) === pathIdentity(right, platform);
}

function requireOid(value: string, name: string): void {
  if (!GIT_OBJECT_ID.test(value)) {
    throw new MissionGitAdapterError(
      `${name} must be a full lowercase Git object ID.`,
    );
  }
}

function requireOpaque(value: string, name: string): void {
  if (
    value.trim() === '' ||
    value.length > 512 ||
    CONTROL.test(value)
  ) {
    throw new MissionGitAdapterError(`${name} is empty, too long, or invalid.`);
  }
}

function sameTarget(
  left: RepositoryTargetSnapshot,
  right: RepositoryTargetSnapshot,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.targetRef === right.targetRef &&
    left.commitSha === right.commitSha &&
    left.treeSha === right.treeSha
  );
}

function exactTargetCheckout(
  inspection: GitCheckoutInspection,
  repository: GitRepositoryIdentity,
  workspace: MissionGitWorkspace,
  platform: NodeJS.Platform,
): boolean {
  return (
    samePath(inspection.checkoutPath, workspace.canonicalPath, platform) &&
    samePath(inspection.commonGitDir, repository.commonGitDir, platform) &&
    inspection.branchRef !== undefined &&
    inspection.branchRef.startsWith('refs/heads/') &&
    inspection.clean
  );
}

/**
 * Stable immutable evidence ref for an accepted handoff. Only the digest is
 * included in the ref path, so mission/task input can never manufacture a ref.
 */
export function missionHandoffRef(request: {
  readonly workspaceId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly commitSha: string;
}): string {
  const digest = createHash('sha256')
    .update(
      `${request.workspaceId}\0${request.missionId}\0${request.taskId}\0${request.commitSha}`,
    )
    .digest('hex');
  return `refs/council/handoffs/${digest}`;
}

/**
 * Semantic Mission Git authority. It accepts no argv and never treats a branch
 * label, working tree, or provider assertion as handoff evidence.
 */
export class MissionGitAdapter implements MissionGitPort {
  private readonly git: GitPort;
  private readonly leases: MissionHandoffLeasePort;
  private readonly workspace: MissionGitWorkspace;
  private readonly platform: NodeJS.Platform;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MissionGitAdapterOptions) {
    if (!path.isAbsolute(options.workspace.canonicalPath)) {
      throw new TypeError('Mission workspace path must be absolute.');
    }
    this.git = options.git;
    this.leases = options.leases;
    this.workspace = options.workspace;
    this.platform = options.platform ?? process.platform;
  }

  inspectTarget(request: {
    readonly workspaceId: string;
    readonly targetRef?: string | undefined;
  }): Promise<RepositoryTargetSnapshot> {
    return this.enqueue(async () => {
      const { checkout } = await this.inspectTrustedTarget(
        request.workspaceId,
      );
      if (
        request.targetRef !== undefined &&
        request.targetRef !== checkout.branchRef
      ) {
        throw new MissionGitAdapterError(
          'Selected target ref is not the branch checked out by the trusted workspace.',
        );
      }
      return {
        workspaceId: this.workspace.id,
        targetRef: checkout.branchRef!,
        commitSha: checkout.commit,
        treeSha: checkout.tree,
      };
    });
  }

  verifyHandoff(request: {
    readonly workspaceId: string;
    readonly missionId: string;
    readonly taskId: string;
    readonly lease: WorktreeLeaseRecord;
    readonly claimedCommitSha: string;
    readonly claimedTreeSha: string;
  }): Promise<VerifiedHandoff> {
    return this.enqueue(async () => {
      this.assertWorkspace(request.workspaceId);
      requireOpaque(request.missionId, 'Mission ID');
      requireOpaque(request.taskId, 'Task ID');
      requireOid(request.claimedCommitSha, 'Claimed handoff commit');
      requireOid(request.claimedTreeSha, 'Claimed handoff tree');
      if (
        request.lease.workspaceId !== request.workspaceId ||
        request.lease.missionId !== request.missionId ||
        request.lease.taskId !== request.taskId ||
        request.lease.state !== 'ready'
      ) {
        throw new MissionGitAdapterError(
          'Mission handoff lease does not exactly own this task.',
        );
      }

      const owned = await this.leases.reconcile(request.lease.id);
      if (owned.state !== 'active' && owned.state !== 'retained') {
        throw new MissionGitAdapterError(
          `Owned worktree lease is ${owned.state}, not handoff-ready.`,
        );
      }
      this.assertExactLease(request.lease, owned);

      const repository = await this.git.inspectRepository(
        this.workspace.canonicalPath,
      );
      if (
        !samePath(
          repository.repositoryRoot,
          owned.repositoryRoot,
          this.platform,
        ) ||
        !samePath(repository.commonGitDir, owned.commonGitDir, this.platform) ||
        repository.objectFormat !== owned.objectFormat
      ) {
        throw new MissionGitAdapterError(
          'Owned lease no longer belongs to the trusted repository identity.',
        );
      }
      const base = await this.git.resolveCommit(
        repository.repositoryRoot,
        owned.baseCommit,
      );
      if (
        base.commit !== request.lease.baseCommitSha ||
        base.tree !== request.lease.baseTreeSha ||
        base.tree !== owned.baseTree
      ) {
        throw new MissionGitAdapterError(
          'Handoff lease base commit or tree identity does not match.',
        );
      }

      const checkout = await this.git.inspectCheckout(owned.checkoutPath);
      if (
        !samePath(checkout.checkoutPath, owned.checkoutPath, this.platform) ||
        !samePath(checkout.commonGitDir, repository.commonGitDir, this.platform) ||
        checkout.branchRef !== owned.branchRef ||
        !checkout.clean
      ) {
        throw new MissionGitAdapterError(
          'Handoff requires the exact clean owned writer checkout.',
        );
      }
      if (
        checkout.commit !== request.claimedCommitSha ||
        checkout.tree !== request.claimedTreeSha
      ) {
        throw new MissionGitAdapterError(
          'Owned checkout does not match the exact claimed handoff commit and tree.',
        );
      }
      if (
        !(await this.git.isAncestor(
          repository.repositoryRoot,
          owned.baseCommit,
          checkout.commit,
        ))
      ) {
        throw new MissionGitAdapterError(
          'Handoff commit does not descend from its exact lease base.',
        );
      }

      const ref = missionHandoffRef({
        workspaceId: request.workspaceId,
        missionId: request.missionId,
        taskId: request.taskId,
        commitSha: checkout.commit,
      });
      await this.git.pinCouncilHandoffRef({
        repositoryRoot: repository.repositoryRoot,
        objectFormat: repository.objectFormat,
        ref,
        commit: checkout.commit,
      });
      const pinned = await this.git.resolveCommit(
        repository.repositoryRoot,
        ref,
      );
      if (
        pinned.commit !== checkout.commit ||
        pinned.tree !== checkout.tree
      ) {
        throw new MissionGitAdapterError(
          'Durable handoff ref does not resolve to the verified commit and tree.',
        );
      }

      const retained = await this.leases.retain(owned.leaseId, checkout.commit);
      if (
        retained.state !== 'retained' ||
        retained.lastVerifiedHead !== checkout.commit ||
        retained.lastVerifiedTree !== checkout.tree
      ) {
        throw new MissionGitAdapterError(
          'Owned lease could not be retained at the exact handoff boundary.',
        );
      }
      const after = await this.git.inspectCheckout(owned.checkoutPath);
      if (
        !after.clean ||
        after.branchRef !== owned.branchRef ||
        after.commit !== checkout.commit ||
        after.tree !== checkout.tree ||
        !samePath(after.commonGitDir, owned.commonGitDir, this.platform)
      ) {
        throw new MissionGitAdapterError(
          'Handoff checkout changed while its durable evidence was being recorded.',
        );
      }
      return {
        baseCommitSha: owned.baseCommit,
        commitSha: checkout.commit,
        treeSha: checkout.tree,
      };
    });
  }

  buildCandidate(request: {
    readonly workspaceId: string;
    readonly missionId: string;
    readonly target: RepositoryTargetSnapshot;
    readonly handoffs: readonly HandoffRecord[];
  }): Promise<BuiltIntegrationCandidate> {
    return this.enqueue(async () => {
      this.assertWorkspace(request.workspaceId);
      requireOpaque(request.missionId, 'Mission ID');
      if (request.handoffs.length === 0) {
        throw new MissionGitAdapterError(
          'A fast-forward candidate requires at least one handoff.',
        );
      }
      const freshTarget = await this.inspectTrustedTargetSnapshot(
        request.workspaceId,
        request.target.targetRef,
      );
      if (!sameTarget(freshTarget.snapshot, request.target)) {
        throw new MissionGitAdapterError(
          'Integration target changed before candidate construction.',
        );
      }

      let precedingCommit = request.target.commitSha;
      let candidateCommit = request.target.commitSha;
      let candidateTree = request.target.treeSha;
      for (const handoff of request.handoffs) {
        if (
          handoff.workspaceId !== request.workspaceId ||
          handoff.missionId !== request.missionId ||
          handoff.baseCommitSha !== request.target.commitSha
        ) {
          throw new MissionGitAdapterError(
            'Candidate handoff does not belong to the exact Mission target base.',
          );
        }
        requireOid(handoff.commitSha, 'Handoff commit');
        requireOid(handoff.treeSha, 'Handoff tree');
        const ref = missionHandoffRef({
          workspaceId: handoff.workspaceId,
          missionId: handoff.missionId,
          taskId: handoff.taskId,
          commitSha: handoff.commitSha,
        });
        const pinned = await this.git.resolveCommit(
          freshTarget.repository.repositoryRoot,
          ref,
        );
        if (
          pinned.commit !== handoff.commitSha ||
          pinned.tree !== handoff.treeSha
        ) {
          throw new MissionGitAdapterError(
            `Handoff "${handoff.id}" is not pinned to its exact commit and tree.`,
          );
        }
        if (
          !(await this.git.isAncestor(
            freshTarget.repository.repositoryRoot,
            request.target.commitSha,
            handoff.commitSha,
          )) ||
          !(await this.git.isAncestor(
            freshTarget.repository.repositoryRoot,
            precedingCommit,
            handoff.commitSha,
          ))
        ) {
          throw new MissionGitAdapterError(
            'Ordered handoffs do not form one safe fast-forward ancestry chain.',
          );
        }
        precedingCommit = handoff.commitSha;
        candidateCommit = handoff.commitSha;
        candidateTree = handoff.treeSha;
      }

      const after = await this.inspectTrustedTargetSnapshot(
        request.workspaceId,
        request.target.targetRef,
      );
      if (!sameTarget(after.snapshot, request.target)) {
        throw new MissionGitAdapterError(
          'Integration target changed during candidate construction.',
        );
      }
      return {
        targetRef: request.target.targetRef,
        baseCommitSha: request.target.commitSha,
        baseTreeSha: request.target.treeSha,
        commitSha: candidateCommit,
        treeSha: candidateTree,
      };
    });
  }

  integrateCandidate(request: {
    readonly workspaceId: string;
    readonly missionId: string;
    readonly targetRef: string;
    readonly expectedTargetCommitSha: string;
    readonly expectedTargetTreeSha: string;
    readonly candidateCommitSha: string;
    readonly candidateTreeSha: string;
  }): Promise<IntegratedCandidate> {
    return this.enqueue(async () => {
      this.assertWorkspace(request.workspaceId);
      requireOpaque(request.missionId, 'Mission ID');
      requireOid(request.expectedTargetCommitSha, 'Expected target commit');
      requireOid(request.expectedTargetTreeSha, 'Expected target tree');
      requireOid(request.candidateCommitSha, 'Candidate commit');
      requireOid(request.candidateTreeSha, 'Candidate tree');

      const target = await this.inspectIntegrationTarget(
        request.workspaceId,
        request.targetRef,
        request.expectedTargetCommitSha,
        request.expectedTargetTreeSha,
        request.candidateCommitSha,
        request.candidateTreeSha,
      );
      const candidate = await this.git.resolveCommit(
        target.repository.repositoryRoot,
        request.candidateCommitSha,
      );
      if (
        candidate.commit !== request.candidateCommitSha ||
        candidate.tree !== request.candidateTreeSha
      ) {
        throw new MissionGitAdapterError(
          'Integration candidate no longer resolves to its reviewed tree.',
        );
      }
      if (
        !(await this.git.isAncestor(
          target.repository.repositoryRoot,
          request.expectedTargetCommitSha,
          request.candidateCommitSha,
        ))
      ) {
        throw new MissionGitAdapterError(
          'Integration candidate is not a fast-forward of the approved target.',
        );
      }

      const mutation = await this.git.fastForwardCheckout({
        checkoutPath: target.checkout.checkoutPath,
        branchRef: request.targetRef,
        expectedCommit: request.expectedTargetCommitSha,
        expectedTree: request.expectedTargetTreeSha,
        nextCommit: request.candidateCommitSha,
        nextTree: request.candidateTreeSha,
      });
      this.assertIntegratedCheckout(
        mutation,
        target.repository,
        request.targetRef,
        request.candidateCommitSha,
        request.candidateTreeSha,
      );

      const after = await this.inspectTrustedTargetSnapshot(
        request.workspaceId,
        request.targetRef,
      );
      if (
        after.snapshot.commitSha !== request.candidateCommitSha ||
        after.snapshot.treeSha !== request.candidateTreeSha
      ) {
        throw new MissionGitAdapterError(
          'Fast-forward mutation did not satisfy the exact clean target postcondition.',
        );
      }
      return {
        targetRef: request.targetRef,
        previousCommitSha: request.expectedTargetCommitSha,
        previousTreeSha: request.expectedTargetTreeSha,
        commitSha: after.snapshot.commitSha,
        treeSha: after.snapshot.treeSha,
      };
    });
  }

  private async inspectIntegrationTarget(
    workspaceId: string,
    targetRef: string,
    expectedCommit: string,
    expectedTree: string,
    candidateCommit: string,
    candidateTree: string,
  ): Promise<{
    readonly repository: GitRepositoryIdentity;
    readonly checkout: GitCheckoutInspection;
  }> {
    this.assertWorkspace(workspaceId);
    const repository = await this.git.inspectRepository(
      this.workspace.canonicalPath,
    );
    const checkout = await this.git.inspectCheckout(
      this.workspace.canonicalPath,
    );
    if (
      !samePath(
        repository.repositoryRoot,
        this.workspace.canonicalPath,
        this.platform,
      ) ||
      !samePath(
        checkout.checkoutPath,
        this.workspace.canonicalPath,
        this.platform,
      ) ||
      !samePath(
        checkout.commonGitDir,
        repository.commonGitDir,
        this.platform,
      ) ||
      checkout.branchRef !== targetRef
    ) {
      throw new MissionGitAdapterError(
        'Integration target is detached or no longer the trusted repository checkout.',
      );
    }
    const atExpected =
      checkout.commit === expectedCommit &&
      checkout.tree === expectedTree &&
      checkout.clean;
    const atCandidate =
      checkout.commit === candidateCommit &&
      checkout.tree === candidateTree;
    if (!atExpected && !atCandidate) {
      throw new MissionGitAdapterError(
        'Integration target drifted from both the approved old and candidate identities.',
      );
    }
    return { repository, checkout };
  }

  private async inspectTrustedTarget(
    workspaceId: string,
  ): Promise<{
    readonly repository: GitRepositoryIdentity;
    readonly checkout: GitCheckoutInspection;
  }> {
    this.assertWorkspace(workspaceId);
    const repository = await this.git.inspectRepository(
      this.workspace.canonicalPath,
    );
    const checkout = await this.git.inspectCheckout(
      this.workspace.canonicalPath,
    );
    if (
      !samePath(
        repository.repositoryRoot,
        this.workspace.canonicalPath,
        this.platform,
      ) ||
      !exactTargetCheckout(
        checkout,
        repository,
        this.workspace,
        this.platform,
      ) ||
      repository.headCommit !== checkout.commit ||
      repository.headTree !== checkout.tree
    ) {
      throw new MissionGitAdapterError(
        'Trusted target must be the exact clean attached repository-root checkout.',
      );
    }
    return { repository, checkout };
  }

  private async inspectTrustedTargetSnapshot(
    workspaceId: string,
    targetRef: string,
  ): Promise<{
    readonly repository: GitRepositoryIdentity;
    readonly checkout: GitCheckoutInspection;
    readonly snapshot: RepositoryTargetSnapshot;
  }> {
    const { repository, checkout } = await this.inspectTrustedTarget(workspaceId);
    if (checkout.branchRef !== targetRef) {
      throw new MissionGitAdapterError(
        'Trusted target is detached or checked out on a different branch.',
      );
    }
    return {
      repository,
      checkout,
      snapshot: {
        workspaceId,
        targetRef,
        commitSha: checkout.commit,
        treeSha: checkout.tree,
      },
    };
  }

  private assertExactLease(
    missionLease: WorktreeLeaseRecord,
    owned: OwnedWorktreeLease,
  ): void {
    if (
      owned.leaseId !== missionLease.id ||
      owned.workspaceId !== missionLease.workspaceId ||
      owned.missionId !== missionLease.missionId ||
      owned.taskId !== missionLease.taskId ||
      owned.assignmentId !== missionLease.assignmentId ||
      owned.ownerProfileId !== missionLease.ownerProfileId ||
      owned.accessMode !== missionLease.accessMode ||
      missionLease.accessMode !== 'workspace-write' ||
      owned.branchRef !== missionLease.branchName ||
      !samePath(owned.checkoutPath, missionLease.canonicalPath, this.platform) ||
      owned.baseCommit !== missionLease.baseCommitSha ||
      owned.baseTree !== missionLease.baseTreeSha
    ) {
      throw new MissionGitAdapterError(
        'Mission lease and owned worktree lease identities do not match exactly.',
      );
    }
  }

  private assertIntegratedCheckout(
    inspection: GitCheckoutInspection,
    repository: GitRepositoryIdentity,
    targetRef: string,
    commit: string,
    tree: string,
  ): void {
    if (
      !samePath(
        inspection.checkoutPath,
        this.workspace.canonicalPath,
        this.platform,
      ) ||
      !samePath(
        inspection.commonGitDir,
        repository.commonGitDir,
        this.platform,
      ) ||
      inspection.branchRef !== targetRef ||
      inspection.commit !== commit ||
      inspection.tree !== tree ||
      !inspection.clean
    ) {
      throw new MissionGitAdapterError(
        'Git integration boundary did not return the exact clean target postcondition.',
      );
    }
  }

  private assertWorkspace(workspaceId: string): void {
    if (!this.workspace.trusted) {
      throw new MissionGitAdapterError(
        'Mission Git operations require an explicitly trusted workspace.',
      );
    }
    if (workspaceId !== this.workspace.id) {
      throw new MissionGitAdapterError(
        'Mission Git request belongs to another workspace.',
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
