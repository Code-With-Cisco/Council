import { createHash } from 'node:crypto';
import type { MissionProviderStatus } from '../providers/missionContracts.js';
import type { GateRunner } from '../missions/gateRunner.js';
import type {
  MissionLedgerStore,
  MissionLedgerStoreState,
} from '../missions/ledger.js';
import type { MissionCoordinator } from '../missions/coordinator.js';
import { projectMissionLedger } from '../missions/projection.js';
import type { MissionProviderRouter } from '../missions/providerRouter.js';
import type {
  HandoffRecord,
  IntegrationCandidateRecord,
  MissionExecutionRecord,
  MissionGateRecord,
  MissionLedgerFileV1,
  MissionTaskRecord,
} from '../missions/types.js';
import type {
  MissionUiController,
  UiCreateCandidateInput,
  UiCreateMissionInput,
  UiCreateMissionResult,
  UiIntegrationPreview,
  UiIntegrationResult,
  UiMissionAssignment,
  UiMissionCandidate,
  UiMissionGate,
  UiMissionHandoff,
  UiMissionProviderId,
  UiMissionProviderStatus,
  UiMissionState,
  UiMissionSummary,
  UiMissionTask,
  UiPreviewIntegrationInput,
  UiPreviewSquadInput,
  UiRecordGateInput,
  UiRecordHandoffInput,
  UiRetryMissionExecutionInput,
  UiRetryMissionExecutionResult,
  UiSquadStartPreview,
  UiSquadStartResult,
} from './missionUi.js';

export type MissionUiCoordinatorPort = Pick<
  MissionCoordinator,
  | 'createMission'
  | 'previewSquad'
  | 'startSquad'
  | 'retryBlockedExecution'
  | 'recordHandoff'
  | 'createCandidate'
  | 'recordGate'
  | 'previewIntegration'
  | 'approveAndIntegrate'
  | 'rejectIntegration'
>;

export type MissionUiProviderStatusPort = Pick<
  MissionProviderRouter,
  'statuses'
>;
export type MissionUiGateRunnerPort = Pick<GateRunner, 'preview' | 'run'>;
export type MissionUiLedgerPort = Pick<MissionLedgerStore, 'reload'>;

export interface PrivilegedMissionUiControllerOptions {
  readonly store: MissionUiLedgerPort;
  readonly coordinator: MissionUiCoordinatorPort;
  readonly providers: MissionUiProviderStatusPort;
  readonly gateRunner: MissionUiGateRunnerPort;
  readonly workspaceId: string;
  readonly publish?:
    | ((state: UiMissionState) => void | Promise<void>)
    | undefined;
}

export class MissionUiControllerError extends Error {
  override readonly name = 'MissionUiControllerError';
}

const PROVIDER_IDS = new Set<UiMissionProviderId>([
  'claude-code',
  'codex',
]);
const SHA_256 = /^[0-9a-f]{64}$/;
const MAX_PREVIEW_ROLE_INSTRUCTIONS = 24_000;
const UNSAFE_MULTILINE_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function uiProviderId(value: string): UiMissionProviderId | undefined {
  return PROVIDER_IDS.has(value as UiMissionProviderId)
    ? (value as UiMissionProviderId)
    : undefined;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function gateAttempts(
  ledger: MissionLedgerFileV1,
  candidateId: string,
  kind: 'test' | 'review',
): readonly MissionGateRecord[] {
  return Object.values(ledger.gates).filter(
    (gate) => gate.candidateId === candidateId && gate.kind === kind,
  );
}

/**
 * Deterministic key for one privileged gate attempt. It covers the exact
 * candidate, policy, and executor, plus the number of attempts already durable
 * in the ledger. A replayed submit whose outcome was never recorded therefore
 * returns the existing run instead of starting a second one, while an explicit
 * re-run after a recorded attempt is a distinct request.
 */
function gateIdempotencyKey(input: {
  readonly workspaceId: string;
  readonly missionId: string;
  readonly candidateId: string;
  readonly kind: 'test' | 'review';
  readonly commitSha: string;
  readonly treeSha: string;
  readonly gatePolicyFingerprint: string;
  readonly commandIds: readonly string[];
  readonly executorExecutionId: string;
  readonly executorProfileId: string;
  readonly priorAttempts: number;
}): string {
  const canonical = {
    version: 1,
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    candidateId: input.candidateId,
    kind: input.kind,
    commitSha: input.commitSha,
    treeSha: input.treeSha,
    gatePolicyFingerprint: input.gatePolicyFingerprint,
    commandIds: [...input.commandIds],
    executorExecutionId: input.executorExecutionId,
    executorProfileId: input.executorProfileId,
    priorAttempts: input.priorAttempts,
  };
  return `gate:${createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')}`;
}

function latestGateAttempt(
  ledger: MissionLedgerFileV1,
  candidateId: string,
  kind: 'test' | 'review',
): MissionGateRecord | undefined {
  return [...gateAttempts(ledger, candidateId, kind)]
    .sort((left, right) => {
      const byTime = right.createdAt.localeCompare(left.createdAt);
      return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
    })[0];
}

function safeDiagnostic(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > 2_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    /(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:[^/\s]+\/)+)/.test(value)
  ) {
    return 'Privileged diagnostic details were withheld.';
  }
  return value;
}

function mapProviderStatus(
  status: MissionProviderStatus,
): UiMissionProviderStatus | undefined {
  const providerId = uiProviderId(status.providerId);
  if (providerId === undefined) return undefined;
  return {
    providerId,
    displayName: status.displayName,
    available: status.available,
    authenticated: status.authenticated,
    // The provider router reports availability only after its protocol
    // boundary is usable. Authentication remains an independent signal.
    protocolReady: status.available,
    persistentConversations: status.persistentConversations,
    approvals: status.approvals,
    diagnostic: safeDiagnostic(status.diagnostic),
  };
}

function unavailableProvider(
  providerId: UiMissionProviderId,
): UiMissionProviderStatus {
  const displayName = providerId === 'claude-code' ? 'Claude Code' : 'Codex';
  return {
    providerId,
    displayName,
    available: false,
    authenticated: false,
    protocolReady: false,
    persistentConversations: true,
    approvals: providerId === 'codex',
    diagnostic: `${displayName} status is unavailable.`,
  };
}

function mapHandoff(handoff: HandoffRecord): UiMissionHandoff {
  return {
    id: handoff.id,
    taskId: handoff.taskId,
    commitSha: handoff.commitSha,
    treeSha: handoff.treeSha,
    summary: handoff.summary,
    createdAt: handoff.createdAt,
  };
}

function targetLabel(targetRef: string): string {
  if (
    targetRef.length === 0 ||
    targetRef.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(targetRef)
  ) {
    return 'current trusted workspace target';
  }
  return targetRef;
}

function mapCandidate(
  candidate: IntegrationCandidateRecord,
): UiMissionCandidate {
  return {
    id: candidate.id,
    state: candidate.state,
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    targetLabel: targetLabel(candidate.targetRef),
  };
}

function mapGate(gate: MissionGateRecord): UiMissionGate {
  return {
    id: gate.id,
    candidateId: gate.candidateId,
    kind: gate.kind,
    status: gate.status,
    commitSha: gate.commitSha,
    treeSha: gate.treeSha,
    commandIds: [...gate.commandIds],
    gatePolicyFingerprint: gate.gatePolicyFingerprint,
    executorExecutionId: gate.executorExecutionId,
    executorProfileId: gate.executorProfileId,
    evidence: [...gate.evidence],
    createdAt: gate.createdAt,
  };
}

function mapExecution(
  execution: MissionExecutionRecord | undefined,
): UiMissionTask['execution'] {
  if (execution === undefined) return undefined;
  const providerId = uiProviderId(execution.providerId);
  if (providerId === undefined) return undefined;
  return {
    id: execution.id,
    providerId,
    state: execution.state,
    accessMode: execution.accessMode,
    providerAction: execution.providerAction,
    gateResponsibility: execution.gateResponsibility,
    definitionFingerprint: execution.definitionFingerprint,
  };
}

function mapTask(
  ledger: MissionLedgerFileV1,
  task: MissionTaskRecord,
): UiMissionTask {
  const execution =
    task.executionId === undefined
      ? undefined
      : ledger.executions[task.executionId];
  const lease =
    task.worktreeLeaseId === undefined
      ? undefined
      : ledger.leases[task.worktreeLeaseId];
  const activeHandoff =
    task.activeHandoffId === undefined
      ? undefined
      : ledger.handoffs[task.activeHandoffId];
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    assigneeProfileId: task.assigneeProfileId,
    execution: mapExecution(execution),
    lease:
      lease === undefined
        ? undefined
        : {
            id: lease.id,
            state: lease.state,
            accessMode: lease.accessMode,
            baseCommitSha: lease.baseCommitSha,
          },
    activeHandoff:
      activeHandoff === undefined ? undefined : mapHandoff(activeHandoff),
  };
}

function mapMission(
  ledger: MissionLedgerFileV1,
  missionId: string,
): UiMissionSummary | undefined {
  const projected = projectMissionLedger(
    ledger,
    ledger.missions[missionId]?.workspaceId ?? '',
  )
    .missions.find((mission) => mission.id === missionId);
  if (projected === undefined) return undefined;
  const tasks = projected.tasks
    .map((task) => ledger.tasks[task.id])
    .filter((task) => task !== undefined)
    .map((task) => mapTask(ledger, task));
  return {
    id: projected.id,
    title: projected.title,
    objective: projected.objective,
    phase: projected.phase,
    tasks,
    latestCandidate:
      projected.latestCandidate === undefined
        ? undefined
        : mapCandidate(projected.latestCandidate),
    testGate:
      projected.testGate === undefined
        ? undefined
        : mapGate(projected.testGate),
    reviewGate:
      projected.reviewGate === undefined
        ? undefined
        : mapGate(projected.reviewGate),
  };
}

function mapAssignments(
  ledger: MissionLedgerFileV1,
  workspaceId: string,
): Readonly<Record<string, readonly UiMissionAssignment[]>> {
  const projection = projectMissionLedger(ledger, workspaceId);
  const assignments: Record<string, UiMissionAssignment[]> =
    Object.create(null) as Record<string, UiMissionAssignment[]>;
  for (const [profileId, values] of Object.entries(
    projection.assignmentsByProfileId,
  )) {
    assignments[profileId] = values.map((assignment) => {
      const task = ledger.tasks[assignment.taskId];
      const execution =
        task?.executionId === undefined
          ? undefined
          : ledger.executions[task.executionId];
      return {
        profileId,
        missionId: assignment.missionId,
        missionTitle: assignment.missionTitle,
        taskId: assignment.taskId,
        taskTitle: assignment.taskTitle,
        taskState: assignment.taskState,
        providerId:
          execution === undefined
            ? undefined
            : uiProviderId(execution.providerId),
      };
    });
  }
  return assignments;
}

function ledgerProblem(
  state: MissionLedgerStoreState,
): string | undefined {
  return state.problem === undefined
    ? undefined
    : 'The Mission ledger is malformed or unavailable. Its last-known-good projection is read-only until repaired.';
}

/**
 * Trusted adapter between the renderer-safe Mission port and privileged
 * Mission/provider/Git orchestration.
 */
export class PrivilegedMissionUiController implements MissionUiController {
  private readonly store: MissionUiLedgerPort;
  private readonly coordinator: MissionUiCoordinatorPort;
  private readonly providers: MissionUiProviderStatusPort;
  private readonly gateRunner: MissionUiGateRunnerPort;
  private readonly workspaceId: string;
  private readonly publishCallback:
    | ((state: UiMissionState) => void | Promise<void>)
    | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: PrivilegedMissionUiControllerOptions) {
    if (
      options.workspaceId.trim() === '' ||
      options.workspaceId.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(options.workspaceId)
    ) {
      throw new TypeError(
        'Mission UI workspace ID must be a bounded opaque value.',
      );
    }
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.providers = options.providers;
    this.gateRunner = options.gateRunner;
    this.workspaceId = options.workspaceId;
    this.publishCallback = options.publish;
  }

  getState(): Promise<UiMissionState> {
    return this.enqueue(() => this.buildState());
  }

  createMission(input: UiCreateMissionInput): Promise<UiCreateMissionResult> {
    return this.enqueue(async () => {
      const mission = await this.coordinator.createMission({
        expectedRevision: input.expectedRevision,
        workspaceId: this.workspaceId,
        title: input.title,
        objective: input.objective,
        tasks: input.tasks.map((task) => ({
          title: task.title,
          description: task.description,
        })),
      });
      const state = await this.publishCurrent();
      const mapped = state.projection?.missions.find(
        (candidate) => candidate.id === mission.id,
      );
      if (mapped === undefined) {
        throw new MissionUiControllerError(
          'Created Mission was not present in the durable projection.',
        );
      }
      return {
        revision: state.revision,
        mission: mapped,
      };
    });
  }

  previewSquad(input: UiPreviewSquadInput): Promise<UiSquadStartPreview> {
    return this.enqueue(async () => {
      const preview = await this.coordinator.previewSquad(
        input.missionId,
        input.expectedRevision,
        input.selections.map((selection) => ({
          taskId: selection.taskId,
          profileId: selection.profileId,
          providerId: selection.providerId,
          expectedDefinitionFingerprint:
            selection.expectedDefinitionFingerprint,
          writeCapable: selection.writeCapable,
        })),
        {
          testProfileId: input.gateAssignments.testProfileId,
          reviewProfileId: input.gateAssignments.reviewProfileId,
        },
      );
      const participants = preview.participants.map((participant) => {
        const selection = input.selections.find(
          (candidate) => candidate.taskId === participant.taskId,
        );
        const providerId = uiProviderId(participant.provider.providerId);
        if (
          selection === undefined ||
          selection.profileId !== participant.profileId ||
          providerId === undefined ||
          providerId !== selection.providerId ||
          participant.provider.definitionFingerprint !==
            selection.expectedDefinitionFingerprint ||
          !SHA_256.test(
            participant.provider.roleInstructionFingerprint,
          ) ||
          typeof participant.provider.providerAvailable !==
            'boolean' ||
          typeof participant.provider.providerAuthenticated !==
            'boolean' ||
          typeof participant.provider.protocolReady !== 'boolean'
        ) {
          throw new MissionUiControllerError(
            'Privileged squad preview did not match the selected task, profile, and provider.',
          );
        }
        return {
          taskId: participant.taskId,
          profileId: participant.profileId,
          providerId,
          definitionFingerprint:
            participant.provider.definitionFingerprint,
          roleInstructions:
            participant.provider.roleInstructions === undefined
              ? undefined
              : participant.provider.roleInstructions.length <=
                    MAX_PREVIEW_ROLE_INSTRUCTIONS &&
                  !UNSAFE_MULTILINE_CONTROL.test(
                    participant.provider.roleInstructions,
                  )
                ? participant.provider.roleInstructions
                : (() => {
                    throw new MissionUiControllerError(
                      'Privileged role instructions exceeded the safe renderer contract.',
                    );
                  })(),
          roleInstructionFingerprint:
            participant.provider.roleInstructionFingerprint,
          providerAvailable:
            participant.provider.providerAvailable,
          providerAuthenticated:
            participant.provider.providerAuthenticated,
          protocolReady: participant.provider.protocolReady,
          providerAction: participant.provider.action,
          launchable: participant.provider.launchable,
          accessMode:
            participant.lease === undefined
              ? ('read-only' as const)
              : ('workspace-write' as const),
          leaseId: participant.lease?.leaseId,
          baseCommitSha: participant.lease?.baseCommitSha,
          diagnostic: safeDiagnostic(participant.provider.diagnostic),
        };
      });
      const mapGateAssignment = (kind: 'test' | 'review') => {
        const assignment = preview.gateAssignments[kind];
        const expectedProfileId =
          kind === 'test'
            ? input.gateAssignments.testProfileId
            : input.gateAssignments.reviewProfileId;
        const participant = participants.find(
          (candidate) => candidate.profileId === expectedProfileId,
        );
        if (
          assignment.kind !== kind ||
          assignment.profileId !== expectedProfileId ||
          assignment.taskId === undefined ||
          assignment.taskId !== participant?.taskId ||
          assignment.executionIntent !==
            'allocate-read-only-on-start' ||
          participant.accessMode !== 'read-only'
        ) {
          throw new MissionUiControllerError(
            `Privileged ${kind === 'test' ? 'Test' : 'Review'} gate assignment did not match the selected read-only role.`,
          );
        }
        return {
          kind,
          taskId: assignment.taskId,
          profileId: expectedProfileId,
          executionIntent:
            'allocate-read-only-on-start' as const,
        };
      };
      return {
        digest: preview.digest,
        missionId: preview.missionId,
        revision: preview.ledgerRevision,
        repositoryHeadSha: preview.repository.commitSha,
        participants,
        gateAssignments: {
          test: mapGateAssignment('test'),
          review: mapGateAssignment('review'),
        },
        blockers: preview.blockers.map(
          (blocker) => safeDiagnostic(blocker) ?? 'Mission preview blocker.',
        ),
      };
    });
  }

  startSquad(previewDigest: string): Promise<UiSquadStartResult> {
    return this.enqueue(async () => {
      const result = await this.coordinator.startSquad(previewDigest);
      await this.publishCurrent();
      return {
        missionId: result.missionId,
        revision: result.revision,
        startedTaskIds: result.executions.map((execution) => execution.taskId),
        failures: result.failures.map((failure) => ({
          taskId: failure.taskId,
          message:
            safeDiagnostic(failure.message) ?? 'Mission assignment failed.',
        })),
      };
    });
  }

  retryBlockedExecution(
    input: UiRetryMissionExecutionInput,
  ): Promise<UiRetryMissionExecutionResult> {
    return this.enqueue(async () => {
      const loaded = await this.requireCurrentLedger(
        input.expectedRevision,
      );
      const current = loaded.data.executions[input.executionId];
      if (
        current === undefined ||
        current.workspaceId !== this.workspaceId ||
        current.state !== 'blocked'
      ) {
        throw new MissionUiControllerError(
          'Only an exact blocked execution in this workspace can be retried.',
        );
      }
      const retried = await this.coordinator.retryBlockedExecution(
        input.executionId,
        input.expectedRevision,
      );
      if (
        retried.id !== current.id ||
        retried.workspaceId !== this.workspaceId
      ) {
        throw new MissionUiControllerError(
          'Retried execution did not match the exact blocked assignment.',
        );
      }
      const execution = mapExecution(retried);
      if (execution === undefined) {
        throw new MissionUiControllerError(
          'Retried execution reported an unsupported provider.',
        );
      }
      const state = await this.publishCurrent();
      return { revision: state.revision, execution };
    });
  }

  recordHandoff(input: UiRecordHandoffInput): Promise<UiMissionHandoff> {
    return this.enqueue(async () => {
      const handoff = await this.coordinator.recordHandoff({
        expectedRevision: input.expectedRevision,
        taskId: input.taskId,
        executionId: input.executionId,
        claimedCommitSha: input.claimedCommitSha,
        claimedTreeSha: input.claimedTreeSha,
        summary: input.summary,
        evidence: [...input.evidence],
        risks: [...input.risks],
        ...(input.supersedesHandoffId === undefined
          ? {}
          : { supersedesHandoffId: input.supersedesHandoffId }),
      });
      await this.publishCurrent();
      return mapHandoff(handoff);
    });
  }

  createCandidate(input: UiCreateCandidateInput): Promise<UiMissionCandidate> {
    return this.enqueue(async () => {
      const candidate = await this.coordinator.createCandidate({
        expectedRevision: input.expectedRevision,
        missionId: input.missionId,
        orderedHandoffIds: [...input.orderedHandoffIds],
      });
      await this.publishCurrent();
      return mapCandidate(candidate);
    });
  }

  recordGate(input: UiRecordGateInput): Promise<UiMissionGate> {
    return this.enqueue(async () => {
      const loaded = await this.requireCurrentLedger(input.expectedRevision);
      const policy = this.gateRunner.preview(input.kind);
      if (
        policy.gatePolicyFingerprint !== input.gatePolicyFingerprint ||
        !sameStrings(policy.commandIds, input.commandIds)
      ) {
        throw new MissionUiControllerError(
          'Gate policy changed after it was displayed. Review a fresh gate plan.',
        );
      }
      const candidate = loaded.data.candidates[input.candidateId];
      if (
        candidate === undefined ||
        candidate.workspaceId !== this.workspaceId ||
        candidate.state !== 'ready'
      ) {
        throw new MissionUiControllerError(
          'Gate candidate is missing or no longer current.',
        );
      }
      const executor = this.resolveGateExecutor(
        loaded.data,
        candidate,
        input,
      );
      const result = await this.gateRunner.run({
        idempotencyKey: gateIdempotencyKey({
          workspaceId: this.workspaceId,
          missionId: candidate.missionId,
          candidateId: candidate.id,
          kind: input.kind,
          commitSha: candidate.commitSha,
          treeSha: candidate.treeSha,
          gatePolicyFingerprint: policy.gatePolicyFingerprint,
          commandIds: policy.commandIds,
          executorExecutionId: executor.id,
          executorProfileId: executor.profileId,
          priorAttempts: gateAttempts(
            loaded.data,
            candidate.id,
            input.kind,
          ).length,
        }),
        workspaceId: this.workspaceId,
        missionId: candidate.missionId,
        candidateId: candidate.id,
        executorExecutionId: executor.id,
        executorProfileId: executor.profileId,
        kind: input.kind,
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
        expectedGatePolicyFingerprint: policy.gatePolicyFingerprint,
      });
      if (
        result.candidateId !== candidate.id ||
        result.kind !== input.kind ||
        result.commitSha !== candidate.commitSha ||
        result.treeSha !== candidate.treeSha ||
        result.gatePolicyFingerprint !== policy.gatePolicyFingerprint ||
        !sameStrings(result.commandIds, policy.commandIds)
      ) {
        throw new MissionUiControllerError(
          'Privileged gate result did not match the exact candidate and policy.',
        );
      }
      const gate = await this.coordinator.recordGate({
        expectedRevision: input.expectedRevision,
        candidateId: candidate.id,
        kind: result.kind,
        status: result.status,
        commitSha: result.commitSha,
        treeSha: result.treeSha,
        commandIds: result.commandIds,
        gatePolicyFingerprint: result.gatePolicyFingerprint,
        executorExecutionId: executor.id,
        executorProfileId: executor.profileId,
        evidence: result.evidence,
      });
      await this.publishCurrent();
      return mapGate(gate);
    });
  }

  previewIntegration(
    input: UiPreviewIntegrationInput,
  ): Promise<UiIntegrationPreview> {
    return this.enqueue(async () => {
      const loaded = await this.requireCurrentLedger(
        input.expectedRevision,
      );
      this.assertCurrentIntegrationGates(loaded.data, input);
      const preview = await this.coordinator.previewIntegration(
        input.missionId,
        input.candidateId,
        input.expectedRevision,
      );
      await this.publishCurrent();
      return {
        digest: preview.digest,
        approvalId: preview.approvalId,
        missionId: preview.missionId,
        candidateId: preview.candidateId,
        candidateCommitSha: preview.candidateCommitSha,
        candidateTreeSha: preview.candidateTreeSha,
        targetLabel: targetLabel(preview.targetRef),
        expectedTargetCommitSha: preview.expectedTargetCommitSha,
        expectedTargetTreeSha: preview.expectedTargetTreeSha,
        testGateId: preview.testGateId,
        reviewGateId: preview.reviewGateId,
        approvalRevision: preview.approvalRevision,
      };
    });
  }

  approveIntegration(previewDigest: string): Promise<UiIntegrationResult> {
    return this.enqueue(async () => {
      const loaded = await this.requirePendingApproval(previewDigest);
      const integrated = await this.coordinator.approveAndIntegrate(
        previewDigest,
      );
      const state = await this.publishCurrent();
      return {
        missionId: loaded.missionId,
        revision: state.revision,
        status: 'integrated',
        resultingCommitSha: integrated.commitSha,
      };
    });
  }

  rejectIntegration(previewDigest: string): Promise<UiIntegrationResult> {
    return this.enqueue(async () => {
      const loaded = await this.requirePendingApproval(previewDigest);
      await this.coordinator.rejectIntegration(previewDigest);
      const state = await this.publishCurrent();
      return {
        missionId: loaded.missionId,
        revision: state.revision,
        status: 'rejected',
      };
    });
  }

  private async buildState(): Promise<UiMissionState> {
    const loaded = await this.store.reload();
    const problem = ledgerProblem(loaded);
    const rawStatuses = this.providers.statuses();
    const mappedStatuses = rawStatuses
      .map(mapProviderStatus)
      .filter((status) => status !== undefined);
    const providerById = new Map(
      mappedStatuses.map((status) => [status.providerId, status] as const),
    );
    const testPolicy = this.gateRunner.preview('test');
    const reviewPolicy = this.gateRunner.preview('review');
    const policyMatches =
      testPolicy.gatePolicyFingerprint ===
      reviewPolicy.gatePolicyFingerprint;
    const projection = projectMissionLedger(
      loaded.data,
      this.workspaceId,
    );
    return {
      status: problem === undefined ? 'ready' : 'blocked',
      workspaceId: this.workspaceId,
      revision: loaded.data.revision,
      problem:
        problem ??
        (policyMatches
          ? undefined
          : 'Test and Review gate policy previews do not share one fingerprint.'),
      providers: (['claude-code', 'codex'] as const).map(
        (providerId) =>
          providerById.get(providerId) ?? unavailableProvider(providerId),
      ),
      gatePolicy: policyMatches
        ? {
            fingerprint: testPolicy.gatePolicyFingerprint,
            testCommandIds: [...testPolicy.commandIds],
            reviewCommandIds: [...reviewPolicy.commandIds],
            diagnostic: undefined,
          }
        : undefined,
      projection: {
        workspaceId: this.workspaceId,
        revision: projection.revision,
        missions: projection.missions
          .map((mission) => mapMission(loaded.data, mission.id))
          .filter((mission) => mission !== undefined),
        assignmentsByProfileId: mapAssignments(
          loaded.data,
          this.workspaceId,
        ),
      },
    };
  }

  private async publishCurrent(): Promise<UiMissionState> {
    const state = await this.buildState();
    try {
      await this.publishCallback?.(state);
    } catch {
      // A renderer notification failure must not turn a committed Mission
      // mutation into a reported domain failure.
    }
    return state;
  }

  private async requireCurrentLedger(
    expectedRevision: number,
  ): Promise<MissionLedgerStoreState> {
    const loaded = await this.store.reload();
    if (loaded.problem !== undefined) {
      throw new MissionUiControllerError(
        'Mission ledger is unavailable; privileged actions are blocked.',
      );
    }
    if (loaded.data.revision !== expectedRevision) {
      throw new MissionUiControllerError(
        'Mission state changed. Refresh before continuing.',
      );
    }
    return loaded;
  }

  private resolveGateExecutor(
    ledger: MissionLedgerFileV1,
    candidate: IntegrationCandidateRecord,
    input: UiRecordGateInput,
  ): MissionExecutionRecord {
    const producerExecutionIds = new Set(
      candidate.orderedHandoffIds
        .map((handoffId) => ledger.handoffs[handoffId]?.executionId)
        .filter((executionId) => executionId !== undefined),
    );
    const producerProfileIds = new Set(
      [...producerExecutionIds]
        .map((executionId) => ledger.executions[executionId]?.profileId)
        .filter((profileId) => profileId !== undefined),
    );
    const otherKind = input.kind === 'test' ? 'review' : 'test';
    const otherExecutors = Object.values(ledger.gates).filter(
      (gate) =>
        gate.candidateId === candidate.id && gate.kind === otherKind,
    );
    const candidates = Object.values(ledger.executions).filter(
      (execution) =>
        execution.workspaceId === this.workspaceId &&
        execution.missionId === candidate.missionId &&
        execution.profileId === input.executorProfileId &&
        execution.providerResourceId !== undefined &&
        execution.accessMode === 'read-only' &&
        execution.gateResponsibility === input.kind &&
        (execution.state === 'running' ||
          execution.state === 'completed') &&
        !producerExecutionIds.has(execution.id) &&
        !producerProfileIds.has(execution.profileId) &&
        !otherExecutors.some(
          (gate) =>
            gate.executorExecutionId === execution.id ||
            gate.executorProfileId === execution.profileId,
        ),
    );
    if (candidates.length !== 1) {
      throw new MissionUiControllerError(
        candidates.length === 0
          ? 'The selected gate executor is not an independent active Mission execution.'
          : 'The selected gate profile has multiple eligible Mission executions.',
      );
    }
    return candidates[0]!;
  }

  private assertCurrentIntegrationGates(
    ledger: MissionLedgerFileV1,
    input: UiPreviewIntegrationInput,
  ): void {
    const mission = ledger.missions[input.missionId];
    const candidate = ledger.candidates[input.candidateId];
    if (
      mission === undefined ||
      mission.workspaceId !== this.workspaceId ||
      candidate === undefined ||
      candidate.missionId !== mission.id ||
      candidate.workspaceId !== this.workspaceId ||
      candidate.state !== 'ready'
    ) {
      throw new MissionUiControllerError(
        'Integration candidate is missing or no longer current.',
      );
    }
    const testGate = latestGateAttempt(ledger, candidate.id, 'test');
    const reviewGate = latestGateAttempt(ledger, candidate.id, 'review');
    if (
      testGate?.status !== 'passed' ||
      reviewGate?.status !== 'passed'
    ) {
      throw new MissionUiControllerError(
        'The latest Test and Review gate attempts must both pass.',
      );
    }
    const testPolicy = this.gateRunner.preview('test');
    const reviewPolicy = this.gateRunner.preview('review');
    if (
      testPolicy.gatePolicyFingerprint !==
        reviewPolicy.gatePolicyFingerprint ||
      testGate.gatePolicyFingerprint !==
        testPolicy.gatePolicyFingerprint ||
      reviewGate.gatePolicyFingerprint !==
        reviewPolicy.gatePolicyFingerprint ||
      !sameStrings(testGate.commandIds, testPolicy.commandIds) ||
      !sameStrings(reviewGate.commandIds, reviewPolicy.commandIds)
    ) {
      throw new MissionUiControllerError(
        'Gate policy changed after the recorded results. Run both gates again.',
      );
    }
    if (
      testGate.commitSha !== candidate.commitSha ||
      testGate.treeSha !== candidate.treeSha ||
      reviewGate.commitSha !== candidate.commitSha ||
      reviewGate.treeSha !== candidate.treeSha
    ) {
      throw new MissionUiControllerError(
        'Gate results do not cover the exact current candidate.',
      );
    }
    if (
      testGate.executorExecutionId === reviewGate.executorExecutionId ||
      testGate.executorProfileId === reviewGate.executorProfileId
    ) {
      throw new MissionUiControllerError(
        'Test and Review require independent Mission executions.',
      );
    }
  }

  private async requirePendingApproval(
    previewDigest: string,
  ): Promise<{ readonly missionId: string }> {
    const loaded = await this.store.reload();
    if (loaded.problem !== undefined) {
      throw new MissionUiControllerError(
        'Mission ledger is unavailable; integration is blocked.',
      );
    }
    const approval = Object.values(loaded.data.approvals).find(
      (candidate) =>
        candidate.previewDigest === previewDigest &&
        candidate.status === 'pending',
    );
    if (approval === undefined) {
      throw new MissionUiControllerError(
        'Integration preview is stale, unknown, or already used.',
      );
    }
    return { missionId: approval.missionId };
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
