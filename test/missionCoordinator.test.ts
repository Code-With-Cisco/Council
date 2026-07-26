import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  MissionCoordinator,
  StaleMissionPlanError,
  type MissionGitPort,
  type MissionProviderPort,
  type MissionWorktreePort,
} from '../src/missions/coordinator.js';
import {
  MissionLedgerStore,
  parseMissionLedgerFile,
  type MutableMissionLedger,
} from '../src/missions/ledger.js';
import { projectMissionLedger } from '../src/missions/projection.js';
import type {
  MissionGateKind,
  SquadSelection,
} from '../src/missions/types.js';

const BASE = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const HANDOFF = 'c'.repeat(40);
const HANDOFF_TREE = 'd'.repeat(40);
const CANDIDATE = 'e'.repeat(40);
const CANDIDATE_TREE = 'f'.repeat(40);
const FINGERPRINT = '1'.repeat(64);
const BUILDER = 'profile-builder01';
const TESTER = 'profile-tester001';
const REVIEWER = 'profile-review001';
const MISSION = 'mission_12345678';
const TASK = 'task_12345678';
const TEST_TASK = 'task_test0001';
const REVIEW_TASK = 'task_review01';
const TEST_EXECUTION = 'execution_test0001';
const REVIEW_EXECUTION = 'execution_review01';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'council-mission-core-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new MissionLedgerStore(
    path.join(directory, 'mission-ledger.json'),
  );
  await store.load();

  let targetCommit = BASE;
  let targetTree = BASE_TREE;
  let integrationFailure: Error | undefined;
  const ids = new Map<string, number>();
  const createId = (kind: string): string => {
    const next = (ids.get(kind) ?? 0) + 1;
    ids.set(kind, next);
    return `${kind}_${String(next).padStart(8, '0')}`;
  };
  const provider: MissionProviderPort = {
    previewStart: vi.fn(async (request) => ({
      taskId: request.taskId,
      profileId: request.profileId,
      providerId: 'provider-test',
      definitionFingerprint: request.expectedDefinitionFingerprint,
      roleInstructions:
        'Complete only the exact assigned Mission task.',
      roleInstructionFingerprint: '6'.repeat(64),
      providerAvailable: true,
      providerAuthenticated: true,
      protocolReady: true,
      action: 'start' as const,
      launchable: true,
    })),
    start: vi.fn(async (request) => ({
      providerId: request.providerId,
      profileId: request.profileId,
      providerResourceId: 'thread_exact_123',
    })),
  };
  const worktrees: MissionWorktreePort = {
    previewLease: vi.fn(async (request) => ({
      taskId: request.taskId,
      leaseId: 'lease_preview01',
      branchName: 'council/mission/task',
      canonicalPath: path.join(directory, 'leases', 'task'),
      baseCommitSha: request.baseCommitSha,
      baseTreeSha: request.baseTreeSha,
      available: true,
    })),
    provisionLease: vi.fn(async (preview, assignmentId) => ({
      leaseId: preview.leaseId,
      taskId: preview.taskId,
      assignmentId,
      ownerProfileId: BUILDER,
      accessMode: 'workspace-write' as const,
      branchName: preview.branchName,
      canonicalPath: preview.canonicalPath,
      baseCommitSha: preview.baseCommitSha,
      baseTreeSha: preview.baseTreeSha,
    })),
  };
  const git: MissionGitPort = {
    inspectTarget: vi.fn(async (request) => ({
      workspaceId: request.workspaceId,
      targetRef: request.targetRef ?? 'refs/heads/main',
      commitSha: targetCommit,
      treeSha: targetTree,
    })),
    verifyHandoff: vi.fn(async (request) => ({
      baseCommitSha: request.lease.baseCommitSha,
      commitSha: request.claimedCommitSha,
      treeSha: request.claimedTreeSha,
    })),
    buildCandidate: vi.fn(async (request) => ({
      targetRef: request.target.targetRef,
      baseCommitSha: request.target.commitSha,
      baseTreeSha: request.target.treeSha,
      commitSha: CANDIDATE,
      treeSha: CANDIDATE_TREE,
    })),
    integrateCandidate: vi.fn(async (request) => {
      if (integrationFailure !== undefined) throw integrationFailure;
      const result = {
        targetRef: request.targetRef,
        previousCommitSha: targetCommit,
        previousTreeSha: targetTree,
        commitSha: request.candidateCommitSha,
        treeSha: request.candidateTreeSha,
      };
      targetCommit = request.candidateCommitSha;
      targetTree = request.candidateTreeSha;
      return result;
    }),
  };
  const coordinator = new MissionCoordinator({
    store,
    provider,
    git,
    worktrees,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    createId,
  });
  await coordinator.createMission({
    expectedRevision: 0,
    workspaceId: 'workspace-test',
    id: MISSION,
    title: 'Mission core',
    objective: 'Prove the durable workflow.',
    tasks: [
      {
        id: TASK,
        title: 'Build it',
        description: 'Create the exact commit.',
      },
      {
        id: TEST_TASK,
        title: 'Test it',
        description: 'Run the independent Test gate.',
      },
      {
        id: REVIEW_TASK,
        title: 'Review it',
        description: 'Run the independent Review gate.',
      },
    ],
  });
  const selection: SquadSelection = {
    taskId: TASK,
    profileId: BUILDER,
    providerId: 'provider-test',
    expectedDefinitionFingerprint: FINGERPRINT,
    writeCapable: true,
  };
  return {
    directory,
    store,
    coordinator,
    provider,
    worktrees,
    git,
    selection,
    setTarget(commitSha: string, treeSha: string) {
      targetCommit = commitSha;
      targetTree = treeSha;
    },
    setIntegrationFailure(error: Error | undefined) {
      integrationFailure = error;
    },
  };
}

async function dispatch(f: Awaited<ReturnType<typeof fixture>>) {
  const preview = await f.coordinator.previewSquad(MISSION, 1, [f.selection]);
  const result = await f.coordinator.startSquad(preview.digest);
  expect(result.failures).toEqual([]);
  const execution = result.executions[0]!;
  return { preview, result, execution };
}

async function handoffAndCandidate(
  f: Awaited<ReturnType<typeof fixture>>,
  revision: number,
  executionId: string,
) {
  const handoff = await f.coordinator.recordHandoff({
    expectedRevision: revision,
    taskId: TASK,
    executionId,
    claimedCommitSha: HANDOFF,
    claimedTreeSha: HANDOFF_TREE,
    summary: 'Implemented the requested change.',
    evidence: ['focused tests passed'],
    risks: [],
  });
  const afterHandoff = f.store.state.data.revision;
  const candidate = await f.coordinator.createCandidate({
    expectedRevision: afterHandoff,
    missionId: MISSION,
    orderedHandoffIds: [handoff.id],
  });
  return { handoff, candidate, revision: f.store.state.data.revision };
}

async function gate(
  f: Awaited<ReturnType<typeof fixture>>,
  candidateId: string,
  kind: MissionGateKind,
  executorProfileId: string,
  gatePolicyFingerprint = '4'.repeat(64),
) {
  let executorExecutionId = f.store.state.data.tasks[TASK]?.executionId;
  if (executorProfileId !== BUILDER) {
    const executionId =
      executorProfileId === TESTER ? TEST_EXECUTION : REVIEW_EXECUTION;
    const taskId = executorProfileId === TESTER ? TEST_TASK : REVIEW_TASK;
    if (f.store.state.data.executions[executionId] === undefined) {
      const now = '2026-07-26T12:00:00.000Z';
      await f.store.transact(f.store.state.data.revision, (draft) => {
        const task = draft.tasks[taskId]!;
        draft.tasks[taskId] = {
          ...task,
          state: 'canceled',
          assigneeProfileId: executorProfileId,
          executionId,
          updatedAt: now,
        };
        draft.executions[executionId] = {
          id: executionId,
          missionId: MISSION,
          taskId,
          workspaceId: 'workspace-test',
          profileId: executorProfileId,
          providerId: 'provider-test',
          definitionFingerprint: FINGERPRINT,
          accessMode: 'read-only',
          providerAction: 'start',
          gateResponsibility: kind,
          providerResourceId: `thread_${executionId}`,
          state: 'completed',
          createdAt: now,
          updatedAt: now,
        };
      });
    }
    executorExecutionId = executionId;
  }
  if (executorExecutionId === undefined) {
    throw new Error('Fixture gate execution is unavailable.');
  }
  return f.coordinator.recordGate({
    expectedRevision: f.store.state.data.revision,
    candidateId,
    kind,
    status: 'passed',
    commitSha: CANDIDATE,
    treeSha: CANDIDATE_TREE,
    commandIds: kind === 'test' ? ['typecheck'] : [],
    gatePolicyFingerprint,
    executorExecutionId,
    executorProfileId,
    evidence: [`${kind} passed`],
  });
}

describe('MissionCoordinator', () => {
  it('keeps Start Squad preview side-effect free and rejects a stale digest before effects', async () => {
    const f = await fixture();
    const preview = await f.coordinator.previewSquad(MISSION, 1, [f.selection]);
    expect(preview.blockers).toEqual([]);
    expect(f.store.state.data.revision).toBe(1);
    expect(f.store.state.data.leases).toEqual({});
    expect(f.store.state.data.executions).toEqual({});

    await f.store.transact(1, (draft) => {
      draft.missions[MISSION] = {
        ...draft.missions[MISSION]!,
        title: 'Changed after preview',
      };
    });
    await expect(
      f.coordinator.startSquad(preview.digest),
    ).rejects.toBeInstanceOf(StaleMissionPlanError);
    expect(f.provider.start).not.toHaveBeenCalled();
    expect(f.worktrees.provisionLease).not.toHaveBeenCalled();
  });

  it('journals exact lease/execution identity and makes a Start preview single-use', async () => {
    const f = await fixture();
    const { preview, result, execution } = await dispatch(f);
    const data = f.store.state.data;
    expect(result.revision).toBe(4);
    expect(data.tasks[TASK]).toMatchObject({
      state: 'running',
      assigneeProfileId: BUILDER,
      executionId: execution.id,
      worktreeLeaseId: 'lease_preview01',
    });
    expect(data.leases['lease_preview01']).toMatchObject({
      state: 'ready',
      assignmentId: execution.id,
      ownerProfileId: BUILDER,
      accessMode: 'workspace-write',
    });
    expect(data.executions[execution.id]).toMatchObject({
      providerId: 'provider-test',
      definitionFingerprint: FINGERPRINT,
      accessMode: 'workspace-write',
      providerAction: 'start',
      providerResourceId: 'thread_exact_123',
      state: 'running',
    });
    expect(f.provider.start).toHaveBeenCalledWith(
      expect.objectContaining({
        missionObjective: 'Prove the durable workflow.',
        taskTitle: 'Build it',
        taskDescription: 'Create the exact commit.',
        providerId: 'provider-test',
      }),
    );
    await expect(
      f.coordinator.startSquad(preview.digest),
    ).rejects.toBeInstanceOf(StaleMissionPlanError);
    expect(f.provider.start).toHaveBeenCalledOnce();
  });

  it('fails closed when one provider resource is returned for two Mission executions', async () => {
    const f = await fixture();
    const testerSelection: SquadSelection = {
      taskId: TEST_TASK,
      profileId: TESTER,
      providerId: 'provider-test',
      expectedDefinitionFingerprint: FINGERPRINT,
      writeCapable: false,
    };
    const preview = await f.coordinator.previewSquad(MISSION, 1, [
      f.selection,
      testerSelection,
    ]);

    const result = await f.coordinator.startSquad(preview.digest);

    expect(result.executions).toHaveLength(1);
    expect(result.failures).toEqual([
      {
        taskId: TEST_TASK,
        message:
          'Provider conversation identity is already owned by another Mission execution.',
      },
    ]);
    const tester = Object.values(f.store.state.data.executions).find(
      (execution) => execution.profileId === TESTER,
    );
    expect(tester).toMatchObject({
      state: 'blocked',
      accessMode: 'read-only',
      definitionFingerprint: FINGERPRINT,
      providerAction: 'start',
      failureReason:
        'Provider conversation identity is already owned by another Mission execution.',
    });
    expect(tester?.providerResourceId).toBeUndefined();

    const corrupted = structuredClone(
      f.store.state.data,
    ) as MutableMissionLedger;
    const testerId = tester!.id;
    const { failureReason, ...withoutFailure } = corrupted.executions[testerId]!;
    void failureReason;
    corrupted.executions[testerId] = {
      ...withoutFailure,
      providerResourceId: 'thread_exact_123',
      state: 'running',
    };
    corrupted.tasks[TEST_TASK] = {
      ...corrupted.tasks[TEST_TASK]!,
      state: 'running',
    };
    expect(() => parseMissionLedgerFile(corrupted)).toThrow(
      'provider resource is owned by both executions',
    );
  });

  it('rejects a handoff or gate that is not bound to the exact commit and tree', async () => {
    const f = await fixture();
    const { result, execution } = await dispatch(f);
    vi.mocked(f.git.verifyHandoff).mockResolvedValueOnce({
      baseCommitSha: BASE,
      commitSha: HANDOFF,
      treeSha: '9'.repeat(40),
    });
    await expect(
      f.coordinator.recordHandoff({
        expectedRevision: result.revision,
        taskId: TASK,
        executionId: execution.id,
        claimedCommitSha: HANDOFF,
        claimedTreeSha: HANDOFF_TREE,
        summary: 'Claim',
        evidence: [],
        risks: [],
      }),
    ).rejects.toThrow('exact claimed commit, tree');
    expect(f.store.state.data.revision).toBe(result.revision);

    const { candidate } = await handoffAndCandidate(
      f,
      result.revision,
      execution.id,
    );
    await gate(f, candidate.id, 'test', TESTER);
    await expect(
      f.coordinator.recordGate({
        expectedRevision: f.store.state.data.revision,
        candidateId: candidate.id,
        kind: 'test',
        status: 'passed',
        commitSha: HANDOFF,
        treeSha: CANDIDATE_TREE,
        commandIds: ['typecheck'],
        gatePolicyFingerprint: '4'.repeat(64),
        executorExecutionId: TEST_EXECUTION,
        executorProfileId: TESTER,
        evidence: [],
      }),
    ).rejects.toThrow('exact candidate commit and tree');
  });

  it('rejects an executor that was not assigned the requested immutable gate responsibility', async () => {
    const f = await fixture();
    const { result, execution } = await dispatch(f);
    const { candidate } = await handoffAndCandidate(
      f,
      result.revision,
      execution.id,
    );
    await gate(f, candidate.id, 'test', TESTER);
    await expect(
      gate(f, candidate.id, 'review', TESTER),
    ).rejects.toThrow('immutable Review assignment');
    expect(Object.keys(f.store.state.data.approvals)).toHaveLength(0);
  });

  it('requires Test and Review to certify one exact gate policy', async () => {
    const f = await fixture();
    const { result, execution } = await dispatch(f);
    const { candidate } = await handoffAndCandidate(
      f,
      result.revision,
      execution.id,
    );
    await gate(f, candidate.id, 'test', TESTER, '4'.repeat(64));
    await gate(f, candidate.id, 'review', REVIEWER, '5'.repeat(64));

    await expect(
      f.coordinator.previewIntegration(
        MISSION,
        candidate.id,
        f.store.state.data.revision,
      ),
    ).rejects.toThrow('same gate policy fingerprint');
    expect(Object.keys(f.store.state.data.approvals)).toHaveLength(0);
  });

  it('does not accept a handoff producer as either independent gate', async () => {
    const f = await fixture();
    const { result, execution } = await dispatch(f);
    const { candidate } = await handoffAndCandidate(
      f,
      result.revision,
      execution.id,
    );
    await expect(
      gate(f, candidate.id, 'test', BUILDER),
    ).rejects.toThrow('cannot certify its own candidate');
    expect(Object.keys(f.store.state.data.approvals)).toHaveLength(0);
  });

  it('journals approval before integration, recovers it once, and projects completion', async () => {
    const f = await fixture();
    const { result, execution } = await dispatch(f);
    const { candidate } = await handoffAndCandidate(
      f,
      result.revision,
      execution.id,
    );
    await gate(f, candidate.id, 'test', TESTER);
    await gate(f, candidate.id, 'review', REVIEWER);
    const preview = await f.coordinator.previewIntegration(
      MISSION,
      candidate.id,
      f.store.state.data.revision,
    );
    expect(f.store.state.data.approvals[preview.approvalId]).toMatchObject({
      status: 'pending',
      approvalRevision: preview.approvalRevision,
    });

    f.setIntegrationFailure(new Error('integration interrupted'));
    await expect(
      f.coordinator.approveAndIntegrate(preview.digest),
    ).rejects.toThrow('integration interrupted');
    const approvedRevision = f.store.state.data.revision;
    expect(f.store.state.data.approvals[preview.approvalId]?.status).toBe(
      'approved',
    );
    expect(f.store.state.data.missions[MISSION]?.phase).toBe('integrating');

    f.setIntegrationFailure(undefined);
    await f.coordinator.resumeApprovedIntegration(
      preview.approvalId,
      approvedRevision,
    );
    const completed = f.store.state.data;
    expect(completed.approvals[preview.approvalId]).toMatchObject({
      status: 'consumed',
      integrationCommitSha: CANDIDATE,
      integrationTreeSha: CANDIDATE_TREE,
    });
    expect(completed.candidates[candidate.id]?.state).toBe('integrated');
    expect(completed.tasks[TASK]?.state).toBe('integrated');
    expect(completed.missions[MISSION]?.phase).toBe('completed');
    expect(f.git.integrateCandidate).toHaveBeenCalledTimes(2);

    const projected = projectMissionLedger(completed, 'workspace-test');
    expect(projected.assignmentsByProfileId[BUILDER]?.[0]).toMatchObject({
      missionId: MISSION,
      taskId: TASK,
      taskState: 'integrated',
    });
    await expect(
      f.coordinator.approveAndIntegrate(preview.digest),
    ).rejects.toBeInstanceOf(StaleMissionPlanError);
  });

  it('rejects approval when the target moves after preview', async () => {
    const f = await fixture();
    const { result, execution } = await dispatch(f);
    const { candidate } = await handoffAndCandidate(
      f,
      result.revision,
      execution.id,
    );
    await gate(f, candidate.id, 'test', TESTER);
    await gate(f, candidate.id, 'review', REVIEWER);
    const preview = await f.coordinator.previewIntegration(
      MISSION,
      candidate.id,
      f.store.state.data.revision,
    );
    f.setTarget('2'.repeat(40), '3'.repeat(40));
    await expect(
      f.coordinator.approveAndIntegrate(preview.digest),
    ).rejects.toBeInstanceOf(StaleMissionPlanError);
    expect(f.git.integrateCandidate).not.toHaveBeenCalled();
    expect(f.store.state.data.approvals[preview.approvalId]?.status).toBe(
      'pending',
    );
  });
});
