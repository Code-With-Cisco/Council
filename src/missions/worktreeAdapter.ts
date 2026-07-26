import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { GitPort } from '../git/contracts.js';
import {
  WorktreeLeaseManager,
  type ProvisionWriterLeaseRequest,
} from '../orchestration/worktrees/leaseManager.js';
import type { WorktreeLeaseStore } from '../orchestration/worktrees/leaseStore.js';
import type {
  MissionWorktreePort,
  ProvisionedWorktreeLease,
} from './coordinator.js';
import type { WorktreeLeasePreview } from './types.js';

interface PlannedLease {
  readonly request: {
    readonly missionId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly baseCommitSha: string;
    readonly baseTreeSha: string;
  };
  readonly preview: WorktreeLeasePreview;
}

export interface MissionWorktreeAdapterOptions {
  readonly git: GitPort;
  readonly manager: WorktreeLeaseManager;
  readonly store: WorktreeLeaseStore;
  readonly workspace: {
    readonly id: string;
    readonly canonicalPath: string;
    readonly trusted: boolean;
  };
  /** Canonical Council-owned root created under Electron userData. */
  readonly worktreeRoot: string;
  readonly createLeaseId?: (() => string) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') ===
        normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function samePlan(
  left: PlannedLease['request'],
  right: PlannedLease['request'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function leaseToken(leaseId: string): string {
  const match = /^lease_([0-9a-f]{32})$/.exec(leaseId);
  if (match?.[1] === undefined) {
    throw new Error('Generated Mission lease ID is invalid.');
  }
  return match[1];
}

/** Bridges the Mission preview contract to the durable writer lease manager. */
export class MissionWorktreeAdapter implements MissionWorktreePort {
  private readonly plans = new Map<string, PlannedLease>();
  private readonly platform: NodeJS.Platform;
  private readonly createLeaseId: () => string;

  constructor(private readonly options: MissionWorktreeAdapterOptions) {
    if (
      !path.isAbsolute(options.worktreeRoot) ||
      !path.isAbsolute(options.workspace.canonicalPath)
    ) {
      throw new TypeError('Mission worktree paths must be absolute.');
    }
    this.platform = options.platform ?? process.platform;
    this.createLeaseId =
      options.createLeaseId ??
      (() => `lease_${randomUUID().replaceAll('-', '')}`);
  }

  async previewLease(request: {
    readonly missionId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly baseCommitSha: string;
    readonly baseTreeSha: string;
  }): Promise<WorktreeLeasePreview> {
    if (
      !this.options.workspace.trusted ||
      request.workspaceId !== this.options.workspace.id
    ) {
      throw new Error('Mission writer lease belongs to an untrusted workspace.');
    }
    const repository = await this.options.git.inspectRepository(
      this.options.workspace.canonicalPath,
    );
    const base = await this.options.git.resolveCommit(
      repository.repositoryRoot,
      request.baseCommitSha,
    );
    if (
      base.commit !== request.baseCommitSha ||
      base.tree !== request.baseTreeSha
    ) {
      throw new Error(
        'Mission lease preview no longer matches the exact repository base.',
      );
    }
    const existing = [...this.plans.values()].find((plan) =>
      samePlan(plan.request, request),
    );
    if (existing !== undefined) {
      return { ...existing.preview };
    }
    const leaseId = this.createLeaseId();
    const token = leaseToken(leaseId);
    const workspaceToken = createHash('sha256')
      .update(this.options.workspace.id)
      .digest('hex')
      .slice(0, 12);
    const canonicalPath = path.join(
      this.options.worktreeRoot,
      workspaceToken,
      token,
      'checkout',
    );
    const preview: WorktreeLeasePreview = {
      taskId: request.taskId,
      leaseId,
      branchName: `refs/heads/council/${workspaceToken}/${token}`,
      canonicalPath,
      baseCommitSha: base.commit,
      baseTreeSha: base.tree,
      available: true,
    };
    this.plans.set(leaseId, {
      request: { ...request },
      preview,
    });
    return preview;
  }

  async provisionLease(
    preview: WorktreeLeasePreview,
    assignmentId: string,
  ): Promise<ProvisionedWorktreeLease> {
    let planned = this.plans.get(preview.leaseId);
    this.plans.delete(preview.leaseId);
    if (planned === undefined) {
      await this.options.store.reload();
      if (this.options.store.problem !== undefined) {
        throw new Error(
          `Worktree lease authority is unavailable: ${this.options.store.problem.message}`,
        );
      }
      const durable = this.options.store.getLease(preview.leaseId);
      if (
        durable !== undefined &&
        durable.workspaceId === this.options.workspace.id &&
        durable.assignmentId === assignmentId &&
        durable.taskId === preview.taskId &&
        durable.branchRef === preview.branchName &&
        samePath(
          durable.checkoutPath,
          preview.canonicalPath,
          this.platform,
        ) &&
        durable.baseCommit === preview.baseCommitSha &&
        durable.baseTree === preview.baseTreeSha &&
        durable.state !== 'removed'
      ) {
        planned = {
          request: {
            missionId: durable.missionId,
            taskId: durable.taskId,
            workspaceId: durable.workspaceId,
            profileId: durable.ownerProfileId,
            baseCommitSha: durable.baseCommit,
            baseTreeSha: durable.baseTree,
          },
          preview: { ...preview },
        };
      }
    }
    if (
      planned === undefined ||
      !samePlan(planned.request, {
        missionId: planned.request.missionId,
        taskId: preview.taskId,
        workspaceId: planned.request.workspaceId,
        profileId: planned.request.profileId,
        baseCommitSha: preview.baseCommitSha,
        baseTreeSha: preview.baseTreeSha,
      }) ||
      JSON.stringify(planned.preview) !== JSON.stringify(preview)
    ) {
      throw new Error(
        'Mission worktree preview is unknown, changed, or already used.',
      );
    }
    const request: ProvisionWriterLeaseRequest = {
      missionId: planned.request.missionId,
      taskId: planned.request.taskId,
      assignmentId,
      ownerProfileId: planned.request.profileId,
      baseCommit: planned.request.baseCommitSha,
      plannedLeaseId: planned.preview.leaseId,
    };
    const lease = await this.options.manager.provisionWriter(request);
    if (
      lease.leaseId !== preview.leaseId ||
      lease.taskId !== preview.taskId ||
      lease.branchRef !== preview.branchName ||
      !samePath(lease.checkoutPath, preview.canonicalPath, this.platform) ||
      lease.baseCommit !== preview.baseCommitSha ||
      lease.baseTree !== preview.baseTreeSha ||
      lease.assignmentId !== assignmentId ||
      lease.ownerProfileId !== planned.request.profileId ||
      lease.accessMode !== 'workspace-write' ||
      lease.state !== 'active'
    ) {
      throw new Error(
        'Provisioned writer lease does not match its exact Mission preview.',
      );
    }
    return {
      leaseId: lease.leaseId,
      taskId: lease.taskId,
      assignmentId: lease.assignmentId,
      ownerProfileId: lease.ownerProfileId,
      accessMode: lease.accessMode,
      branchName: lease.branchRef,
      canonicalPath: lease.checkoutPath,
      baseCommitSha: lease.baseCommit,
      baseTreeSha: lease.baseTree,
    };
  }

  async authorizesLaunch(
    profileId: string,
    canonicalCwd: string,
  ): Promise<boolean> {
    await this.options.store.reload();
    if (this.options.store.problem !== undefined) return false;
    return Object.values(this.options.store.state.data.leases).some(
      (lease) =>
        lease.workspaceId === this.options.workspace.id &&
        lease.ownerProfileId === profileId &&
        lease.accessMode === 'workspace-write' &&
        lease.state === 'active' &&
        samePath(lease.checkoutPath, canonicalCwd, this.platform),
    );
  }
}
