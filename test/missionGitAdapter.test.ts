import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeGitPort } from '../src/git/client.js';
import {
  MissionGitAdapter,
  missionHandoffRef,
} from '../src/missions/gitAdapter.js';
import type {
  HandoffRecord,
  WorktreeLeaseRecord as MissionLease,
} from '../src/missions/types.js';
import { WorktreeLeaseManager } from '../src/orchestration/worktrees/leaseManager.js';
import { WorktreeLeaseStore } from '../src/orchestration/worktrees/leaseStore.js';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'council-mission-git-'),
  );
  temporaryDirectories.push(directory);
  const selectedRepositoryRoot = path.join(directory, 'repository');
  await mkdir(selectedRepositoryRoot, { recursive: true });
  const repositoryRoot = await realpath(selectedRepositoryRoot);
  await execute('git', ['init', '-b', 'main'], { cwd: repositoryRoot });
  // Git for Windows sets core.autocrlf=true system-wide, which would rewrite
  // LF to CRLF on checkout and make content assertions depend on the host's
  // Git configuration rather than on what the adapter did.
  await execute('git', ['config', 'core.autocrlf', 'false'], { cwd: repositoryRoot });
  await writeFile(path.join(repositoryRoot, 'result.txt'), 'base\n', 'utf8');
  await execute('git', ['add', 'result.txt'], { cwd: repositoryRoot });
  await execute(
    'git',
    [
      '-c',
      'user.name=Council Test',
      '-c',
      'user.email=council-test@example.invalid',
      'commit',
      '-m',
      'base',
    ],
    { cwd: repositoryRoot },
  );

  const git = new NodeGitPort({ timeoutMs: 10_000 });
  const store = new WorktreeLeaseStore(
    path.join(directory, 'worktree-leases.json'),
  );
  await store.load();
  const workspace = {
    id: 'workspace-test',
    canonicalPath: repositoryRoot,
    trusted: true,
  } as const;
  let leaseSequence = 0;
  const leases = new WorktreeLeaseManager({
    git,
    store,
    workspace,
    worktreeRoot: path.join(directory, 'writer-worktrees'),
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    leaseId: () => {
      leaseSequence += 1;
      return `lease_${String(leaseSequence).padStart(32, '0')}`;
    },
    operationId: () =>
      `leaseop_${String(leaseSequence).padStart(32, '0')}`,
  });
  const adapter = new MissionGitAdapter({ git, leases, workspace });
  return { directory, repositoryRoot, git, store, leases, adapter };
}

function missionLease(
  owned: Awaited<ReturnType<WorktreeLeaseManager['provisionWriter']>>,
  overrides: Partial<MissionLease> = {},
): MissionLease {
  return {
    id: owned.leaseId,
    missionId: owned.missionId,
    taskId: owned.taskId,
    workspaceId: owned.workspaceId,
    assignmentId: owned.assignmentId,
    ownerProfileId: owned.ownerProfileId,
    accessMode: owned.accessMode,
    branchName: owned.branchRef,
    canonicalPath: owned.checkoutPath,
    baseCommitSha: owned.baseCommit,
    baseTreeSha: owned.baseTree,
    state: 'ready',
    createdAt: owned.createdAt,
    updatedAt: owned.updatedAt,
    ...overrides,
  };
}

describe('MissionGitAdapter', () => {
  it('pins a clean owned exact-commit handoff and fast-forwards only that candidate', async () => {
    const f = await fixture();
    const target = await f.adapter.inspectTarget({
      workspaceId: 'workspace-test',
    });
    const owned = await f.leases.provisionWriter({
      missionId: 'mission_12345678',
      taskId: 'task_12345678',
      assignmentId: 'execution_12345678',
      ownerProfileId: 'profile-builder01',
      baseCommit: target.commitSha,
    });
    await writeFile(
      path.join(owned.checkoutPath, 'result.txt'),
      'candidate\n',
      'utf8',
    );
    await execute('git', ['add', 'result.txt'], { cwd: owned.checkoutPath });
    await execute(
      'git',
      [
        '-c',
        'user.name=Council Test',
        '-c',
        'user.email=council-test@example.invalid',
        'commit',
        '-m',
        'candidate',
      ],
      { cwd: owned.checkoutPath },
    );
    const candidate = await f.git.resolveCommit(owned.checkoutPath, 'HEAD');
    const lease = missionLease(owned);

    const verified = await f.adapter.verifyHandoff({
      workspaceId: 'workspace-test',
      missionId: owned.missionId,
      taskId: owned.taskId,
      lease,
      claimedCommitSha: candidate.commit,
      claimedTreeSha: candidate.tree,
    });

    expect(verified).toEqual({
      baseCommitSha: target.commitSha,
      commitSha: candidate.commit,
      treeSha: candidate.tree,
    });
    expect(f.store.state.data.leases[owned.leaseId]).toMatchObject({
      state: 'retained',
      lastVerifiedHead: candidate.commit,
      lastVerifiedTree: candidate.tree,
    });
    const ref = missionHandoffRef({
      workspaceId: owned.workspaceId,
      missionId: owned.missionId,
      taskId: owned.taskId,
      commitSha: candidate.commit,
    });
    expect(
      await f.git.resolveCommit(f.repositoryRoot, ref),
    ).toEqual(candidate);

    const handoff: HandoffRecord = {
      id: 'handoff_12345678',
      missionId: owned.missionId,
      taskId: owned.taskId,
      workspaceId: owned.workspaceId,
      executionId: 'execution_12345678',
      leaseId: owned.leaseId,
      baseCommitSha: target.commitSha,
      commitSha: candidate.commit,
      treeSha: candidate.tree,
      summary: 'Candidate',
      evidence: [],
      risks: [],
      createdAt: '2026-07-26T12:00:00.000Z',
    };
    const built = await f.adapter.buildCandidate({
      workspaceId: owned.workspaceId,
      missionId: owned.missionId,
      target,
      handoffs: [handoff],
    });
    expect(built).toEqual({
      targetRef: 'refs/heads/main',
      baseCommitSha: target.commitSha,
      baseTreeSha: target.treeSha,
      commitSha: candidate.commit,
      treeSha: candidate.tree,
    });

    const integrated = await f.adapter.integrateCandidate({
      workspaceId: owned.workspaceId,
      missionId: owned.missionId,
      targetRef: target.targetRef,
      expectedTargetCommitSha: target.commitSha,
      expectedTargetTreeSha: target.treeSha,
      candidateCommitSha: candidate.commit,
      candidateTreeSha: candidate.tree,
    });
    expect(integrated).toEqual({
      targetRef: target.targetRef,
      previousCommitSha: target.commitSha,
      previousTreeSha: target.treeSha,
      commitSha: candidate.commit,
      treeSha: candidate.tree,
    });
    expect(
      await readFile(path.join(f.repositoryRoot, 'result.txt'), 'utf8'),
    ).toBe('candidate\n');
  }, 15_000);

  it('rejects dirty and falsely owned handoff checkouts before pinning evidence', async () => {
    const f = await fixture();
    const target = await f.adapter.inspectTarget({
      workspaceId: 'workspace-test',
    });
    const owned = await f.leases.provisionWriter({
      missionId: 'mission_12345678',
      taskId: 'task_12345678',
      assignmentId: 'execution_12345678',
      ownerProfileId: 'profile-builder01',
      baseCommit: target.commitSha,
    });
    await writeFile(
      path.join(owned.checkoutPath, 'uncommitted.txt'),
      'dirty\n',
      'utf8',
    );
    const lease = missionLease(owned);

    await expect(
      f.adapter.verifyHandoff({
        workspaceId: owned.workspaceId,
        missionId: owned.missionId,
        taskId: owned.taskId,
        lease,
        claimedCommitSha: target.commitSha,
        claimedTreeSha: target.treeSha,
      }),
    ).rejects.toThrow('exact clean owned writer checkout');

    await expect(
      f.adapter.verifyHandoff({
        workspaceId: owned.workspaceId,
        missionId: owned.missionId,
        taskId: 'task_wrong000',
        lease: missionLease(owned, { taskId: 'task_wrong000' }),
        claimedCommitSha: target.commitSha,
        claimedTreeSha: target.treeSha,
      }),
    ).rejects.toThrow('identities do not match exactly');
    const ref = missionHandoffRef({
      workspaceId: owned.workspaceId,
      missionId: owned.missionId,
      taskId: owned.taskId,
      commitSha: target.commitSha,
    });
    expect(await f.git.tryResolveCommit(f.repositoryRoot, ref)).toBeUndefined();
  });
});
