import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { isFullGitObjectId } from '../../git/client.js';
import type {
  GitCheckoutInspection,
  GitPort,
  GitRepositoryIdentity,
  GitWorktreeEntry,
} from '../../git/contracts.js';
import { WorktreeLeaseStore } from './leaseStore.js';
import type {
  PendingWorktreeOperation,
  WorktreeLeaseRecord,
  WorktreeLeasesFileV1,
} from './types.js';

export interface WorktreeLeaseWorkspace {
  readonly id: string;
  readonly canonicalPath: string;
  readonly trusted: boolean;
}

export interface ProvisionWriterLeaseRequest {
  readonly missionId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly ownerProfileId: string;
  readonly baseCommit: string;
  /** Exact ID shown in a privileged Mission preview. */
  readonly plannedLeaseId?: string | undefined;
}

export interface WorktreeLeaseManagerOptions {
  readonly git: GitPort;
  readonly store: WorktreeLeaseStore;
  readonly workspace: WorktreeLeaseWorkspace;
  readonly worktreeRoot: string;
  readonly now?: (() => Date) | undefined;
  readonly leaseId?: (() => string) | undefined;
  readonly operationId?: (() => string) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export class WorktreeLeaseOperationError extends Error {
  override readonly name = 'WorktreeLeaseOperationError';
}

function generatedId(prefix: 'lease' | 'leaseop'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function mutableLeases(
  data: WorktreeLeasesFileV1,
): Record<string, WorktreeLeaseRecord> {
  return data.leases as Record<string, WorktreeLeaseRecord>;
}

function mutablePending(
  data: WorktreeLeasesFileV1,
): Record<string, PendingWorktreeOperation> {
  return data.pendingOperations as Record<string, PendingWorktreeOperation>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );
}

/**
 * Council-owned writer worktrees.
 *
 * Every Git mutation is preceded by a durable operation journal. App shutdown
 * closes admission and drains in-flight storage/Git work without removing a
 * worktree or branch.
 */
export class WorktreeLeaseManager {
  private readonly git: GitPort;
  private readonly store: WorktreeLeaseStore;
  private readonly workspace: WorktreeLeaseWorkspace;
  private readonly configuredWorktreeRoot: string;
  private readonly now: () => Date;
  private readonly makeLeaseId: () => string;
  private readonly makeOperationId: () => string;
  private readonly platform: NodeJS.Platform;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(options: WorktreeLeaseManagerOptions) {
    if (!path.isAbsolute(options.worktreeRoot)) {
      throw new TypeError('Council worktree root must be absolute.');
    }
    this.git = options.git;
    this.store = options.store;
    this.workspace = options.workspace;
    this.configuredWorktreeRoot = options.worktreeRoot;
    this.now = options.now ?? (() => new Date());
    this.makeLeaseId = options.leaseId ?? (() => generatedId('lease'));
    this.makeOperationId =
      options.operationId ?? (() => generatedId('leaseop'));
    this.platform = options.platform ?? process.platform;
  }

  provisionWriter(
    request: ProvisionWriterLeaseRequest,
  ): Promise<WorktreeLeaseRecord> {
    return this.enqueue(async () => this.provisionWriterUnlocked(request));
  }

  reconcile(leaseId: string): Promise<WorktreeLeaseRecord> {
    return this.enqueue(async () => this.reconcileUnlocked(leaseId));
  }

  retain(
    leaseId: string,
    expectedHead: string,
  ): Promise<WorktreeLeaseRecord> {
    return this.enqueue(async () => {
      const lease = await this.reconcileUnlocked(leaseId);
      if (lease.state === 'retained') {
        if (lease.lastVerifiedHead !== expectedHead) {
          throw new WorktreeLeaseOperationError(
            'Retained lease HEAD does not match the expected handoff commit.',
          );
        }
        return lease;
      }
      if (lease.state !== 'active') {
        throw new WorktreeLeaseOperationError(
          `Only an active writer lease can be retained; current state is ${lease.state}.`,
        );
      }
      const inspection = await this.verifyLease(lease, false);
      if (!inspection.clean) {
        throw new WorktreeLeaseOperationError(
          'Writer lease has staged, unstaged, or untracked changes.',
        );
      }
      if (inspection.commit !== expectedHead) {
        throw new WorktreeLeaseOperationError(
          'Writer lease HEAD changed before it could be retained.',
        );
      }
      const state = this.store.state;
      await this.store.transact(state.data.revision, (draft) => {
        const current = draft.leases[leaseId];
        if (current === undefined || current.state !== 'active') {
          throw new WorktreeLeaseOperationError(
            'Writer lease changed before it could be retained.',
          );
        }
        mutableLeases(draft)[leaseId] = {
          ...current,
          state: 'retained',
          updatedAt: this.now().toISOString(),
          lastVerifiedHead: inspection.commit,
          lastVerifiedTree: inspection.tree,
        };
      });
      return this.requiredLease(leaseId);
    });
  }

  cleanup(
    leaseId: string,
    expectedHead: string,
  ): Promise<WorktreeLeaseRecord> {
    return this.enqueue(async () => this.cleanupUnlocked(leaseId, expectedHead));
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.tail;
  }

  private async provisionWriterUnlocked(
    request: ProvisionWriterLeaseRequest,
  ): Promise<WorktreeLeaseRecord> {
    this.assertWorkspaceTrusted();
    await this.store.reload();
    this.assertStoreHealthy();

    const existing = Object.values(this.store.state.data.leases).find(
      (lease) =>
        lease.workspaceId === this.workspace.id &&
        lease.assignmentId === request.assignmentId &&
        lease.state !== 'removed',
    );
    if (existing !== undefined) {
      if (
        existing.missionId !== request.missionId ||
        existing.taskId !== request.taskId ||
        existing.ownerProfileId !== request.ownerProfileId ||
        existing.baseCommit !== request.baseCommit ||
        (request.plannedLeaseId !== undefined &&
          existing.leaseId !== request.plannedLeaseId)
      ) {
        throw new WorktreeLeaseOperationError(
          'That assignment already owns a different writer lease.',
        );
      }
      const reconciled = await this.reconcileUnlocked(existing.leaseId);
      if (reconciled.state !== 'provisioning') return reconciled;
      const pending = this.pendingForLease(reconciled.leaseId, 'provision');
      if (pending === undefined) {
        throw new WorktreeLeaseOperationError(
          'Provisioning retry has no exact durable operation journal.',
        );
      }
      const branch = await this.git.tryResolveCommit(
        reconciled.repositoryRoot,
        reconciled.branchRef,
      );
      if (branch !== undefined) {
        // Reconciliation normally recreates an existing exact branch. A
        // remaining provisioning result means it could not prove a safe retry.
        throw new WorktreeLeaseOperationError(
          'Provisioning retry could not reconcile the existing Council branch.',
        );
      }
      if (await pathExists(reconciled.checkoutPath)) {
        throw new WorktreeLeaseOperationError(
          'Provisioning retry path exists without an exact registered worktree.',
        );
      }
      await mkdir(path.dirname(reconciled.checkoutPath), { recursive: true });
      try {
        await this.git.createWriterWorktree({
          repository: this.repositoryForLease(reconciled),
          checkoutPath: reconciled.checkoutPath,
          branchRef: reconciled.branchRef,
          baseCommit: reconciled.baseCommit,
        });
      } catch (error) {
        throw new WorktreeLeaseOperationError(
          `Provisioning retry had an uncertain or failed outcome; its journal remains: ${message(error)}`,
        );
      }
      const inspection = await this.verifyLease(reconciled, true);
      return this.activateProvisionedLease(
        reconciled,
        pending,
        inspection,
        this.store.state.data.revision,
      );
    }
    if (
      request.plannedLeaseId !== undefined &&
      this.store.getLease(request.plannedLeaseId) !== undefined
    ) {
      throw new WorktreeLeaseOperationError(
        'The planned writer lease ID already belongs to another assignment.',
      );
    }

    const repository = await this.git.inspectRepository(
      this.workspace.canonicalPath,
    );
    if (!isFullGitObjectId(request.baseCommit, repository.objectFormat)) {
      throw new WorktreeLeaseOperationError(
        `Writer lease base must be a full ${repository.objectFormat} object ID.`,
      );
    }
    const base = await this.git.resolveCommit(
      repository.repositoryRoot,
      request.baseCommit,
    );
    if (base.commit !== request.baseCommit) {
      throw new WorktreeLeaseOperationError(
        'Writer lease base did not resolve to the exact requested commit.',
      );
    }

    const worktreeRoot = await this.ensureWorktreeRoot();
    const leaseId = request.plannedLeaseId ?? this.makeLeaseId();
    const operationId = this.makeOperationId();
    const leaseToken = this.idToken(leaseId, 'lease_');
    const workspaceToken = createHash('sha256')
      .update(this.workspace.id)
      .digest('hex')
      .slice(0, 12);
    const checkoutParent = await this.ensureOwnedCheckoutParent(
      worktreeRoot,
      workspaceToken,
      leaseToken,
    );
    const checkoutPath = path.join(checkoutParent, 'checkout');
    const branchRef = `refs/heads/council/${workspaceToken}/${leaseToken}`;
    if (await pathExists(checkoutPath)) {
      throw new WorktreeLeaseOperationError(
        'Generated Council checkout path already exists; refusing to adopt it.',
      );
    }
    const createdAt = this.now().toISOString();
    const lease: WorktreeLeaseRecord = {
      leaseId,
      workspaceId: this.workspace.id,
      missionId: request.missionId,
      taskId: request.taskId,
      assignmentId: request.assignmentId,
      ownerProfileId: request.ownerProfileId,
      accessMode: 'workspace-write',
      repositoryRoot: repository.repositoryRoot,
      commonGitDir: repository.commonGitDir,
      objectFormat: repository.objectFormat,
      checkoutPath,
      branchRef,
      baseCommit: base.commit,
      baseTree: base.tree,
      state: 'provisioning',
      createdAt,
      updatedAt: createdAt,
    };
    const pending: PendingWorktreeOperation = {
      operationId,
      kind: 'provision',
      leaseId,
      expectedBranchRef: branchRef,
      expectedCheckoutPath: checkoutPath,
      expectedHead: base.commit,
      createdAt,
    };

    const initialRevision = this.store.state.data.revision;
    await this.store.transact(initialRevision, (draft) => {
      mutableLeases(draft)[leaseId] = lease;
      mutablePending(draft)[operationId] = pending;
    });

    await mkdir(path.dirname(checkoutPath), { recursive: true });
    try {
      await this.git.createWriterWorktree({
        repository,
        checkoutPath,
        branchRef,
        baseCommit: base.commit,
      });
    } catch (error) {
      throw new WorktreeLeaseOperationError(
        `Git worktree provisioning had an uncertain or failed outcome; the durable journal was retained: ${message(error)}`,
      );
    }

    const inspection = await this.verifyLease(lease, true);
    return this.activateProvisionedLease(
      lease,
      pending,
      inspection,
      this.store.state.data.revision,
    );
  }

  private async reconcileUnlocked(leaseId: string): Promise<WorktreeLeaseRecord> {
    this.assertWorkspaceTrusted();
    await this.store.reload();
    this.assertStoreHealthy();
    const lease = this.requiredLease(leaseId);
    this.assertLeaseWorkspace(lease);

    if (lease.state === 'removed' || lease.state === 'blocked') return lease;
    if (lease.state === 'cleanup-pending') {
      const worktrees = await this.git.listWorktrees(lease.repositoryRoot);
      const matches = this.matchingWorktrees(worktrees, lease.checkoutPath);
      const exists = await pathExists(lease.checkoutPath);
      if (matches.length === 0 && !exists) {
        return this.finalizeRemovedLease(lease);
      }
      if (matches.length === 0 || !exists) {
        return this.blockLease(
          lease,
          'Cleanup state is inconsistent between Git registry and filesystem.',
        );
      }
      try {
        await this.verifyLease(lease, false, worktrees);
      } catch (error) {
        return this.blockLease(lease, message(error));
      }
      return lease;
    }

    if (lease.state === 'provisioning') {
      const pending = this.pendingForLease(lease.leaseId, 'provision');
      if (pending === undefined) {
        return this.blockLease(
          lease,
          'Provisioning lease has no durable pending operation.',
        );
      }
      const worktrees = await this.git.listWorktrees(lease.repositoryRoot);
      const matches = this.matchingWorktrees(worktrees, lease.checkoutPath);
      if (matches.length > 0) {
        try {
          const inspection = await this.verifyLease(lease, true, worktrees);
          return this.activateProvisionedLease(
            lease,
            pending,
            inspection,
            this.store.state.data.revision,
          );
        } catch (error) {
          return this.blockLease(lease, message(error));
        }
      }
      if (await pathExists(lease.checkoutPath)) {
        return this.blockLease(
          lease,
          'Provisioning path exists but is not an exact registered Git worktree.',
        );
      }
      const branch = await this.git.tryResolveCommit(
        lease.repositoryRoot,
        lease.branchRef,
      );
      if (branch === undefined) {
        // No Git mutation is proven. Keep the journal for an explicit retry.
        return lease;
      }
      if (
        branch.commit !== lease.baseCommit ||
        branch.tree !== lease.baseTree
      ) {
        return this.blockLease(
          lease,
          'Provisioning branch exists at a different commit.',
        );
      }
      await mkdir(path.dirname(lease.checkoutPath), { recursive: true });
      try {
        await this.git.createExistingBranchWorktree({
          repository: this.repositoryForLease(lease),
          checkoutPath: lease.checkoutPath,
          branchRef: lease.branchRef,
          baseCommit: lease.baseCommit,
        });
        const inspection = await this.verifyLease(lease, true);
        return this.activateProvisionedLease(
          lease,
          pending,
          inspection,
          this.store.state.data.revision,
        );
      } catch (error) {
        throw new WorktreeLeaseOperationError(
          `Provisioning reconciliation remains pending: ${message(error)}`,
        );
      }
    }

    try {
      const inspection = await this.verifyLease(lease, false);
      if (
        lease.state === 'retained' &&
        lease.lastVerifiedHead !== undefined &&
        lease.lastVerifiedHead !== inspection.commit
      ) {
        return this.blockLease(
          lease,
          'Retained lease HEAD changed after its handoff boundary.',
        );
      }
      const state = this.store.state;
      if (
        lease.lastVerifiedHead !== inspection.commit ||
        lease.lastVerifiedTree !== inspection.tree
      ) {
        await this.store.transact(state.data.revision, (draft) => {
          const current = draft.leases[leaseId];
          if (current === undefined || current.state !== lease.state) {
            throw new WorktreeLeaseOperationError(
              'Lease changed while reconciliation was verifying it.',
            );
          }
          mutableLeases(draft)[leaseId] = {
            ...current,
            updatedAt: this.now().toISOString(),
            lastVerifiedHead: inspection.commit,
            lastVerifiedTree: inspection.tree,
          };
        });
      }
      return this.requiredLease(leaseId);
    } catch (error) {
      return this.blockLease(lease, message(error));
    }
  }

  private async cleanupUnlocked(
    leaseId: string,
    expectedHead: string,
  ): Promise<WorktreeLeaseRecord> {
    const lease = await this.reconcileUnlocked(leaseId);
    if (lease.state === 'removed') return lease;
    if (lease.state === 'cleanup-pending') {
      const existingPending = this.pendingForLease(leaseId, 'cleanup');
      if (
        existingPending === undefined ||
        existingPending.expectedHead !== expectedHead
      ) {
        throw new WorktreeLeaseOperationError(
          'Pending cleanup does not match the expected retained HEAD.',
        );
      }
      const pendingInspection = await this.verifyLease(lease, false);
      if (!pendingInspection.clean || pendingInspection.commit !== expectedHead) {
        throw new WorktreeLeaseOperationError(
          'Pending cleanup target is dirty or changed; no removal was retried.',
        );
      }
      return this.executeCleanup(lease);
    }
    if (lease.state !== 'retained') {
      throw new WorktreeLeaseOperationError(
        'Only a retained lease can be physically cleaned up.',
      );
    }
    const inspection = await this.verifyLease(lease, false);
    if (!inspection.clean) {
      throw new WorktreeLeaseOperationError(
        'Refusing to remove a dirty Council worktree.',
      );
    }
    if (
      inspection.commit !== expectedHead ||
      lease.lastVerifiedHead !== expectedHead
    ) {
      throw new WorktreeLeaseOperationError(
        'Refusing cleanup because the exact retained HEAD changed.',
      );
    }
    const operationId = this.makeOperationId();
    const createdAt = this.now().toISOString();
    const pending: PendingWorktreeOperation = {
      operationId,
      kind: 'cleanup',
      leaseId,
      expectedBranchRef: lease.branchRef,
      expectedCheckoutPath: lease.checkoutPath,
      expectedHead,
      createdAt,
    };
    const revision = this.store.state.data.revision;
    await this.store.transact(revision, (draft) => {
      const current = draft.leases[leaseId];
      if (
        current === undefined ||
        current.state !== 'retained' ||
        current.lastVerifiedHead !== expectedHead
      ) {
        throw new WorktreeLeaseOperationError(
          'Lease changed before cleanup could be journaled.',
        );
      }
      mutableLeases(draft)[leaseId] = {
        ...current,
        state: 'cleanup-pending',
        updatedAt: createdAt,
      };
      mutablePending(draft)[operationId] = pending;
    });
    return this.executeCleanup(this.requiredLease(leaseId));
  }

  private async executeCleanup(
    lease: WorktreeLeaseRecord,
  ): Promise<WorktreeLeaseRecord> {
    try {
      await this.git.removeWorktree(
        lease.repositoryRoot,
        lease.checkoutPath,
      );
    } catch (error) {
      throw new WorktreeLeaseOperationError(
        `Git cleanup had an uncertain or failed outcome; no force removal was attempted and the journal remains: ${message(error)}`,
      );
    }
    const worktrees = await this.git.listWorktrees(lease.repositoryRoot);
    if (
      this.matchingWorktrees(worktrees, lease.checkoutPath).length !== 0 ||
      (await pathExists(lease.checkoutPath))
    ) {
      throw new WorktreeLeaseOperationError(
        'Git reported cleanup success but the exact worktree still exists; journal retained.',
      );
    }
    return this.finalizeRemovedLease(this.requiredLease(lease.leaseId));
  }

  private async verifyLease(
    lease: WorktreeLeaseRecord,
    requireBase: boolean,
    knownWorktrees?: readonly GitWorktreeEntry[] | undefined,
  ): Promise<GitCheckoutInspection> {
    const worktrees =
      knownWorktrees ?? (await this.git.listWorktrees(lease.repositoryRoot));
    const matches = this.matchingWorktrees(worktrees, lease.checkoutPath);
    if (matches.length !== 1) {
      throw new WorktreeLeaseOperationError(
        matches.length === 0
          ? 'Exact lease path is absent from the Git worktree registry.'
          : 'Exact lease path is ambiguous in the Git worktree registry.',
      );
    }
    const registered = matches[0]!;
    if (
      registered.branchRef !== lease.branchRef ||
      registered.head === undefined
    ) {
      throw new WorktreeLeaseOperationError(
        'Registered worktree branch identity does not match the lease.',
      );
    }
    const inspection = await this.git.inspectCheckout(lease.checkoutPath);
    if (
      this.pathIdentity(inspection.checkoutPath) !==
        this.pathIdentity(lease.checkoutPath) ||
      this.pathIdentity(inspection.commonGitDir) !==
        this.pathIdentity(lease.commonGitDir) ||
      inspection.branchRef !== lease.branchRef ||
      inspection.commit !== registered.head
    ) {
      throw new WorktreeLeaseOperationError(
        'Checkout identity does not match its durable lease and Git registry.',
      );
    }
    if (
      requireBase &&
      (inspection.commit !== lease.baseCommit ||
        inspection.tree !== lease.baseTree ||
        !inspection.clean)
    ) {
      throw new WorktreeLeaseOperationError(
        'Newly provisioned worktree is not the exact clean base commit.',
      );
    }
    if (
      !requireBase &&
      !(await this.git.isAncestor(
        lease.repositoryRoot,
        lease.baseCommit,
        inspection.commit,
      ))
    ) {
      throw new WorktreeLeaseOperationError(
        'Lease HEAD no longer descends from its exact base commit.',
      );
    }
    return inspection;
  }

  private async activateProvisionedLease(
    lease: WorktreeLeaseRecord,
    pending: PendingWorktreeOperation,
    inspection: GitCheckoutInspection,
    expectedRevision: number,
  ): Promise<WorktreeLeaseRecord> {
    await this.store.transact(expectedRevision, (draft) => {
      const current = draft.leases[lease.leaseId];
      const currentPending = draft.pendingOperations[pending.operationId];
      if (
        current === undefined ||
        current.state !== 'provisioning' ||
        currentPending?.leaseId !== lease.leaseId ||
        currentPending.kind !== 'provision'
      ) {
        throw new WorktreeLeaseOperationError(
          'Provisioning journal changed before activation.',
        );
      }
      mutableLeases(draft)[lease.leaseId] = {
        ...current,
        state: 'active',
        updatedAt: this.now().toISOString(),
        lastVerifiedHead: inspection.commit,
        lastVerifiedTree: inspection.tree,
      };
      delete mutablePending(draft)[pending.operationId];
    });
    return this.requiredLease(lease.leaseId);
  }

  private async blockLease(
    lease: WorktreeLeaseRecord,
    reason: string,
  ): Promise<WorktreeLeaseRecord> {
    const state = this.store.state;
    await this.store.transact(state.data.revision, (draft) => {
      const current = draft.leases[lease.leaseId];
      if (current === undefined) {
        throw new WorktreeLeaseOperationError('Lease disappeared while being blocked.');
      }
      mutableLeases(draft)[lease.leaseId] = {
        ...current,
        state: 'blocked',
        updatedAt: this.now().toISOString(),
        blockedReason: reason.slice(0, 2_000),
      };
      for (const [operationId, pending] of Object.entries(
        draft.pendingOperations,
      )) {
        if (pending.leaseId === lease.leaseId) {
          delete mutablePending(draft)[operationId];
        }
      }
    });
    return this.requiredLease(lease.leaseId);
  }

  private async finalizeRemovedLease(
    lease: WorktreeLeaseRecord,
  ): Promise<WorktreeLeaseRecord> {
    const state = this.store.state;
    await this.store.transact(state.data.revision, (draft) => {
      const current = draft.leases[lease.leaseId];
      if (current === undefined) {
        throw new WorktreeLeaseOperationError(
          'Lease disappeared while cleanup was being finalized.',
        );
      }
      mutableLeases(draft)[lease.leaseId] = {
        ...current,
        state: 'removed',
        updatedAt: this.now().toISOString(),
      };
      for (const [operationId, pending] of Object.entries(
        draft.pendingOperations,
      )) {
        if (pending.leaseId === lease.leaseId) {
          delete mutablePending(draft)[operationId];
        }
      }
    });
    return this.requiredLease(lease.leaseId);
  }

  private pendingForLease(
    leaseId: string,
    kind: PendingWorktreeOperation['kind'],
  ): PendingWorktreeOperation | undefined {
    return Object.values(this.store.state.data.pendingOperations).find(
      (pending) => pending.leaseId === leaseId && pending.kind === kind,
    );
  }

  private requiredLease(leaseId: string): WorktreeLeaseRecord {
    const lease = this.store.getLease(leaseId);
    if (lease === undefined) {
      throw new WorktreeLeaseOperationError(`Unknown worktree lease "${leaseId}".`);
    }
    return lease;
  }

  private assertStoreHealthy(): void {
    if (this.store.problem !== undefined) {
      throw new WorktreeLeaseOperationError(
        `Worktree lease store is unreadable or malformed: ${this.store.problem.message}`,
      );
    }
  }

  private assertWorkspaceTrusted(): void {
    if (!this.workspace.trusted) {
      throw new WorktreeLeaseOperationError(
        'Worktree leases require an explicitly trusted workspace.',
      );
    }
  }

  private assertLeaseWorkspace(lease: WorktreeLeaseRecord): void {
    if (lease.workspaceId !== this.workspace.id) {
      throw new WorktreeLeaseOperationError(
        'Lease does not belong to the active workspace.',
      );
    }
  }

  private repositoryForLease(
    lease: WorktreeLeaseRecord,
  ): GitRepositoryIdentity {
    return {
      repositoryRoot: lease.repositoryRoot,
      commonGitDir: lease.commonGitDir,
      objectFormat: lease.objectFormat,
      headCommit: lease.baseCommit,
      headTree: lease.baseTree,
    };
  }

  private matchingWorktrees(
    worktrees: readonly GitWorktreeEntry[],
    checkoutPath: string,
  ): readonly GitWorktreeEntry[] {
    const identity = this.pathIdentity(checkoutPath);
    return worktrees.filter(
      (entry) => this.pathIdentity(entry.path) === identity,
    );
  }

  private pathIdentity(value: string): string {
    const api = this.platform === 'win32' ? path.win32 : path.posix;
    const normalized = api.normalize(value);
    return this.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  }

  private async ensureWorktreeRoot(): Promise<string> {
    await mkdir(this.configuredWorktreeRoot, { recursive: true });
    return realpath(this.configuredWorktreeRoot);
  }

  /**
   * Creates the owned parent of a generated checkout and proves it stays inside
   * the resolved Council worktree root. `path.join` is lexical, so a symlink or
   * junction planted at an intermediate segment would otherwise redirect a
   * Council-owned worktree outside the root before any Git mutation.
   */
  private async ensureOwnedCheckoutParent(
    worktreeRoot: string,
    workspaceToken: string,
    leaseToken: string,
  ): Promise<string> {
    const expected = path.join(worktreeRoot, workspaceToken, leaseToken);
    await mkdir(expected, { recursive: true });
    let resolved: string;
    try {
      resolved = await realpath(expected);
    } catch (error) {
      throw new WorktreeLeaseOperationError(
        `Council worktree parent could not be resolved: ${message(error)}`,
      );
    }
    if (this.pathIdentity(resolved) !== this.pathIdentity(expected)) {
      throw new WorktreeLeaseOperationError(
        'Generated Council checkout escaped its owned worktree root.',
      );
    }
    return resolved;
  }

  private idToken(value: string, prefix: string): string {
    if (!value.startsWith(prefix)) {
      throw new WorktreeLeaseOperationError(
        `ID generator returned an invalid ${prefix.slice(0, -1)} ID.`,
      );
    }
    const token = value.slice(prefix.length);
    if (!/^[0-9a-f]{32}$/.test(token)) {
      throw new WorktreeLeaseOperationError(
        `ID generator returned an invalid ${prefix.slice(0, -1)} ID.`,
      );
    }
    return token;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(
        new WorktreeLeaseOperationError(
          'Council is shutting down; no worktree operation was admitted.',
        ),
      );
    }
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
