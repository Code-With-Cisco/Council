import { describe, expect, it, vi } from 'vitest';
import type { CliResult } from '../src/integration/types.js';
import type { AgentSupervisorPort } from '../src/supervisor/contracts.js';
import {
  registerCouncilIpc,
  type CouncilIpcDependencies,
  type IpcRegistrar,
} from '../src/ui/ipcHandlers.js';
import { IPC_CHANNELS, type UiResult } from '../src/ui/ipc.js';
import type {
  MissionUiController,
  UiPreviewSquadInput,
} from '../src/ui/missionUi.js';

function success<T>(value: T): CliResult<T> {
  return { ok: true, value, raw: '', argv: [], durationMs: 0 };
}

function fixture(trusted = true, confirm = true, councilBound = false) {
  const handlers = new Map<
    string,
    (event: unknown, ...args: readonly unknown[]) => unknown
  >();
  const registrar: IpcRegistrar = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  };
  const stopSession = vi.fn(async () => success('stopped'));
  const logs = vi.fn(async () => success('logs'));
  const reply = vi.fn(async () =>
    success({ delivered: true, acknowledged: true, output: '' }),
  );
  const startNewMember = vi.fn(async () =>
    success({ id: 'new00001', name: 'dc-new', unknownAgent: undefined }),
  );
  const startCouncilReview = vi.fn(async () =>
    success({ id: 'council1', name: 'dc-council', unknownAgent: undefined }),
  );
  const confirmStartNew = vi.fn(async () => confirm);
  const confirmStartSquad = vi.fn(async () => confirm);
  const confirmMissionIntegration = vi.fn(async () => confirm);
  const missionController: MissionUiController = {
    getState: vi.fn(async () => ({
      status: 'ready' as const,
      workspaceId: 'workspace_123',
      revision: 0,
      problem: undefined,
      providers: [],
      gatePolicy: undefined,
      projection: undefined,
    })),
    createMission: vi.fn(async () => ({
      revision: 1,
      mission: {
        id: 'mission_123',
        title: 'Mission',
        objective: 'Objective',
        phase: 'draft',
        tasks: [],
        latestCandidate: undefined,
        testGate: undefined,
        reviewGate: undefined,
      },
    })),
    previewSquad: vi.fn(async (input: UiPreviewSquadInput) => ({
      digest: 'd'.repeat(64),
      missionId: input.missionId,
      revision: input.expectedRevision,
      repositoryHeadSha: 'a'.repeat(40),
      participants: [],
      gateAssignments: {
        test: {
          kind: 'test' as const,
          taskId:
            input.selections.find(
              (selection) =>
                selection.profileId ===
                input.gateAssignments.testProfileId,
            )?.taskId ?? 'task_test123',
          profileId: input.gateAssignments.testProfileId,
          executionIntent:
            'allocate-read-only-on-start' as const,
        },
        review: {
          kind: 'review' as const,
          taskId:
            input.selections.find(
              (selection) =>
                selection.profileId ===
                input.gateAssignments.reviewProfileId,
            )?.taskId ?? 'task_review123',
          profileId: input.gateAssignments.reviewProfileId,
          executionIntent:
            'allocate-read-only-on-start' as const,
        },
      },
      blockers: [],
    })),
    startSquad: vi.fn(async () => ({
      missionId: 'mission_123',
      revision: 2,
      startedTaskIds: [],
      failures: [],
    })),
    retryBlockedExecution: vi.fn(async (input) => ({
      revision: input.expectedRevision + 1,
      execution: {
        id: input.executionId,
        providerId: 'codex' as const,
        state: 'running' as const,
        accessMode: 'read-only' as const,
        providerAction: 'resume' as const,
        gateResponsibility: undefined,
        definitionFingerprint: 'a'.repeat(64),
      },
    })),
    recordHandoff: vi.fn(async (input) => ({
      id: 'handoff_123',
      taskId: input.taskId,
      commitSha: input.claimedCommitSha,
      treeSha: input.claimedTreeSha,
      summary: input.summary,
      createdAt: '2026-07-26T00:00:00.000Z',
    })),
    createCandidate: vi.fn(async (input) => ({
      id: 'candidate_123',
      state: 'ready' as const,
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      targetLabel: `current target for ${input.missionId}`,
    })),
    recordGate: vi.fn(async (input) => ({
      id: 'gate_123',
      candidateId: input.candidateId,
      kind: input.kind,
      status: 'passed' as const,
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      commandIds: [...input.commandIds],
      gatePolicyFingerprint: input.gatePolicyFingerprint,
      executorExecutionId: 'execution_gate123',
      executorProfileId: input.executorProfileId,
      evidence: ['privileged gate evidence'],
      createdAt: '2026-07-26T00:00:00.000Z',
    })),
    previewIntegration: vi.fn(async (input) => ({
      digest: 'e'.repeat(64),
      approvalId: 'approval_123',
      missionId: input.missionId,
      candidateId: input.candidateId,
      candidateCommitSha: 'a'.repeat(40),
      candidateTreeSha: 'b'.repeat(40),
      targetLabel: 'current workspace branch',
      expectedTargetCommitSha: 'c'.repeat(40),
      expectedTargetTreeSha: 'd'.repeat(40),
      testGateId: 'gate_test',
      reviewGateId: 'gate_review',
      approvalRevision: input.expectedRevision,
    })),
    approveIntegration: vi.fn(async () => ({
      missionId: 'mission_123',
      revision: 3,
      status: 'integrated' as const,
      resultingCommitSha: 'f'.repeat(40),
    })),
    rejectIntegration: vi.fn(async () => ({
      missionId: 'mission_123',
      revision: 3,
      status: 'rejected' as const,
    })),
  };
  const supervisor = {
    stopSession,
    logs,
    reply,
    startNewMember,
    startMember: vi.fn(),
    resumeMember: vi.fn(),
    clearBinding: vi.fn(),
    wakeSquad: vi.fn(),
    councilReviewNeedsReplacement: () => councilBound,
    startCouncilReview,
  } as unknown as AgentSupervisorPort;
  const afterAction = async <T>(result: CliResult<T>): Promise<UiResult<T>> =>
    result.ok
      ? { ok: true, value: result.value }
      : { ok: false, message: result.message, details: result.raw };
  const dependencies: CouncilIpcDependencies = {
    isTrusted: () => trusted,
    getState: () => undefined,
    chooseWorkspace: async () => ({ ok: false, message: 'not used' }),
    getSupervisor: () => supervisor,
    getMissionController: () => missionController,
    canLaunchDefinitions: () => true,
    confirmStartNew,
    confirmStartSquad,
    confirmMissionIntegration,
    afterAction,
  };
  registerCouncilIpc(registrar, dependencies);
  const invoke = async (channel: string, ...args: readonly unknown[]) =>
    handlers.get(channel)?.({}, ...args);
  return {
    invoke,
    stopSession,
    logs,
    reply,
    startNewMember,
    startCouncilReview,
    confirmStartNew,
    confirmStartSquad,
    confirmMissionIntegration,
    missionController,
  };
}

describe('typed privileged IPC handlers', () => {
  it('rejects an untrusted sender before invoking the supervisor', async () => {
    const f = fixture(false);
    const result = await f.invoke(IPC_CHANNELS.stopSession, 'profile-12345678');
    expect(result).toEqual({ ok: false, message: 'Untrusted IPC sender.' });
    expect(f.stopSession).not.toHaveBeenCalled();
  });

  it('rejects raw/unbound provider IDs, wrong types, and oversized IDs', async () => {
    const f = fixture();
    for (const value of ['deadbeef', 123, `profile-${'x'.repeat(200)}`]) {
      for (const [channel, extra] of [
        [IPC_CHANNELS.stopSession, []],
        [IPC_CHANNELS.logs, []],
        [IPC_CHANNELS.reply, ['ordinary text']],
      ] as const) {
        const result = await f.invoke(channel, value, ...extra);
        expect(result).toEqual({
          ok: false,
          message: 'Invalid opaque profile ID.',
        });
      }
    }
    expect(f.stopSession).not.toHaveBeenCalled();
    expect(f.logs).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('routes Stop, Logs, and Reply only through an opaque profile identity', async () => {
    const f = fixture();
    await f.invoke(IPC_CHANNELS.stopSession, 'profile-12345678');
    await f.invoke(IPC_CHANNELS.logs, 'profile-12345678');
    await f.invoke(IPC_CHANNELS.reply, 'profile-12345678', 'ordinary text');
    expect(f.stopSession).toHaveBeenCalledExactlyOnceWith('profile-12345678');
    expect(f.logs).toHaveBeenCalledExactlyOnceWith('profile-12345678');
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(
      'profile-12345678',
      'ordinary text',
    );
  });

  it('blocks control/oversized reply values before supervisor access', async () => {
    const f = fixture();
    await f.invoke(IPC_CHANNELS.reply, 'profile-12345678', 'two\nlines');
    await f.invoke(IPC_CHANNELS.reply, 'profile-12345678', 'x'.repeat(8_001));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('requires the privileged Start-new confirmation', async () => {
    const canceled = fixture(true, false);
    expect(
      await canceled.invoke(
        IPC_CHANNELS.startNewMember,
        'profile-12345678',
        'a'.repeat(64),
      ),
    ).toEqual({ ok: false, message: 'Start new was canceled.' });
    expect(canceled.startNewMember).not.toHaveBeenCalled();
  });

  it('blocks definition-based launches while the controller projection is stale', async () => {
    const f = fixture();
    const handlers = new Map<
      string,
      (event: unknown, ...args: readonly unknown[]) => unknown
    >();
    const startMember = vi.fn();
    const council = vi.fn();
    registerCouncilIpc(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      {
        isTrusted: () => true,
        getState: () => undefined,
        chooseWorkspace: async () => ({ ok: false, message: 'not used' }),
        getSupervisor: () =>
          ({
            startMember,
            startCouncilReview: council,
          }) as unknown as AgentSupervisorPort,
        getMissionController: () => undefined,
        canLaunchDefinitions: () => false,
        confirmStartNew: async () => true,
        confirmStartSquad: async () => true,
        confirmMissionIntegration: async () => true,
        afterAction: async <T>(result: CliResult<T>) =>
          result.ok
            ? { ok: true, value: result.value }
            : { ok: false, message: result.message },
      },
    );
    const startResult = await handlers.get(IPC_CHANNELS.startMember)?.(
      {},
      'profile-12345678',
      'a'.repeat(64),
    );
    const councilResult = await handlers.get(IPC_CHANNELS.council)?.(
      {},
      'review this',
    );
    expect(startResult).toMatchObject({ ok: false });
    expect(councilResult).toMatchObject({ ok: false });
    expect(startMember).not.toHaveBeenCalled();
    expect(council).not.toHaveBeenCalled();
    // Exact-session operations are deliberately independent of definition
    // freshness; their own binding and runtime authorization still applies.
    expect(f.stopSession).not.toHaveBeenCalled();
  });

  it('requires a SHA-256 fingerprint from the displayed definition for Start', async () => {
    const f = fixture();
    for (const fingerprint of [undefined, 'short', 'G'.repeat(64)]) {
      const result = await f.invoke(
        IPC_CHANNELS.startMember,
        'profile-12345678',
        fingerprint,
      );
      expect(result).toEqual({
        ok: false,
        message: 'Invalid displayed definition fingerprint.',
      });
    }
  });

  it('binds Council launch to its displayed fingerprint and confirms replacement', async () => {
    const fingerprint = 'c'.repeat(64);
    const first = fixture();
    await first.invoke(
      IPC_CHANNELS.council,
      'Review the release.',
      fingerprint,
    );
    expect(first.confirmStartNew).not.toHaveBeenCalled();
    expect(first.startCouncilReview).toHaveBeenCalledExactlyOnceWith(
      'Review the release.',
      fingerprint,
      false,
    );

    const canceled = fixture(true, false, true);
    expect(
      await canceled.invoke(
        IPC_CHANNELS.council,
        'Replace the prior review.',
        fingerprint,
      ),
    ).toEqual({ ok: false, message: 'Start new was canceled.' });
    expect(canceled.confirmStartNew).toHaveBeenCalledOnce();
    expect(canceled.startCouncilReview).not.toHaveBeenCalled();

    const confirmed = fixture(true, true, true);
    await confirmed.invoke(
      IPC_CHANNELS.council,
      'Replace the prior review.',
      fingerprint,
    );
    expect(confirmed.startCouncilReview).toHaveBeenCalledExactlyOnceWith(
      'Replace the prior review.',
      fingerprint,
      true,
    );
  });

  it('rejects a missing or malformed displayed Council fingerprint', async () => {
    const f = fixture();
    for (const fingerprint of [undefined, 'short', 'G'.repeat(64)]) {
      const result = await f.invoke(
        IPC_CHANNELS.council,
        'Review this.',
        fingerprint,
      );
      expect(result).toEqual({
        ok: false,
        message: 'Invalid displayed Council definition fingerprint.',
      });
    }
    expect(f.startCouncilReview).not.toHaveBeenCalled();
  });

  it('routes a valid squad preview through opaque IDs with an explicit provider per role', async () => {
    const f = fixture();
    const input = {
      missionId: 'mission_123',
      expectedRevision: 7,
      selections: [
        {
          taskId: 'task_123',
          profileId: 'profile-12345678',
          providerId: 'codex',
          expectedDefinitionFingerprint: 'a'.repeat(64),
          writeCapable: true,
        },
        {
          taskId: 'task_test123',
          profileId: 'profile-test0001',
          providerId: 'claude-code',
          expectedDefinitionFingerprint: 'b'.repeat(64),
          writeCapable: false,
        },
        {
          taskId: 'task_review123',
          profileId: 'profile-review01',
          providerId: 'codex',
          expectedDefinitionFingerprint: 'c'.repeat(64),
          writeCapable: false,
        },
      ],
      gateAssignments: {
        testProfileId: 'profile-test0001',
        reviewProfileId: 'profile-review01',
      },
    } as const;
    const result = await f.invoke(IPC_CHANNELS.previewSquad, input);
    expect(result).toMatchObject({ ok: true });
    expect(f.missionController.previewSquad).toHaveBeenCalledExactlyOnceWith(
      input,
    );
  });

  it('rejects raw mission launch authority before the controller boundary', async () => {
    const f = fixture();
    const result = await f.invoke(IPC_CHANNELS.previewSquad, {
      missionId: 'mission_123',
      expectedRevision: 7,
      selections: [
        {
          taskId: 'task_123',
          profileId: 'profile-12345678',
          providerId: 'codex',
          expectedDefinitionFingerprint: 'a'.repeat(64),
          writeCapable: true,
          cwd: '/tmp/untrusted',
          argv: ['--untrusted'],
        },
        {
          taskId: 'task_test123',
          profileId: 'profile-test0001',
          providerId: 'claude-code',
          expectedDefinitionFingerprint: 'b'.repeat(64),
          writeCapable: false,
        },
        {
          taskId: 'task_review123',
          profileId: 'profile-review01',
          providerId: 'codex',
          expectedDefinitionFingerprint: 'c'.repeat(64),
          writeCapable: false,
        },
      ],
      gateAssignments: {
        testProfileId: 'profile-test0001',
        reviewProfileId: 'profile-review01',
      },
    });
    expect(result).toEqual({
      ok: false,
      message: 'Invalid opaque squad preview request.',
    });
    expect(f.missionController.previewSquad).not.toHaveBeenCalled();
  });

  it('retries only an opaque blocked execution identity at an exact revision', async () => {
    const f = fixture();
    const input = {
      expectedRevision: 8,
      executionId: 'execution_123',
    };
    const result = await f.invoke(
      IPC_CHANNELS.retryMissionExecution,
      input,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        revision: 9,
        execution: {
          id: 'execution_123',
          providerId: 'codex',
          state: 'running',
        },
      },
    });
    expect(
      f.missionController.retryBlockedExecution,
    ).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('rejects renderer-supplied provider or path authority for Mission retries', async () => {
    const f = fixture();
    for (const extra of [
      { providerId: 'codex' },
      { cwd: '/tmp/untrusted' },
      { argv: ['--dangerous'] },
    ]) {
      const result = await f.invoke(IPC_CHANNELS.retryMissionExecution, {
        expectedRevision: 8,
        executionId: 'execution_123',
        ...extra,
      });
      expect(result).toEqual({
        ok: false,
        message: 'Invalid blocked Mission execution retry.',
      });
    }
    expect(
      f.missionController.retryBlockedExecution,
    ).not.toHaveBeenCalled();
  });

  it('routes handoff, candidate, and gate plans without raw Git mutation authority', async () => {
    const f = fixture();
    const handoff = {
      expectedRevision: 8,
      taskId: 'task_123',
      executionId: 'execution_123',
      claimedCommitSha: 'a'.repeat(40),
      claimedTreeSha: 'b'.repeat(40),
      summary: 'Ready for gates.',
      evidence: ['tests passed'],
      risks: [],
    };
    const candidate = {
      expectedRevision: 9,
      missionId: 'mission_123',
      orderedHandoffIds: ['handoff_123'],
    };
    const gate = {
      expectedRevision: 10,
      candidateId: 'candidate_123',
      kind: 'test',
      commandIds: ['typecheck'],
      gatePolicyFingerprint: 'c'.repeat(64),
      executorProfileId: 'profile-12345678',
    } as const;
    await f.invoke(IPC_CHANNELS.recordHandoff, handoff);
    await f.invoke(IPC_CHANNELS.createCandidate, candidate);
    await f.invoke(IPC_CHANNELS.recordGate, gate);
    expect(f.missionController.recordHandoff).toHaveBeenCalledWith(handoff);
    expect(f.missionController.createCandidate).toHaveBeenCalledWith(candidate);
    expect(f.missionController.recordGate).toHaveBeenCalledWith(gate);
  });

  it('prevents the renderer from supplying a gate verdict, object IDs, or evidence', async () => {
    const f = fixture();
    const result = await f.invoke(IPC_CHANNELS.recordGate, {
      expectedRevision: 10,
      candidateId: 'candidate_123',
      kind: 'review',
      commandIds: [],
      gatePolicyFingerprint: 'c'.repeat(64),
      executorProfileId: 'profile-12345678',
      status: 'passed',
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      evidence: ['self-certified'],
    });
    expect(result).toEqual({
      ok: false,
      message: 'Invalid bounded gate request.',
    });
    expect(f.missionController.recordGate).not.toHaveBeenCalled();
  });

  it('requires confirmation and a single-use digest for Start Squad and integration approval', async () => {
    const canceled = fixture(true, false);
    expect(
      await canceled.invoke(IPC_CHANNELS.startSquad, 'd'.repeat(64)),
    ).toEqual({ ok: false, message: 'Start Squad was canceled.' });
    expect(canceled.missionController.startSquad).not.toHaveBeenCalled();

    const confirmed = fixture();
    await confirmed.invoke(IPC_CHANNELS.startSquad, 'd'.repeat(64));
    expect(confirmed.confirmStartSquad).toHaveBeenCalledOnce();
    expect(
      confirmed.missionController.startSquad,
    ).toHaveBeenCalledExactlyOnceWith('d'.repeat(64));

    await confirmed.invoke(
      IPC_CHANNELS.approveIntegration,
      'e'.repeat(64),
    );
    expect(confirmed.confirmMissionIntegration).toHaveBeenCalledOnce();
    expect(
      confirmed.missionController.approveIntegration,
    ).toHaveBeenCalledExactlyOnceWith('e'.repeat(64));
  });

  it('rejects untrusted Mission requests before controller access', async () => {
    const f = fixture(false);
    const result = await f.invoke(IPC_CHANNELS.getMissionState);
    expect(result).toEqual({ ok: false, message: 'Untrusted IPC sender.' });
    expect(f.missionController.getState).not.toHaveBeenCalled();
  });
});
