import { describe, expect, it, vi } from 'vitest';
import {
  emptyMissionLedgerFile,
  type MissionLedgerStoreState,
} from '../src/missions/ledger.js';
import type {
  MissionGateRecord,
  MissionLedgerFileV1,
} from '../src/missions/types.js';
import {
  MissionUiControllerError,
  PrivilegedMissionUiController,
  type MissionUiCoordinatorPort,
  type MissionUiGateRunnerPort,
  type MissionUiProviderStatusPort,
} from '../src/ui/missionController.js';

const NOW = '2026-07-26T12:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const POLICY = 'c'.repeat(64);

function gateFixture(
  id: string,
  kind: 'test' | 'review',
  executorExecutionId: string,
  executorProfileId: string,
  options: {
    readonly status?: 'passed' | 'failed';
    readonly policy?: string;
    readonly createdAt?: string;
  } = {},
): MissionGateRecord {
  return {
    id,
    missionId: 'mission_demo',
    workspaceId: 'workspace_demo',
    candidateId: 'candidate_demo',
    kind,
    status: options.status ?? 'passed',
    commitSha: COMMIT,
    treeSha: TREE,
    commandIds:
      kind === 'test' ? ['typecheck', 'test'] : ['review'],
    gatePolicyFingerprint: options.policy ?? POLICY,
    executorExecutionId,
    executorProfileId,
    evidence: [`${kind}=privileged-result`],
    createdAt: options.createdAt ?? NOW,
  };
}

function ledgerFixture(): MissionLedgerFileV1 {
  const data = emptyMissionLedgerFile();
  return {
    ...data,
    revision: 7,
    missions: {
      mission_demo: {
        id: 'mission_demo',
        workspaceId: 'workspace_demo',
        title: 'Provider-neutral mission',
        objective: 'Ship exact handoffs and independent gates.',
        phase: 'active',
        taskIds: ['task_builder', 'task_tester'],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    tasks: {
      task_builder: {
        id: 'task_builder',
        missionId: 'mission_demo',
        workspaceId: 'workspace_demo',
        title: 'Build',
        description: 'Produce the change.',
        state: 'handoff-ready',
        dependsOn: [],
        assigneeProfileId: 'profile-builder01',
        worktreeLeaseId: 'lease_builder',
        executionId: 'execution_builder',
        handoffIds: ['handoff_builder'],
        activeHandoffId: 'handoff_builder',
        createdAt: NOW,
        updatedAt: NOW,
      },
      task_tester: {
        id: 'task_tester',
        missionId: 'mission_demo',
        workspaceId: 'workspace_demo',
        title: 'Test',
        description: 'Run independent gates.',
        state: 'running',
        dependsOn: [],
        assigneeProfileId: 'profile-tester001',
        executionId: 'execution_tester',
        handoffIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    leases: {
      lease_builder: {
        id: 'lease_builder',
        missionId: 'mission_demo',
        taskId: 'task_builder',
        workspaceId: 'workspace_demo',
        assignmentId: 'execution_builder',
        ownerProfileId: 'profile-builder01',
        accessMode: 'workspace-write',
        branchName: 'refs/heads/council/private',
        canonicalPath: '/private/tmp/secret-worktree',
        baseCommitSha: 'd'.repeat(40),
        baseTreeSha: 'e'.repeat(40),
        state: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    executions: {
      execution_builder: {
        id: 'execution_builder',
        missionId: 'mission_demo',
        taskId: 'task_builder',
        workspaceId: 'workspace_demo',
        profileId: 'profile-builder01',
        providerId: 'codex',
        definitionFingerprint: '1'.repeat(64),
        accessMode: 'workspace-write',
        providerAction: 'start',
        providerResourceId: 'thread_native_secret',
        state: 'completed',
        createdAt: NOW,
        updatedAt: NOW,
      },
      execution_tester: {
        id: 'execution_tester',
        missionId: 'mission_demo',
        taskId: 'task_tester',
        workspaceId: 'workspace_demo',
        profileId: 'profile-tester001',
        providerId: 'claude-code',
        definitionFingerprint: '2'.repeat(64),
        accessMode: 'read-only',
        providerAction: 'start',
        gateResponsibility: 'test',
        providerResourceId: 'session_native_secret',
        state: 'running',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    handoffs: {
      handoff_builder: {
        id: 'handoff_builder',
        missionId: 'mission_demo',
        taskId: 'task_builder',
        workspaceId: 'workspace_demo',
        executionId: 'execution_builder',
        leaseId: 'lease_builder',
        baseCommitSha: 'd'.repeat(40),
        commitSha: COMMIT,
        treeSha: TREE,
        summary: 'Exact builder handoff.',
        evidence: ['focused-tests=passed'],
        risks: [],
        createdAt: NOW,
      },
    },
    candidates: {
      candidate_demo: {
        id: 'candidate_demo',
        missionId: 'mission_demo',
        workspaceId: 'workspace_demo',
        targetRef: 'refs/heads/main',
        baseCommitSha: 'd'.repeat(40),
        baseTreeSha: 'e'.repeat(40),
        commitSha: COMMIT,
        treeSha: TREE,
        orderedHandoffIds: ['handoff_builder'],
        state: 'ready',
        createdAt: NOW,
      },
    },
  };
}

function controllerFixture(data = ledgerFixture()) {
  const publish = vi.fn();
  const store = {
    reload: vi.fn(
      async (): Promise<MissionLedgerStoreState> => ({
        file: '/private/tmp/mission-ledger.json',
        loaded: true,
        fileExists: true,
        data: structuredClone(data),
        problem: undefined,
      }),
    ),
  };
  const gateRecord: MissionGateRecord = {
    id: 'gate_demo',
    missionId: 'mission_demo',
    workspaceId: 'workspace_demo',
    candidateId: 'candidate_demo',
    kind: 'test',
    status: 'passed',
    commitSha: COMMIT,
    treeSha: TREE,
    commandIds: ['typecheck', 'test'],
    gatePolicyFingerprint: POLICY,
    executorExecutionId: 'execution_tester',
    executorProfileId: 'profile-tester001',
    evidence: ['command=typecheck outcome=passed'],
    createdAt: NOW,
  };
  const candidate = data.candidates['candidate_demo']!;
  const coordinator = {
    createMission: vi.fn(async () => {
      throw new Error('not used');
    }),
    previewSquad: vi.fn(
      async (): Promise<
        Awaited<ReturnType<MissionUiCoordinatorPort['previewSquad']>>
      > => ({
        digest: '0'.repeat(64),
        missionId: 'mission_demo',
        workspaceId: 'workspace_demo',
        ledgerRevision: 7,
        repository: {
          workspaceId: 'workspace_demo',
          targetRef: 'refs/heads/main',
          commitSha: COMMIT,
          treeSha: TREE,
        },
        participants: [],
        gateAssignments: {
          test: {
            kind: 'test',
            executionIntent: 'unassigned',
            diagnostic:
              'No explicit Test gate assignment was supplied.',
          },
          review: {
            kind: 'review',
            executionIntent: 'unassigned',
            diagnostic:
              'No explicit Review gate assignment was supplied.',
          },
        },
        blockers: [],
      }),
    ),
    startSquad: vi.fn(async () => {
      throw new Error('not used');
    }),
    retryBlockedExecution: vi.fn(async (executionId: string) => {
      const execution = data.executions[executionId];
      if (execution === undefined) throw new Error('not used');
      return execution;
    }),
    recordHandoff: vi.fn(async () => data.handoffs['handoff_builder']!),
    createCandidate: vi.fn(async () => candidate),
    recordGate: vi.fn(async () => gateRecord),
    previewIntegration: vi.fn(async () => ({
      digest: 'f'.repeat(64),
      approvalId: 'approval_demo',
      missionId: 'mission_demo',
      candidateId: 'candidate_demo',
      candidateCommitSha: COMMIT,
      candidateTreeSha: TREE,
      targetRef: 'refs/heads/main',
      expectedTargetCommitSha: 'd'.repeat(40),
      expectedTargetTreeSha: 'e'.repeat(40),
      testGateId: 'gate_test',
      reviewGateId: 'gate_review',
      approvalRevision: 8,
    })),
    approveAndIntegrate: vi.fn(async () => ({
      targetRef: 'refs/heads/main',
      previousCommitSha: 'd'.repeat(40),
      previousTreeSha: 'e'.repeat(40),
      commitSha: COMMIT,
      treeSha: TREE,
    })),
    rejectIntegration: vi.fn(async () => undefined),
  };
  const providers = {
    statuses: vi.fn(() => [
      {
        providerId: 'claude-code' as const,
        displayName: 'Claude Code',
        available: true,
        authenticated: true,
        persistentConversations: true,
        approvals: false,
        diagnostic: undefined,
      },
      {
        providerId: 'codex' as const,
        displayName: 'Codex',
        available: true,
        authenticated: true,
        persistentConversations: true,
        approvals: true,
        diagnostic: 'Connected through /private/provider/socket.',
      },
    ]),
  };
  const gateRunner = {
    preview: vi.fn((kind: 'test' | 'review') => ({
      kind,
      commandIds: kind === 'test' ? ['typecheck', 'test'] : ['review'],
      gatePolicyFingerprint: POLICY,
    })),
    run: vi.fn(async () => ({
      candidateId: 'candidate_demo',
      kind: 'test' as const,
      status: 'passed' as const,
      commitSha: COMMIT,
      treeSha: TREE,
      commandIds: ['typecheck', 'test'],
      gatePolicyFingerprint: POLICY,
      evidence: ['command=typecheck outcome=passed'],
    })),
  };
  const controller = new PrivilegedMissionUiController({
    store,
    coordinator: coordinator as unknown as MissionUiCoordinatorPort,
    providers: providers as MissionUiProviderStatusPort,
    gateRunner: gateRunner as unknown as MissionUiGateRunnerPort,
    workspaceId: 'workspace_demo',
    publish,
  });
  return {
    controller,
    coordinator,
    gateRunner,
    providers,
    publish,
    store,
  };
}

describe('privileged Mission UI controller', () => {
  it('projects durable Mission state without paths or provider-native identities', async () => {
    const f = controllerFixture();
    const state = await f.controller.getState();
    expect(state.status).toBe('ready');
    expect(state.revision).toBe(7);
    expect(state.gatePolicy).toEqual({
      fingerprint: POLICY,
      testCommandIds: ['typecheck', 'test'],
      reviewCommandIds: ['review'],
      diagnostic: undefined,
    });
    expect(state.providers.find((provider) => provider.providerId === 'codex')).toMatchObject({
      protocolReady: true,
      authenticated: true,
      diagnostic: 'Privileged diagnostic details were withheld.',
    });
    expect(
      state.projection?.assignmentsByProfileId['profile-builder01']?.[0],
    ).toMatchObject({ providerId: 'codex', taskId: 'task_builder' });
    expect(state.projection?.missions[0]?.tasks[0]).toMatchObject({
      execution: {
        id: 'execution_builder',
        providerId: 'codex',
        state: 'completed',
        accessMode: 'workspace-write',
        providerAction: 'start',
        definitionFingerprint: '1'.repeat(64),
      },
      lease: {
        id: 'lease_builder',
        accessMode: 'workspace-write',
      },
      activeHandoff: {
        id: 'handoff_builder',
        commitSha: COMMIT,
        treeSha: TREE,
      },
    });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('/private/tmp/secret-worktree');
    expect(serialized).not.toContain('refs/heads/council/private');
    expect(serialized).not.toContain('thread_native_secret');
    expect(serialized).not.toContain('session_native_secret');
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('retains a last-known-good projection while redacting a malformed ledger path', async () => {
    const data = ledgerFixture();
    const f = controllerFixture(data);
    f.store.reload.mockResolvedValueOnce({
      file: '/private/tmp/secret-ledger.json',
      loaded: true,
      fileExists: true,
      data,
      problem: {
        kind: 'parse',
        file: '/private/tmp/secret-ledger.json',
        message: 'Malformed JSON at /private/tmp/secret-ledger.json',
        occurredAt: NOW,
      },
    });
    const state = await f.controller.getState();
    expect(state.status).toBe('blocked');
    expect(state.projection?.missions).toHaveLength(1);
    expect(state.problem).toContain('last-known-good');
    expect(JSON.stringify(state)).not.toContain('/private/tmp/secret-ledger.json');
  });

  it('maps an explicit-provider squad preview without exposing lease paths or refs', async () => {
    const f = controllerFixture();
    f.coordinator.previewSquad.mockResolvedValueOnce({
      digest: '9'.repeat(64),
      missionId: 'mission_demo',
      workspaceId: 'workspace_demo',
      ledgerRevision: 7,
      repository: {
        workspaceId: 'workspace_demo',
        targetRef: 'refs/heads/main',
        commitSha: COMMIT,
        treeSha: TREE,
      },
      participants: [
        {
          taskId: 'task_builder',
          profileId: 'profile-builder01',
          provider: {
            taskId: 'task_builder',
            profileId: 'profile-builder01',
            providerId: 'codex',
            definitionFingerprint: '1'.repeat(64),
            roleInstructions:
              'Build only the exact assigned Mission task.',
            roleInstructionFingerprint: '4'.repeat(64),
            providerAvailable: true,
            providerAuthenticated: true,
            protocolReady: true,
            action: 'start',
            launchable: true,
          },
          lease: {
            taskId: 'task_builder',
            leaseId: 'lease_preview',
            branchName: 'refs/heads/council/secret',
            canonicalPath: '/private/tmp/preview-secret',
            baseCommitSha: COMMIT,
            baseTreeSha: TREE,
            available: true,
          },
        },
        {
          taskId: 'task_test',
          profileId: 'profile-test0001',
          provider: {
            taskId: 'task_test',
            profileId: 'profile-test0001',
            providerId: 'claude-code',
            definitionFingerprint: '2'.repeat(64),
            roleInstructions:
              'Run independent tests against the exact candidate.',
            roleInstructionFingerprint: '5'.repeat(64),
            providerAvailable: true,
            providerAuthenticated: true,
            protocolReady: true,
            action: 'start',
            launchable: true,
          },
          lease: undefined,
        },
        {
          taskId: 'task_review',
          profileId: 'profile-review01',
          provider: {
            taskId: 'task_review',
            profileId: 'profile-review01',
            providerId: 'codex',
            definitionFingerprint: '3'.repeat(64),
            roleInstructions:
              'Review the exact candidate without modifying it.',
            roleInstructionFingerprint: '6'.repeat(64),
            providerAvailable: true,
            providerAuthenticated: true,
            protocolReady: true,
            action: 'start',
            launchable: true,
          },
          lease: undefined,
        },
      ],
      gateAssignments: {
        test: {
          kind: 'test',
          taskId: 'task_test',
          profileId: 'profile-test0001',
          executionIntent: 'allocate-read-only-on-start',
        },
        review: {
          kind: 'review',
          taskId: 'task_review',
          profileId: 'profile-review01',
          executionIntent: 'allocate-read-only-on-start',
        },
      },
      blockers: [],
    });
    const result = await f.controller.previewSquad({
      missionId: 'mission_demo',
      expectedRevision: 7,
      selections: [
        {
          taskId: 'task_builder',
          profileId: 'profile-builder01',
          providerId: 'codex',
          expectedDefinitionFingerprint: '1'.repeat(64),
          writeCapable: true,
        },
        {
          taskId: 'task_test',
          profileId: 'profile-test0001',
          providerId: 'claude-code',
          expectedDefinitionFingerprint: '2'.repeat(64),
          writeCapable: false,
        },
        {
          taskId: 'task_review',
          profileId: 'profile-review01',
          providerId: 'codex',
          expectedDefinitionFingerprint: '3'.repeat(64),
          writeCapable: false,
        },
      ],
      gateAssignments: {
        testProfileId: 'profile-test0001',
        reviewProfileId: 'profile-review01',
      },
    });
    expect(result.participants[0]).toEqual({
      taskId: 'task_builder',
      profileId: 'profile-builder01',
      providerId: 'codex',
      definitionFingerprint: '1'.repeat(64),
      roleInstructions:
        'Build only the exact assigned Mission task.',
      roleInstructionFingerprint: '4'.repeat(64),
      providerAvailable: true,
      providerAuthenticated: true,
      protocolReady: true,
      providerAction: 'start',
      launchable: true,
      accessMode: 'workspace-write',
      leaseId: 'lease_preview',
      baseCommitSha: COMMIT,
      diagnostic: undefined,
    });
    expect(result.gateAssignments).toEqual({
      test: {
        kind: 'test',
        taskId: 'task_test',
        profileId: 'profile-test0001',
        executionIntent: 'allocate-read-only-on-start',
      },
      review: {
        kind: 'review',
        taskId: 'task_review',
        profileId: 'profile-review01',
        executionIntent: 'allocate-read-only-on-start',
      },
    });
    expect(JSON.stringify(result)).not.toContain('/private/tmp/preview-secret');
    expect(JSON.stringify(result)).not.toContain('refs/heads/council/secret');
  });

  it('retries an exact blocked execution and publishes its safe replacement state', async () => {
    const original = ledgerFixture();
    const blockedExecution = {
      ...original.executions['execution_tester']!,
      state: 'blocked' as const,
      failureReason: 'Provider stopped before assignment completion.',
    };
    const data: MissionLedgerFileV1 = {
      ...original,
      revision: 8,
      tasks: {
        ...original.tasks,
        task_tester: {
          ...original.tasks['task_tester']!,
          state: 'blocked',
        },
      },
      executions: {
        ...original.executions,
        execution_tester: blockedExecution,
      },
    };
    const f = controllerFixture(data);
    f.coordinator.retryBlockedExecution.mockResolvedValueOnce({
      ...blockedExecution,
      state: 'running',
      providerAction: 'resume',
    });

    const result = await f.controller.retryBlockedExecution({
      expectedRevision: 8,
      executionId: 'execution_tester',
    });

    expect(
      f.coordinator.retryBlockedExecution,
    ).toHaveBeenCalledExactlyOnceWith('execution_tester', 8);
    expect(result).toEqual({
      revision: 8,
      execution: {
        id: 'execution_tester',
        providerId: 'claude-code',
        state: 'running',
        accessMode: 'read-only',
        providerAction: 'resume',
        gateResponsibility: 'test',
        definitionFingerprint: '2'.repeat(64),
      },
    });
    expect(JSON.stringify(result)).not.toContain('session_native_secret');
    expect(JSON.stringify(result)).not.toContain('failureReason');
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it('rejects retry for anything other than the exact blocked workspace execution', async () => {
    const f = controllerFixture();
    await expect(
      f.controller.retryBlockedExecution({
        expectedRevision: 7,
        executionId: 'execution_tester',
      }),
    ).rejects.toThrow('exact blocked execution');
    expect(f.coordinator.retryBlockedExecution).not.toHaveBeenCalled();
  });

  it('runs gates against the exact candidate and records only privileged evidence', async () => {
    const f = controllerFixture();
    const result = await f.controller.recordGate({
      expectedRevision: 7,
      candidateId: 'candidate_demo',
      kind: 'test',
      commandIds: ['typecheck', 'test'],
      gatePolicyFingerprint: POLICY,
      executorProfileId: 'profile-tester001',
    });
    expect(f.gateRunner.run).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'workspace_demo',
      missionId: 'mission_demo',
      candidateId: 'candidate_demo',
      executorExecutionId: 'execution_tester',
      executorProfileId: 'profile-tester001',
      kind: 'test',
      commitSha: COMMIT,
      treeSha: TREE,
      expectedGatePolicyFingerprint: POLICY,
    });
    expect(f.coordinator.recordGate).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      candidateId: 'candidate_demo',
      kind: 'test',
      status: 'passed',
      commitSha: COMMIT,
      treeSha: TREE,
      commandIds: ['typecheck', 'test'],
      gatePolicyFingerprint: POLICY,
      executorExecutionId: 'execution_tester',
      executorProfileId: 'profile-tester001',
      evidence: ['command=typecheck outcome=passed'],
    });
    expect(result.executorExecutionId).toBe('execution_tester');
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it('rejects stale gate policy and producer self-certification before running commands', async () => {
    const stale = controllerFixture();
    await expect(
      stale.controller.recordGate({
        expectedRevision: 7,
        candidateId: 'candidate_demo',
        kind: 'test',
        commandIds: ['test', 'typecheck'],
        gatePolicyFingerprint: POLICY,
        executorProfileId: 'profile-tester001',
      }),
    ).rejects.toBeInstanceOf(MissionUiControllerError);
    expect(stale.gateRunner.run).not.toHaveBeenCalled();

    const producer = controllerFixture();
    await expect(
      producer.controller.recordGate({
        expectedRevision: 7,
        candidateId: 'candidate_demo',
        kind: 'test',
        commandIds: ['typecheck', 'test'],
        gatePolicyFingerprint: POLICY,
        executorProfileId: 'profile-builder01',
      }),
    ).rejects.toThrow('not an independent');
    expect(producer.gateRunner.run).not.toHaveBeenCalled();
  });

  it('never lets candidate creation choose a Git target and maps integration as display-only evidence', async () => {
    const original = ledgerFixture();
    const data: MissionLedgerFileV1 = {
      ...original,
      executions: {
        ...original.executions,
        execution_reviewer: {
          id: 'execution_reviewer',
          missionId: 'mission_demo',
          taskId: 'task_tester',
          workspaceId: 'workspace_demo',
          profileId: 'profile-reviewer01',
          providerId: 'codex',
          definitionFingerprint: '3'.repeat(64),
          accessMode: 'read-only',
          providerAction: 'start',
          gateResponsibility: 'review',
          providerResourceId: 'thread_reviewer',
          state: 'running',
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      gates: {
        gate_test: gateFixture(
          'gate_test',
          'test',
          'execution_tester',
          'profile-tester001',
        ),
        gate_review: gateFixture(
          'gate_review',
          'review',
          'execution_reviewer',
          'profile-reviewer01',
        ),
      },
      approvals: {
        ...original.approvals,
        approval_demo: {
          id: 'approval_demo',
          missionId: 'mission_demo',
          workspaceId: 'workspace_demo',
          candidateId: 'candidate_demo',
          testGateId: 'gate_test',
          reviewGateId: 'gate_review',
          expectedTargetCommitSha: 'd'.repeat(40),
          expectedTargetTreeSha: 'e'.repeat(40),
          previewDigest: 'f'.repeat(64),
          approvalRevision: 7,
          status: 'pending',
          createdAt: NOW,
        },
      },
    };
    const f = controllerFixture(data);
    const candidateInput = {
      expectedRevision: 7,
      missionId: 'mission_demo',
      orderedHandoffIds: ['handoff_builder'],
    };
    await f.controller.createCandidate(candidateInput);
    expect(f.coordinator.createCandidate).toHaveBeenCalledExactlyOnceWith(
      candidateInput,
    );

    const preview = await f.controller.previewIntegration({
      missionId: 'mission_demo',
      candidateId: 'candidate_demo',
      expectedRevision: 7,
    });
    expect(preview.targetLabel).toBe('refs/heads/main');
    const integrated = await f.controller.approveIntegration('f'.repeat(64));
    expect(integrated).toEqual({
      missionId: 'mission_demo',
      revision: 7,
      status: 'integrated',
      resultingCommitSha: COMMIT,
    });
  });

  it('blocks integration after a newer failed gate or a gate-policy change', async () => {
    const original = ledgerFixture();
    const commonReview = gateFixture(
      'gate_review',
      'review',
      'execution_reviewer',
      'profile-reviewer01',
    );
    const failedAfterPass: MissionLedgerFileV1 = {
      ...original,
      gates: {
        gate_test_pass: gateFixture(
          'gate_test_pass',
          'test',
          'execution_tester',
          'profile-tester001',
          { createdAt: '2026-07-26T12:00:00.000Z' },
        ),
        gate_test_fail: gateFixture(
          'gate_test_fail',
          'test',
          'execution_tester',
          'profile-tester001',
          {
            status: 'failed',
            createdAt: '2026-07-26T12:01:00.000Z',
          },
        ),
        gate_review: commonReview,
      },
    };
    const failed = controllerFixture(failedAfterPass);
    await expect(
      failed.controller.previewIntegration({
        missionId: 'mission_demo',
        candidateId: 'candidate_demo',
        expectedRevision: 7,
      }),
    ).rejects.toThrow('latest Test and Review');
    expect(failed.coordinator.previewIntegration).not.toHaveBeenCalled();

    const oldPolicy: MissionLedgerFileV1 = {
      ...original,
      gates: {
        gate_test: gateFixture(
          'gate_test',
          'test',
          'execution_tester',
          'profile-tester001',
          { policy: 'd'.repeat(64) },
        ),
        gate_review: gateFixture(
          'gate_review',
          'review',
          'execution_reviewer',
          'profile-reviewer01',
          { policy: 'd'.repeat(64) },
        ),
      },
    };
    const changed = controllerFixture(oldPolicy);
    await expect(
      changed.controller.previewIntegration({
        missionId: 'mission_demo',
        candidateId: 'candidate_demo',
        expectedRevision: 7,
      }),
    ).rejects.toThrow('Gate policy changed');
    expect(changed.coordinator.previewIntegration).not.toHaveBeenCalled();
  });
});
