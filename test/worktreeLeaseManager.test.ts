import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CreateDetachedWorktreeRequest,
  CreateWriterWorktreeRequest,
  FastForwardCheckoutRequest,
  GitCheckoutInspection,
  GitCommitIdentity,
  GitPort,
  GitRepositoryIdentity,
  GitWorktreeEntry,
  PinCouncilHandoffRefRequest,
} from '../src/git/contracts.js';
import {
  WorktreeLeaseManager,
  WorktreeLeaseOperationError,
} from '../src/orchestration/worktrees/leaseManager.js';
import { WorktreeLeaseStore } from '../src/orchestration/worktrees/leaseStore.js';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const LEASE_ID = `lease_${'1'.repeat(32)}`;
const OPERATION_ID = `leaseop_${'2'.repeat(32)}`;
const temporaryDirectories: string[] = [];

class FakeGit implements GitPort {
  readonly worktrees = new Map<string, GitCheckoutInspection>();
  readonly branches = new Map<string, GitCommitIdentity>();
  readonly removeCalls: string[] = [];
  createCalls = 0;
  onCreate: (() => Promise<void>) | undefined;
  failAfterCreate = false;
  failRemoveBeforeMutation = false;

  constructor(readonly repository: GitRepositoryIdentity) {}

  async inspectRepository(): Promise<GitRepositoryIdentity> {
    return this.repository;
  }

  async resolveCommit(
    _checkoutPath: string,
    revision: string,
  ): Promise<GitCommitIdentity> {
    if (revision === HEAD || revision === 'HEAD') {
      return { commit: HEAD, tree: TREE };
    }
    const branch = this.branches.get(revision);
    if (branch !== undefined) return branch;
    throw new Error('unknown revision');
  }

  async tryResolveCommit(
    _checkoutPath: string,
    revision: string,
  ): Promise<GitCommitIdentity | undefined> {
    return this.branches.get(revision);
  }

  async inspectCheckout(
    checkoutPath: string,
  ): Promise<GitCheckoutInspection> {
    const inspection = this.worktrees.get(checkoutPath);
    if (inspection === undefined) throw new Error('missing checkout');
    return { ...inspection, statusEntries: [...inspection.statusEntries] };
  }

  async listWorktrees(): Promise<readonly GitWorktreeEntry[]> {
    return [...this.worktrees.values()].map((inspection) => ({
      path: inspection.checkoutPath,
      head: inspection.commit,
      branchRef: inspection.branchRef,
      detached: inspection.branchRef === undefined,
      bare: false,
      lockedReason: undefined,
      prunableReason: undefined,
    }));
  }

  async createWriterWorktree(
    request: CreateWriterWorktreeRequest,
  ): Promise<void> {
    this.createCalls += 1;
    await this.onCreate?.();
    await this.create(request);
    if (this.failAfterCreate) throw new Error('lost acknowledgement');
  }

  async createExistingBranchWorktree(
    request: CreateWriterWorktreeRequest,
  ): Promise<void> {
    await this.create(request);
  }

  async createDetachedWorktree(
    _request: CreateDetachedWorktreeRequest,
  ): Promise<void> {
    throw new Error('not used by lease-manager tests');
  }

  async pinCouncilHandoffRef(
    _request: PinCouncilHandoffRefRequest,
  ): Promise<void> {
    throw new Error('not used by lease-manager tests');
  }

  async fastForwardCheckout(
    _request: FastForwardCheckoutRequest,
  ): Promise<GitCheckoutInspection> {
    throw new Error('not used by lease-manager tests');
  }

  async removeWorktree(
    _repositoryRoot: string,
    checkoutPath: string,
  ): Promise<void> {
    this.removeCalls.push(checkoutPath);
    if (this.failRemoveBeforeMutation) throw new Error('worktree is locked');
    this.worktrees.delete(checkoutPath);
    await rm(checkoutPath, { recursive: true });
  }

  async isAncestor(): Promise<boolean> {
    return true;
  }

  setDirty(checkoutPath: string, dirty: boolean): void {
    const inspection = this.worktrees.get(checkoutPath);
    if (inspection === undefined) throw new Error('missing checkout');
    this.worktrees.set(checkoutPath, {
      ...inspection,
      clean: !dirty,
      statusEntries: dirty ? ['? dirty.txt'] : [],
    });
  }

  setBranch(checkoutPath: string, branchRef: string): void {
    const inspection = this.worktrees.get(checkoutPath);
    if (inspection === undefined) throw new Error('missing checkout');
    this.worktrees.set(checkoutPath, { ...inspection, branchRef });
  }

  private async create(request: CreateWriterWorktreeRequest): Promise<void> {
    await mkdir(request.checkoutPath, { recursive: true });
    this.branches.set(request.branchRef, { commit: HEAD, tree: TREE });
    this.worktrees.set(request.checkoutPath, {
      checkoutPath: request.checkoutPath,
      commonGitDir: this.repository.commonGitDir,
      branchRef: request.branchRef,
      commit: HEAD,
      tree: TREE,
      clean: true,
      statusEntries: [],
    });
  }
}

function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

interface Fixture {
  readonly directory: string;
  readonly store: WorktreeLeaseStore;
  readonly git: FakeGit;
  readonly manager: WorktreeLeaseManager;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'council-lease-manager-'));
  temporaryDirectories.push(directory);
  const repositoryRoot = path.join(directory, 'repo');
  const commonGitDir = path.join(repositoryRoot, '.git');
  await mkdir(commonGitDir, { recursive: true });
  const store = new WorktreeLeaseStore(
    path.join(directory, 'user-data', 'worktree-leases.json'),
  );
  await store.load();
  const git = new FakeGit({
    repositoryRoot,
    commonGitDir,
    objectFormat: 'sha1',
    headCommit: HEAD,
    headTree: TREE,
  });
  const manager = new WorktreeLeaseManager({
    git,
    store,
    workspace: {
      id: 'ws-fixture',
      canonicalPath: repositoryRoot,
      trusted: true,
    },
    worktreeRoot: path.join(directory, 'user-data', 'worktrees'),
    now: () => new Date('2026-07-26T20:00:00.000Z'),
    leaseId: () => LEASE_ID,
    operationId: () => OPERATION_ID,
  });
  return { directory, store, git, manager };
}

function request() {
  return {
    missionId: 'mission-fixture',
    taskId: 'task-fixture',
    assignmentId: 'assignment-fixture',
    ownerProfileId: 'profile-fixture-builder',
    baseCommit: HEAD,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('WorktreeLeaseManager', () => {
  it('journals before Git mutation and activates only after exact verification', async () => {
    const { store, git, manager } = await fixture();
    git.onCreate = async () => {
      const state = await store.reload();
      expect(Object.values(state.data.leases)[0]?.state).toBe('provisioning');
      expect(Object.values(state.data.pendingOperations)[0]?.kind).toBe(
        'provision',
      );
    };

    const lease = await manager.provisionWriter(request());

    expect(lease.state).toBe('active');
    expect(lease.branchRef).toMatch(/^refs\/heads\/council\//);
    expect(lease.lastVerifiedHead).toBe(HEAD);
    expect(lease.lastVerifiedTree).toBe(TREE);
    expect(store.state.data.pendingOperations).toEqual({});
  });

  it('refuses a worktree root segment redirected by a symlink', async () => {
    const { directory, git, manager } = await fixture();
    const workspaceToken = createHash('sha256')
      .update('ws-fixture')
      .digest('hex')
      .slice(0, 12);
    const worktreeRoot = path.join(directory, 'user-data', 'worktrees');
    const outside = path.join(directory, 'outside');
    await mkdir(outside, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    await symlink(outside, path.join(worktreeRoot, workspaceToken), 'dir');

    await expect(manager.provisionWriter(request())).rejects.toThrow(
      /escaped its owned worktree root/,
    );
    expect(git.createCalls).toBe(0);
    expect(await pathExists(path.join(outside, 'checkout'))).toBe(false);
  });

  it('serializes duplicate assignment requests into one writer lease', async () => {
    const { git, manager } = await fixture();

    const [first, second] = await Promise.all([
      manager.provisionWriter(request()),
      manager.provisionWriter(request()),
    ]);

    expect(first.leaseId).toBe(second.leaseId);
    expect(git.createCalls).toBe(1);
  });

  it('recovers a worktree created before a lost Git acknowledgement', async () => {
    const { directory, store, git, manager } = await fixture();
    git.failAfterCreate = true;

    await expect(manager.provisionWriter(request())).rejects.toThrow(
      /journal was retained/,
    );
    expect(store.getLease(LEASE_ID)?.state).toBe('provisioning');
    expect(Object.values(store.state.data.pendingOperations)).toHaveLength(1);

    git.failAfterCreate = false;
    const restartedStore = new WorktreeLeaseStore(
      path.join(directory, 'user-data', 'worktree-leases.json'),
    );
    await restartedStore.load();
    const restarted = new WorktreeLeaseManager({
      git,
      store: restartedStore,
      workspace: {
        id: 'ws-fixture',
        canonicalPath: git.repository.repositoryRoot,
        trusted: true,
      },
      worktreeRoot: path.join(directory, 'user-data', 'worktrees'),
      now: () => new Date('2026-07-26T20:01:00.000Z'),
    });

    const recovered = await restarted.reconcile(LEASE_ID);
    expect(recovered.state).toBe('active');
    expect(restartedStore.state.data.pendingOperations).toEqual({});
  });

  it('blocks a registered branch identity mismatch instead of adopting it', async () => {
    const { git, manager } = await fixture();
    const lease = await manager.provisionWriter(request());
    git.setBranch(lease.checkoutPath, 'refs/heads/user-owned');

    const reconciled = await manager.reconcile(lease.leaseId);

    expect(reconciled.state).toBe('blocked');
    expect(reconciled.blockedReason).toMatch(/branch identity/);
  });

  it('refuses dirty cleanup and removes only a retained exact clean worktree', async () => {
    const { git, manager } = await fixture();
    const active = await manager.provisionWriter(request());
    const retained = await manager.retain(active.leaseId, HEAD);
    git.setDirty(retained.checkoutPath, true);

    await expect(manager.cleanup(retained.leaseId, HEAD)).rejects.toThrow(
      /dirty Council worktree/,
    );
    expect(git.removeCalls).toEqual([]);

    git.setDirty(retained.checkoutPath, false);
    const removed = await manager.cleanup(retained.leaseId, HEAD);
    expect(removed.state).toBe('removed');
    expect(git.removeCalls).toEqual([retained.checkoutPath]);
  });

  it('refuses cleanup before retention and preserves worktrees on shutdown', async () => {
    const { git, manager } = await fixture();
    const active = await manager.provisionWriter(request());

    await expect(manager.cleanup(active.leaseId, HEAD)).rejects.toBeInstanceOf(
      WorktreeLeaseOperationError,
    );
    await manager.shutdown();

    expect(git.worktrees.has(active.checkoutPath)).toBe(true);
    expect(git.removeCalls).toEqual([]);
    await expect(manager.reconcile(active.leaseId)).rejects.toThrow(
      /shutting down/,
    );
  });

  it('retains a cleanup journal and safely retries only the exact clean target', async () => {
    const { store, git, manager } = await fixture();
    const active = await manager.provisionWriter(request());
    const retained = await manager.retain(active.leaseId, HEAD);
    git.failRemoveBeforeMutation = true;

    await expect(manager.cleanup(retained.leaseId, HEAD)).rejects.toThrow(
      /journal remains/,
    );
    expect(store.getLease(retained.leaseId)?.state).toBe('cleanup-pending');
    expect(Object.values(store.state.data.pendingOperations)[0]?.kind).toBe(
      'cleanup',
    );

    git.failRemoveBeforeMutation = false;
    const removed = await manager.cleanup(retained.leaseId, HEAD);
    expect(removed.state).toBe('removed');
    expect(git.removeCalls).toEqual([
      retained.checkoutPath,
      retained.checkoutPath,
    ]);
  });
});
