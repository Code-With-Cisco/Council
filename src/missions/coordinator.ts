import { createHash, randomUUID } from 'node:crypto';
import { isValidProfileId } from '../profileIdentity.js';
import {
  type MissionLedgerStore,
  type MutableMissionLedger,
} from './ledger.js';
import type {
  HandoffRecord,
  IntegrationApprovalId,
  IntegrationApprovalRecord,
  IntegrationCandidateId,
  IntegrationCandidateRecord,
  IntegrationPreview,
  MissionExecutionId,
  MissionExecutionRecord,
  MissionGateKind,
  MissionGateRecord,
  MissionGateStatus,
  MissionId,
  MissionLedgerEventKind,
  MissionLedgerFileV1,
  MissionRecord,
  MissionTaskId,
  ProviderStartPreview,
  RepositoryTargetSnapshot,
  SquadParticipantPreview,
  SquadSelection,
  SquadStartPreview,
  WorktreeLeasePreview,
  WorktreeLeaseRecord,
} from './types.js';

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

type MissionEntityKind =
  | 'mission'
  | 'task'
  | 'lease'
  | 'execution'
  | 'handoff'
  | 'candidate'
  | 'gate'
  | 'approval';

export interface MissionProviderPort {
  previewStart(request: {
    readonly missionId: MissionId;
    readonly taskId: MissionTaskId;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly expectedDefinitionFingerprint: string;
  }): Promise<ProviderStartPreview>;
  start(request: {
    readonly executionId: MissionExecutionId;
    readonly missionId: MissionId;
    readonly taskId: MissionTaskId;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly providerId: string;
    readonly expectedDefinitionFingerprint: string;
    readonly action: ProviderStartPreview['action'];
    readonly lease: ProvisionedWorktreeLease | undefined;
  }): Promise<{
    readonly providerId: string;
    readonly profileId: string;
    readonly providerResourceId: string;
  }>;
}

export interface ProvisionedWorktreeLease {
  readonly leaseId: string;
  readonly taskId: MissionTaskId;
  readonly branchName: string;
  readonly canonicalPath: string;
  readonly baseCommitSha: string;
  readonly baseTreeSha: string;
}

export interface MissionWorktreePort {
  previewLease(request: {
    readonly missionId: MissionId;
    readonly taskId: MissionTaskId;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly baseCommitSha: string;
    readonly baseTreeSha: string;
  }): Promise<WorktreeLeasePreview>;
  provisionLease(
    preview: WorktreeLeasePreview,
  ): Promise<ProvisionedWorktreeLease>;
}

export interface VerifiedHandoff {
  readonly baseCommitSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
}

export interface BuiltIntegrationCandidate {
  readonly targetRef: string;
  readonly baseCommitSha: string;
  readonly baseTreeSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
}

export interface IntegratedCandidate {
  readonly targetRef: string;
  readonly previousCommitSha: string;
  readonly previousTreeSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
}

export interface MissionGitPort {
  inspectTarget(request: {
    readonly workspaceId: string;
    readonly targetRef?: string | undefined;
  }): Promise<RepositoryTargetSnapshot>;
  verifyHandoff(request: {
    readonly workspaceId: string;
    readonly missionId: MissionId;
    readonly taskId: MissionTaskId;
    readonly lease: WorktreeLeaseRecord;
    readonly claimedCommitSha: string;
    readonly claimedTreeSha: string;
  }): Promise<VerifiedHandoff>;
  buildCandidate(request: {
    readonly workspaceId: string;
    readonly missionId: MissionId;
    readonly target: RepositoryTargetSnapshot;
    readonly handoffs: readonly HandoffRecord[];
  }): Promise<BuiltIntegrationCandidate>;
  integrateCandidate(request: {
    readonly workspaceId: string;
    readonly missionId: MissionId;
    readonly targetRef: string;
    readonly expectedTargetCommitSha: string;
    readonly expectedTargetTreeSha: string;
    readonly candidateCommitSha: string;
    readonly candidateTreeSha: string;
  }): Promise<IntegratedCandidate>;
}

export interface MissionCoordinatorOptions {
  readonly store: MissionLedgerStore;
  readonly provider: MissionProviderPort;
  readonly git: MissionGitPort;
  readonly worktrees: MissionWorktreePort;
  readonly now?: (() => Date) | undefined;
  readonly createId?:
    | ((kind: MissionEntityKind) => string)
    | undefined;
}

export interface CreateMissionInput {
  readonly expectedRevision: number;
  readonly workspaceId: string;
  readonly id?: MissionId | undefined;
  readonly title: string;
  readonly objective: string;
  readonly tasks: readonly {
    readonly id?: MissionTaskId | undefined;
    readonly title: string;
    readonly description: string;
    readonly dependsOn?: readonly MissionTaskId[] | undefined;
  }[];
}

export interface StartSquadResult {
  readonly missionId: MissionId;
  readonly revision: number;
  readonly executions: readonly MissionExecutionRecord[];
  readonly failures: readonly {
    readonly taskId: MissionTaskId;
    readonly message: string;
  }[];
}

export interface RecordHandoffInput {
  readonly expectedRevision: number;
  readonly taskId: MissionTaskId;
  readonly executionId: MissionExecutionId;
  readonly claimedCommitSha: string;
  readonly claimedTreeSha: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly supersedesHandoffId?: string | undefined;
}

export interface CreateCandidateInput {
  readonly expectedRevision: number;
  readonly missionId: MissionId;
  readonly targetRef?: string | undefined;
  readonly orderedHandoffIds: readonly string[];
}

export interface RecordGateInput {
  readonly expectedRevision: number;
  readonly candidateId: IntegrationCandidateId;
  readonly kind: MissionGateKind;
  readonly status: MissionGateStatus;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly executorProfileId: string;
  readonly evidence: readonly string[];
}

interface CachedSquadPlan {
  readonly preview: SquadStartPreview;
  readonly selections: readonly SquadSelection[];
}

export class MissionDomainError extends Error {
  override readonly name: string = 'MissionDomainError';
}

export class StaleMissionPlanError extends MissionDomainError {
  override readonly name: string = 'StaleMissionPlanError';
}

function boundedText(value: string, name: string, max: number): string {
  if (value.trim() === '') throw new MissionDomainError(`${name} must be non-empty.`);
  if (value.length > max) throw new MissionDomainError(`${name} is too long.`);
  if (CONTROL.test(value)) {
    throw new MissionDomainError(`${name} contains a control character.`);
  }
  return value;
}

function gitObject(value: string, name: string): string {
  if (!GIT_OBJECT_ID.test(value)) {
    throw new MissionDomainError(`${name} must be a full lowercase Git object ID.`);
  }
  return value;
}

function fingerprint(value: string, name: string): string {
  if (!SHA_256.test(value)) {
    throw new MissionDomainError(`${name} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameLease(
  preview: WorktreeLeasePreview,
  actual: ProvisionedWorktreeLease,
): boolean {
  return (
    preview.leaseId === actual.leaseId &&
    preview.taskId === actual.taskId &&
    preview.branchName === actual.branchName &&
    preview.canonicalPath === actual.canonicalPath &&
    preview.baseCommitSha === actual.baseCommitSha &&
    preview.baseTreeSha === actual.baseTreeSha
  );
}

function latestPassingGate(
  ledger: MissionLedgerFileV1,
  candidateId: string,
  kind: MissionGateKind,
): MissionGateRecord | undefined {
  return Object.values(ledger.gates)
    .filter(
      (gate) =>
        gate.candidateId === candidateId &&
        gate.kind === kind &&
        gate.status === 'passed',
    )
    .sort((left, right) => {
      const byTime = right.createdAt.localeCompare(left.createdAt);
      return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
    })[0];
}

/**
 * Serial Council Mission coordinator. All external effects are expressed as
 * semantic injected ports; no command, executable, cwd, or shell string is
 * accepted by this domain.
 */
export class MissionCoordinator {
  private readonly store: MissionLedgerStore;
  private readonly provider: MissionProviderPort;
  private readonly git: MissionGitPort;
  private readonly worktrees: MissionWorktreePort;
  private readonly now: () => Date;
  private readonly createId: (kind: MissionEntityKind) => string;
  private readonly squadPlans = new Map<string, CachedSquadPlan>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: MissionCoordinatorOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.git = options.git;
    this.worktrees = options.worktrees;
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ??
      ((kind) => `${kind}_${randomUUID().replaceAll('-', '')}`);
  }

  createMission(input: CreateMissionInput): Promise<MissionRecord> {
    return this.enqueue(async () => {
      boundedText(input.workspaceId, 'Workspace ID', 512);
      boundedText(input.title, 'Mission title', 512);
      boundedText(input.objective, 'Mission objective', 20_000);
      if (input.tasks.length === 0) {
        throw new MissionDomainError('A Mission requires at least one task.');
      }
      const missionId = input.id ?? this.createId('mission');
      const taskIds = input.tasks.map((task) => task.id ?? this.createId('task'));
      if (new Set(taskIds).size !== taskIds.length) {
        throw new MissionDomainError('Mission task IDs must be unique.');
      }
      const knownTaskIds = new Set(taskIds);
      const now = this.timestamp();
      const result = await this.store.transact(
        input.expectedRevision,
        (draft) => {
          if (draft.missions[missionId] !== undefined) {
            throw new MissionDomainError(`Mission "${missionId}" already exists.`);
          }
          const mission: MissionRecord = {
            id: missionId,
            workspaceId: input.workspaceId,
            title: input.title,
            objective: input.objective,
            phase: 'draft',
            taskIds,
            createdAt: now,
            updatedAt: now,
          };
          draft.missions[missionId] = mission;
          input.tasks.forEach((task, index) => {
            boundedText(task.title, `Task ${index + 1} title`, 512);
            boundedText(task.description, `Task ${index + 1} description`, 20_000);
            const taskId = taskIds[index]!;
            const dependsOn = [...(task.dependsOn ?? [])];
            if (
              dependsOn.some(
                (dependency) =>
                  !knownTaskIds.has(dependency) || dependency === taskId,
              )
            ) {
              throw new MissionDomainError(
                `Task "${taskId}" has an invalid dependency.`,
              );
            }
            draft.tasks[taskId] = {
              id: taskId,
              missionId,
              workspaceId: input.workspaceId,
              title: task.title,
              description: task.description,
              state: 'draft',
              dependsOn,
              handoffIds: [],
              createdAt: now,
              updatedAt: now,
            };
          });
          this.event(draft, 'mission-created', missionId, missionId, now);
          return mission;
        },
      );
      return result.value;
    });
  }

  previewSquad(
    missionId: MissionId,
    expectedRevision: number,
    selections: readonly SquadSelection[],
  ): Promise<SquadStartPreview> {
    return this.enqueue(async () => {
      const preview = await this.buildSquadPreview(
        missionId,
        expectedRevision,
        selections,
      );
      this.squadPlans.set(preview.digest, {
        preview,
        selections: structuredClone(selections),
      });
      return preview;
    });
  }

  startSquad(planDigest: string): Promise<StartSquadResult> {
    return this.enqueue(async () => {
      const cached = this.squadPlans.get(planDigest);
      this.squadPlans.delete(planDigest);
      if (cached === undefined) {
        throw new StaleMissionPlanError(
          'Start Squad preview is unknown, expired, or already used.',
        );
      }
      const fresh = await this.buildSquadPreview(
        cached.preview.missionId,
        cached.preview.ledgerRevision,
        cached.selections,
      );
      if (fresh.digest !== planDigest) {
        throw new StaleMissionPlanError(
          'Start Squad inputs changed after preview. Review a fresh plan.',
        );
      }
      if (fresh.blockers.length > 0) {
        throw new MissionDomainError(
          `Start Squad is blocked: ${fresh.blockers.join(' · ')}`,
        );
      }

      const now = this.timestamp();
      const executionIds = new Map<string, string>();
      for (const participant of fresh.participants) {
        executionIds.set(participant.taskId, this.createId('execution'));
      }
      let revision = fresh.ledgerRevision;
      const journal = await this.store.transact(revision, (draft) => {
        const mission = draft.missions[fresh.missionId];
        if (mission === undefined) {
          throw new StaleMissionPlanError('Mission disappeared before Start Squad.');
        }
        draft.missions[fresh.missionId] = {
          ...mission,
          phase: 'active',
          updatedAt: now,
        };
        for (const participant of fresh.participants) {
          const task = draft.tasks[participant.taskId];
          const executionId = executionIds.get(participant.taskId)!;
          if (task === undefined || task.state !== 'draft') {
            throw new StaleMissionPlanError(
              `Task "${participant.taskId}" is no longer startable.`,
            );
          }
          const leaseId = participant.lease?.leaseId;
          draft.tasks[task.id] = {
            ...task,
            state: 'queued',
            assigneeProfileId: participant.profileId,
            executionId,
            ...(leaseId === undefined ? {} : { worktreeLeaseId: leaseId }),
            updatedAt: now,
          };
          const execution: MissionExecutionRecord = {
            id: executionId,
            missionId: fresh.missionId,
            taskId: task.id,
            workspaceId: fresh.workspaceId,
            profileId: participant.profileId,
            providerId: participant.provider.providerId,
            state: 'starting',
            createdAt: now,
            updatedAt: now,
          };
          draft.executions[executionId] = execution;
          if (participant.lease !== undefined) {
            const lease: WorktreeLeaseRecord = {
              id: participant.lease.leaseId,
              missionId: fresh.missionId,
              taskId: task.id,
              workspaceId: fresh.workspaceId,
              branchName: participant.lease.branchName,
              canonicalPath: participant.lease.canonicalPath,
              baseCommitSha: participant.lease.baseCommitSha,
              baseTreeSha: participant.lease.baseTreeSha,
              state: 'provisioning',
              createdAt: now,
              updatedAt: now,
            };
            draft.leases[lease.id] = lease;
          }
        }
        this.event(
          draft,
          'squad-started',
          fresh.missionId,
          fresh.digest,
          now,
        );
      });
      revision = journal.revision;

      const executions: MissionExecutionRecord[] = [];
      const failures: { taskId: string; message: string }[] = [];
      for (const participant of fresh.participants) {
        const executionId = executionIds.get(participant.taskId)!;
        let provisioned: ProvisionedWorktreeLease | undefined;
        try {
          if (participant.lease !== undefined) {
            provisioned = await this.worktrees.provisionLease(participant.lease);
            if (!sameLease(participant.lease, provisioned)) {
              throw new MissionDomainError(
                `Worktree provision result for "${participant.taskId}" did not match its preview.`,
              );
            }
            const leaseTime = this.timestamp();
            const ready = await this.store.transact(revision, (draft) => {
              const lease = draft.leases[participant.lease!.leaseId];
              if (lease?.state !== 'provisioning') {
                throw new StaleMissionPlanError('Worktree lease journal changed.');
              }
              draft.leases[lease.id] = {
                ...lease,
                state: 'ready',
                updatedAt: leaseTime,
              };
            });
            revision = ready.revision;
          }

          const started = await this.provider.start({
            executionId,
            missionId: fresh.missionId,
            taskId: participant.taskId,
            workspaceId: fresh.workspaceId,
            profileId: participant.profileId,
            providerId: participant.provider.providerId,
            expectedDefinitionFingerprint:
              participant.provider.definitionFingerprint,
            action: participant.provider.action,
            lease: provisioned,
          });
          if (
            started.providerId !== participant.provider.providerId ||
            started.profileId !== participant.profileId ||
            started.providerResourceId.trim() === '' ||
            CONTROL.test(started.providerResourceId)
          ) {
            throw new MissionDomainError(
              `Provider start result for "${participant.taskId}" did not match its preview.`,
            );
          }
          const startedAt = this.timestamp();
          const committed = await this.store.transact(revision, (draft) => {
            const task = draft.tasks[participant.taskId];
            const execution = draft.executions[executionId];
            if (
              task?.executionId !== executionId ||
              execution?.state !== 'starting'
            ) {
              throw new StaleMissionPlanError('Execution journal changed during start.');
            }
            const running: MissionExecutionRecord = {
              ...execution,
              providerResourceId: started.providerResourceId,
              state: 'running',
              updatedAt: startedAt,
            };
            draft.executions[executionId] = running;
            draft.tasks[task.id] = {
              ...task,
              state: 'running',
              updatedAt: startedAt,
            };
            return running;
          });
          revision = committed.revision;
          executions.push(committed.value);
        } catch (error) {
          const message = messageFor(error);
          const failedAt = this.timestamp();
          const blocked = await this.store.transact(revision, (draft) => {
            const task = draft.tasks[participant.taskId];
            const execution = draft.executions[executionId];
            if (task !== undefined) {
              draft.tasks[task.id] = {
                ...task,
                state: 'blocked',
                updatedAt: failedAt,
              };
            }
            if (execution !== undefined) {
              draft.executions[execution.id] = {
                ...execution,
                state: 'blocked',
                updatedAt: failedAt,
              };
            }
          });
          revision = blocked.revision;
          failures.push({ taskId: participant.taskId, message });
        }
      }

      return {
        missionId: fresh.missionId,
        revision,
        executions,
        failures,
      };
    });
  }

  recordHandoff(input: RecordHandoffInput): Promise<HandoffRecord> {
    return this.enqueue(async () => {
      gitObject(input.claimedCommitSha, 'Handoff commit');
      gitObject(input.claimedTreeSha, 'Handoff tree');
      boundedText(input.summary, 'Handoff summary', 8_000);
      const ledger = await this.requireLedger(input.expectedRevision);
      const task = ledger.tasks[input.taskId];
      const execution = ledger.executions[input.executionId];
      const lease =
        task?.worktreeLeaseId === undefined
          ? undefined
          : ledger.leases[task.worktreeLeaseId];
      if (
        task === undefined ||
        execution?.taskId !== task.id ||
        task.executionId !== execution.id ||
        execution.providerResourceId === undefined ||
        lease?.taskId !== task.id ||
        lease.state !== 'ready'
      ) {
        throw new MissionDomainError(
          'A handoff requires the task’s exact running execution and ready worktree lease.',
        );
      }
      if (!['running', 'blocked', 'handoff-ready'].includes(task.state)) {
        throw new MissionDomainError(`Task "${task.id}" cannot submit a handoff now.`);
      }

      const verified = await this.git.verifyHandoff({
        workspaceId: task.workspaceId,
        missionId: task.missionId,
        taskId: task.id,
        lease,
        claimedCommitSha: input.claimedCommitSha,
        claimedTreeSha: input.claimedTreeSha,
      });
      gitObject(verified.baseCommitSha, 'Verified handoff base');
      gitObject(verified.commitSha, 'Verified handoff commit');
      gitObject(verified.treeSha, 'Verified handoff tree');
      if (
        verified.baseCommitSha !== lease.baseCommitSha ||
        verified.commitSha !== input.claimedCommitSha ||
        verified.treeSha !== input.claimedTreeSha
      ) {
        throw new MissionDomainError(
          'Verified handoff does not match the exact claimed commit, tree, and lease base.',
        );
      }
      if (
        input.supersedesHandoffId !== undefined &&
        ledger.handoffs[input.supersedesHandoffId]?.taskId !== task.id
      ) {
        throw new MissionDomainError('A handoff may supersede only its own task history.');
      }

      const handoffId = this.createId('handoff');
      const now = this.timestamp();
      const handoff: HandoffRecord = {
        id: handoffId,
        missionId: task.missionId,
        taskId: task.id,
        workspaceId: task.workspaceId,
        executionId: execution.id,
        leaseId: lease.id,
        baseCommitSha: verified.baseCommitSha,
        commitSha: verified.commitSha,
        treeSha: verified.treeSha,
        summary: input.summary,
        evidence: [...input.evidence],
        risks: [...input.risks],
        ...(input.supersedesHandoffId === undefined
          ? {}
          : { supersedesHandoffId: input.supersedesHandoffId }),
        createdAt: now,
      };
      const committed = await this.store.transact(
        input.expectedRevision,
        (draft) => {
          const currentTask = draft.tasks[task.id];
          const currentExecution = draft.executions[execution.id];
          if (
            currentTask === undefined ||
            currentExecution === undefined ||
            currentTask?.executionId !== execution.id ||
            currentExecution?.providerResourceId !== execution.providerResourceId
          ) {
            throw new StaleMissionPlanError('Task execution changed during handoff validation.');
          }
          draft.handoffs[handoff.id] = handoff;
          draft.tasks[task.id] = {
            ...currentTask,
            state: 'handoff-ready',
            handoffIds: [...currentTask.handoffIds, handoff.id],
            activeHandoffId: handoff.id,
            updatedAt: now,
          };
          draft.executions[execution.id] = {
            ...currentExecution,
            state: 'completed',
            updatedAt: now,
          };
          this.event(
            draft,
            'handoff-recorded',
            task.missionId,
            handoff.id,
            now,
          );
        },
      );
      void committed;
      return handoff;
    });
  }

  createCandidate(
    input: CreateCandidateInput,
  ): Promise<IntegrationCandidateRecord> {
    return this.enqueue(async () => {
      if (input.orderedHandoffIds.length === 0) {
        throw new MissionDomainError('An integration candidate requires handoffs.');
      }
      if (new Set(input.orderedHandoffIds).size !== input.orderedHandoffIds.length) {
        throw new MissionDomainError('Candidate handoffs must be unique.');
      }
      const ledger = await this.requireLedger(input.expectedRevision);
      const mission = ledger.missions[input.missionId];
      if (mission === undefined) throw new MissionDomainError('Mission does not exist.');
      const handoffs = input.orderedHandoffIds.map((handoffId) => {
        const handoff = ledger.handoffs[handoffId];
        if (handoff?.missionId !== mission.id) {
          throw new MissionDomainError(
            `Handoff "${handoffId}" is missing or belongs to another Mission.`,
          );
        }
        return handoff;
      });
      const target = await this.git.inspectTarget({
        workspaceId: mission.workspaceId,
        ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
      });
      this.validateTarget(target, mission.workspaceId);
      if (
        handoffs.some((handoff) => handoff.baseCommitSha !== target.commitSha)
      ) {
        throw new MissionDomainError(
          'Every handoff must be based on the current target commit before candidate construction.',
        );
      }
      const built = await this.git.buildCandidate({
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        target,
        handoffs,
      });
      this.validateBuiltCandidate(built, target);
      const candidateId = this.createId('candidate');
      const now = this.timestamp();
      const candidate: IntegrationCandidateRecord = {
        id: candidateId,
        missionId: mission.id,
        workspaceId: mission.workspaceId,
        targetRef: built.targetRef,
        baseCommitSha: built.baseCommitSha,
        baseTreeSha: built.baseTreeSha,
        commitSha: built.commitSha,
        treeSha: built.treeSha,
        orderedHandoffIds: [...input.orderedHandoffIds],
        state: 'ready',
        createdAt: now,
      };
      await this.store.transact(input.expectedRevision, (draft) => {
        for (const previous of Object.values(draft.candidates)) {
          if (previous.missionId === mission.id && previous.state === 'ready') {
            draft.candidates[previous.id] = {
              ...previous,
              state: 'superseded',
            };
          }
        }
        draft.candidates[candidate.id] = candidate;
        for (const handoff of handoffs) {
          const task = draft.tasks[handoff.taskId];
          if (task?.activeHandoffId !== handoff.id) {
            throw new StaleMissionPlanError(
              `Task "${handoff.taskId}" selected a different handoff.`,
            );
          }
          draft.tasks[task.id] = {
            ...task,
            state: 'gating',
            updatedAt: now,
          };
        }
        this.event(
          draft,
          'candidate-created',
          mission.id,
          candidate.id,
          now,
        );
      });
      return candidate;
    });
  }

  recordGate(input: RecordGateInput): Promise<MissionGateRecord> {
    return this.enqueue(async () => {
      if (!isValidProfileId(input.executorProfileId)) {
        throw new MissionDomainError('Gate executor profile ID is invalid.');
      }
      gitObject(input.commitSha, 'Gate commit');
      gitObject(input.treeSha, 'Gate tree');
      const ledger = await this.requireLedger(input.expectedRevision);
      const candidate = ledger.candidates[input.candidateId];
      if (candidate === undefined || candidate.state !== 'ready') {
        throw new MissionDomainError('Gate candidate is missing or no longer current.');
      }
      if (
        candidate.commitSha !== input.commitSha ||
        candidate.treeSha !== input.treeSha
      ) {
        throw new MissionDomainError(
          'Gate result does not cover the exact candidate commit and tree.',
        );
      }
      const gateId = this.createId('gate');
      const now = this.timestamp();
      const gate: MissionGateRecord = {
        id: gateId,
        missionId: candidate.missionId,
        workspaceId: candidate.workspaceId,
        candidateId: candidate.id,
        kind: input.kind,
        status: input.status,
        commitSha: input.commitSha,
        treeSha: input.treeSha,
        executorProfileId: input.executorProfileId,
        evidence: [...input.evidence],
        createdAt: now,
      };
      await this.store.transact(input.expectedRevision, (draft) => {
        if (draft.candidates[candidate.id]?.state !== 'ready') {
          throw new StaleMissionPlanError('Candidate changed before gate recording.');
        }
        draft.gates[gate.id] = gate;
        this.event(draft, 'gate-recorded', candidate.missionId, gate.id, now);
      });
      return gate;
    });
  }

  previewIntegration(
    missionId: MissionId,
    candidateId: IntegrationCandidateId,
    expectedRevision: number,
  ): Promise<IntegrationPreview> {
    return this.enqueue(async () => {
      const ledger = await this.requireLedger(expectedRevision);
      const mission = ledger.missions[missionId];
      const candidate = ledger.candidates[candidateId];
      if (
        mission === undefined ||
        candidate?.missionId !== mission.id ||
        candidate.state !== 'ready'
      ) {
        throw new MissionDomainError('Integration candidate is not current for this Mission.');
      }
      const testGate = latestPassingGate(ledger, candidate.id, 'test');
      const reviewGate = latestPassingGate(ledger, candidate.id, 'review');
      if (testGate === undefined || reviewGate === undefined) {
        throw new MissionDomainError(
          'Integration requires passed Test and Review gates.',
        );
      }
      if (testGate.executorProfileId === reviewGate.executorProfileId) {
        throw new MissionDomainError(
          'Test and Review gates require independent executors.',
        );
      }
      const target = await this.git.inspectTarget({
        workspaceId: mission.workspaceId,
        targetRef: candidate.targetRef,
      });
      this.validateTarget(target, mission.workspaceId);
      if (
        target.commitSha !== candidate.baseCommitSha ||
        target.treeSha !== candidate.baseTreeSha
      ) {
        throw new StaleMissionPlanError(
          'Target changed after candidate construction. Rebuild and re-run gates.',
        );
      }

      const approvalId = this.createId('approval');
      const approvalRevision = expectedRevision + 1;
      const previewDigest = digest({
        approvalId,
        missionId,
        candidateId,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        target,
        testGateId: testGate.id,
        reviewGateId: reviewGate.id,
        approvalRevision,
      });
      const now = this.timestamp();
      const approval: IntegrationApprovalRecord = {
        id: approvalId,
        missionId,
        workspaceId: mission.workspaceId,
        candidateId,
        testGateId: testGate.id,
        reviewGateId: reviewGate.id,
        expectedTargetCommitSha: target.commitSha,
        expectedTargetTreeSha: target.treeSha,
        previewDigest,
        approvalRevision,
        status: 'pending',
        createdAt: now,
      };
      const committed = await this.store.transact(expectedRevision, (draft) => {
        for (const previous of Object.values(draft.approvals)) {
          if (
            previous.missionId === missionId &&
            previous.status === 'pending'
          ) {
            draft.approvals[previous.id] = {
              ...previous,
              status: 'expired',
              decidedAt: now,
            };
            this.event(
              draft,
              'integration-expired',
              missionId,
              previous.id,
              now,
            );
          }
        }
        draft.approvals[approval.id] = approval;
        draft.missions[missionId] = {
          ...mission,
          phase: 'awaiting-approval',
          updatedAt: now,
        };
        this.event(
          draft,
          'integration-previewed',
          missionId,
          approval.id,
          now,
        );
      });
      if (committed.revision !== approvalRevision) {
        throw new MissionDomainError('Approval journal revision was not committed atomically.');
      }
      return {
        digest: previewDigest,
        approvalId,
        missionId,
        candidateId,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        targetRef: candidate.targetRef,
        expectedTargetCommitSha: target.commitSha,
        expectedTargetTreeSha: target.treeSha,
        testGateId: testGate.id,
        reviewGateId: reviewGate.id,
        approvalRevision,
      };
    });
  }

  rejectIntegration(previewDigest: string): Promise<void> {
    return this.enqueue(async () => {
      const loaded = await this.store.reload();
      if (loaded.problem !== undefined) {
        throw new MissionDomainError(
          `Mission ledger is unavailable: ${loaded.problem.message}`,
        );
      }
      const approval = Object.values(loaded.data.approvals).find(
        (candidate) => candidate.previewDigest === previewDigest,
      );
      if (
        approval === undefined ||
        approval.status !== 'pending' ||
        approval.approvalRevision !== loaded.data.revision
      ) {
        throw new StaleMissionPlanError(
          'Integration preview is stale, unknown, or already used.',
        );
      }
      const now = this.timestamp();
      await this.store.transact(loaded.data.revision, (draft) => {
        draft.approvals[approval.id] = {
          ...approval,
          status: 'rejected',
          decidedAt: now,
        };
        const mission = draft.missions[approval.missionId]!;
        draft.missions[mission.id] = {
          ...mission,
          phase: 'active',
          updatedAt: now,
        };
        this.event(
          draft,
          'integration-rejected',
          approval.missionId,
          approval.id,
          now,
        );
      });
    });
  }

  approveAndIntegrate(
    previewDigest: string,
  ): Promise<IntegratedCandidate> {
    return this.enqueue(async () => {
      const loaded = await this.store.reload();
      if (loaded.problem !== undefined) {
        throw new MissionDomainError(
          `Mission ledger is unavailable: ${loaded.problem.message}`,
        );
      }
      const approval = Object.values(loaded.data.approvals).find(
        (candidate) => candidate.previewDigest === previewDigest,
      );
      if (
        approval === undefined ||
        approval.status !== 'pending' ||
        approval.approvalRevision !== loaded.data.revision
      ) {
        throw new StaleMissionPlanError(
          'Integration preview is stale, unknown, or already used.',
        );
      }
      const candidate = this.validateApproval(loaded.data, approval);
      await this.assertTargetStillApproved(approval, candidate);

      const approvedAt = this.timestamp();
      const marked = await this.store.transact(loaded.data.revision, (draft) => {
        draft.approvals[approval.id] = {
          ...approval,
          status: 'approved',
          decidedAt: approvedAt,
        };
        const mission = draft.missions[approval.missionId]!;
        draft.missions[mission.id] = {
          ...mission,
          phase: 'integrating',
          updatedAt: approvedAt,
        };
        this.event(
          draft,
          'integration-approved',
          approval.missionId,
          approval.id,
          approvedAt,
        );
      });
      return this.executeApprovedIntegration(
        { ...approval, status: 'approved', decidedAt: approvedAt },
        candidate,
        marked.revision,
      );
    });
  }

  /**
   * Continues an approval durably marked before a crash or integration failure.
   * If the target already equals the candidate, it is consumed without invoking
   * the integration port again. Any other target drift remains unresolved.
   */
  resumeApprovedIntegration(
    approvalId: IntegrationApprovalId,
    expectedRevision: number,
  ): Promise<IntegratedCandidate> {
    return this.enqueue(async () => {
      const ledger = await this.requireLedger(expectedRevision);
      const approval = ledger.approvals[approvalId];
      if (approval?.status !== 'approved') {
        throw new MissionDomainError('Approval is not awaiting integration recovery.');
      }
      const candidate = this.validateApproval(ledger, approval);
      const target = await this.git.inspectTarget({
        workspaceId: approval.workspaceId,
        targetRef: candidate.targetRef,
      });
      this.validateTarget(target, approval.workspaceId);
      if (
        target.commitSha === candidate.commitSha &&
        target.treeSha === candidate.treeSha
      ) {
        const recovered: IntegratedCandidate = {
          targetRef: target.targetRef,
          previousCommitSha: approval.expectedTargetCommitSha,
          previousTreeSha: approval.expectedTargetTreeSha,
          commitSha: target.commitSha,
          treeSha: target.treeSha,
        };
        await this.consumeIntegration(
          approval,
          candidate,
          recovered,
          expectedRevision,
        );
        return recovered;
      }
      if (
        target.commitSha !== approval.expectedTargetCommitSha ||
        target.treeSha !== approval.expectedTargetTreeSha
      ) {
        throw new StaleMissionPlanError(
          'Approved target moved to an unrecognized commit; integration was not retried.',
        );
      }
      return this.executeApprovedIntegration(
        approval,
        candidate,
        expectedRevision,
      );
    });
  }

  private async buildSquadPreview(
    missionId: MissionId,
    expectedRevision: number,
    selections: readonly SquadSelection[],
  ): Promise<SquadStartPreview> {
    if (selections.length === 0) {
      throw new MissionDomainError('Start Squad requires at least one selection.');
    }
    const taskIds = selections.map((selection) => selection.taskId);
    const profiles = selections.map((selection) => selection.profileId);
    if (
      new Set(taskIds).size !== taskIds.length ||
      new Set(profiles).size !== profiles.length
    ) {
      throw new MissionDomainError(
        'Start Squad tasks and profiles must each be unique.',
      );
    }
    for (const selection of selections) {
      if (!isValidProfileId(selection.profileId)) {
        throw new MissionDomainError('Start Squad profile ID is invalid.');
      }
      fingerprint(
        selection.expectedDefinitionFingerprint,
        'Displayed definition fingerprint',
      );
    }

    const ledger = await this.requireLedger(expectedRevision);
    const mission = ledger.missions[missionId];
    if (
      mission === undefined ||
      (mission.phase !== 'draft' && mission.phase !== 'active')
    ) {
      throw new MissionDomainError('Mission is missing or cannot start a squad.');
    }
    const repository = await this.git.inspectTarget({
      workspaceId: mission.workspaceId,
    });
    this.validateTarget(repository, mission.workspaceId);

    const blockers: string[] = [];
    const participants: SquadParticipantPreview[] = [];
    for (const selection of [...selections].sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    )) {
      const task = ledger.tasks[selection.taskId];
      if (task?.missionId !== mission.id) {
        throw new MissionDomainError(
          `Task "${selection.taskId}" does not belong to this Mission.`,
        );
      }
      if (task.state !== 'draft') {
        blockers.push(`Task "${task.title}" is ${task.state}, not draft.`);
      }
      for (const dependencyId of task.dependsOn) {
        const dependency = ledger.tasks[dependencyId];
        if (
          dependency?.state !== 'approved' &&
          dependency?.state !== 'integrated'
        ) {
          blockers.push(
            `Task "${task.title}" is waiting for dependency "${dependency?.title ?? dependencyId}".`,
          );
        }
      }

      const provider = await this.provider.previewStart({
        missionId,
        taskId: task.id,
        workspaceId: mission.workspaceId,
        profileId: selection.profileId,
        expectedDefinitionFingerprint:
          selection.expectedDefinitionFingerprint,
      });
      if (
        provider.taskId !== task.id ||
        provider.profileId !== selection.profileId ||
        provider.providerId.trim() === '' ||
        CONTROL.test(provider.providerId) ||
        provider.definitionFingerprint !==
          selection.expectedDefinitionFingerprint
      ) {
        throw new MissionDomainError(
          `Provider preview for "${task.id}" did not match its selection.`,
        );
      }
      fingerprint(provider.definitionFingerprint, 'Provider definition fingerprint');
      if (!provider.launchable) {
        blockers.push(
          provider.diagnostic ?? `Profile "${selection.profileId}" is not launchable.`,
        );
      }

      let lease: WorktreeLeasePreview | undefined;
      if (selection.writeCapable) {
        lease = await this.worktrees.previewLease({
          missionId,
          taskId: task.id,
          workspaceId: mission.workspaceId,
          profileId: selection.profileId,
          baseCommitSha: repository.commitSha,
          baseTreeSha: repository.treeSha,
        });
        if (
          lease.taskId !== task.id ||
          lease.baseCommitSha !== repository.commitSha ||
          lease.baseTreeSha !== repository.treeSha
        ) {
          throw new MissionDomainError(
            `Worktree preview for "${task.id}" did not match the repository snapshot.`,
          );
        }
        gitObject(lease.baseCommitSha, 'Lease base commit');
        gitObject(lease.baseTreeSha, 'Lease base tree');
        boundedText(lease.leaseId, 'Lease ID', 128);
        boundedText(lease.branchName, 'Lease branch', 512);
        boundedText(lease.canonicalPath, 'Lease path', 8_192);
        if (!lease.available) {
          blockers.push(
            lease.diagnostic ?? `Worktree lease for "${task.title}" is unavailable.`,
          );
        }
      }
      participants.push({
        taskId: task.id,
        profileId: selection.profileId,
        provider,
        lease,
      });
    }

    const previewBody = {
      missionId,
      workspaceId: mission.workspaceId,
      ledgerRevision: expectedRevision,
      repository,
      participants,
      blockers,
    };
    return { digest: digest(previewBody), ...previewBody };
  }

  private async requireLedger(
    expectedRevision: number,
  ): Promise<MissionLedgerFileV1> {
    const state = await this.store.reload();
    if (state.problem !== undefined) {
      throw new MissionDomainError(
        `Mission ledger is unavailable: ${state.problem.message}`,
      );
    }
    if (state.data.revision !== expectedRevision) {
      throw new StaleMissionPlanError(
        `Mission ledger changed: expected revision ${expectedRevision}, current revision is ${state.data.revision}.`,
      );
    }
    return state.data;
  }

  private validateTarget(
    target: RepositoryTargetSnapshot,
    workspaceId: string,
  ): void {
    if (target.workspaceId !== workspaceId) {
      throw new MissionDomainError('Repository snapshot belongs to another workspace.');
    }
    boundedText(target.targetRef, 'Target ref', 512);
    gitObject(target.commitSha, 'Target commit');
    gitObject(target.treeSha, 'Target tree');
  }

  private validateBuiltCandidate(
    candidate: BuiltIntegrationCandidate,
    target: RepositoryTargetSnapshot,
  ): void {
    boundedText(candidate.targetRef, 'Candidate target ref', 512);
    gitObject(candidate.baseCommitSha, 'Candidate base commit');
    gitObject(candidate.baseTreeSha, 'Candidate base tree');
    gitObject(candidate.commitSha, 'Candidate commit');
    gitObject(candidate.treeSha, 'Candidate tree');
    if (
      candidate.targetRef !== target.targetRef ||
      candidate.baseCommitSha !== target.commitSha ||
      candidate.baseTreeSha !== target.treeSha
    ) {
      throw new MissionDomainError(
        'Built candidate does not match the exact inspected target base.',
      );
    }
  }

  private validateApproval(
    ledger: MissionLedgerFileV1,
    approval: IntegrationApprovalRecord,
  ): IntegrationCandidateRecord {
    const candidate = ledger.candidates[approval.candidateId];
    const testGate = ledger.gates[approval.testGateId];
    const reviewGate = ledger.gates[approval.reviewGateId];
    if (
      candidate === undefined ||
      candidate.state !== 'ready' ||
      testGate?.kind !== 'test' ||
      testGate.status !== 'passed' ||
      reviewGate?.kind !== 'review' ||
      reviewGate.status !== 'passed' ||
      testGate.executorProfileId === reviewGate.executorProfileId ||
      testGate.commitSha !== candidate.commitSha ||
      testGate.treeSha !== candidate.treeSha ||
      reviewGate.commitSha !== candidate.commitSha ||
      reviewGate.treeSha !== candidate.treeSha
    ) {
      throw new StaleMissionPlanError(
        'Approval no longer has independent passing gates for the exact candidate.',
      );
    }
    return candidate;
  }

  private async assertTargetStillApproved(
    approval: IntegrationApprovalRecord,
    candidate: IntegrationCandidateRecord,
  ): Promise<void> {
    const target = await this.git.inspectTarget({
      workspaceId: approval.workspaceId,
      targetRef: candidate.targetRef,
    });
    this.validateTarget(target, approval.workspaceId);
    if (
      target.commitSha !== approval.expectedTargetCommitSha ||
      target.treeSha !== approval.expectedTargetTreeSha
    ) {
      throw new StaleMissionPlanError(
        'Integration target changed while approval was pending.',
      );
    }
  }

  private async executeApprovedIntegration(
    approval: IntegrationApprovalRecord,
    candidate: IntegrationCandidateRecord,
    expectedRevision: number,
  ): Promise<IntegratedCandidate> {
    const integrated = await this.git.integrateCandidate({
      workspaceId: approval.workspaceId,
      missionId: approval.missionId,
      targetRef: candidate.targetRef,
      expectedTargetCommitSha: approval.expectedTargetCommitSha,
      expectedTargetTreeSha: approval.expectedTargetTreeSha,
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
    });
    boundedText(integrated.targetRef, 'Integrated target ref', 512);
    gitObject(integrated.previousCommitSha, 'Previous target commit');
    gitObject(integrated.previousTreeSha, 'Previous target tree');
    gitObject(integrated.commitSha, 'Integrated commit');
    gitObject(integrated.treeSha, 'Integrated tree');
    if (
      integrated.targetRef !== candidate.targetRef ||
      integrated.previousCommitSha !== approval.expectedTargetCommitSha ||
      integrated.previousTreeSha !== approval.expectedTargetTreeSha
    ) {
      throw new MissionDomainError(
        'Integration result does not prove an expected-old-target update.',
      );
    }
    await this.consumeIntegration(
      approval,
      candidate,
      integrated,
      expectedRevision,
    );
    return integrated;
  }

  private async consumeIntegration(
    approval: IntegrationApprovalRecord,
    candidate: IntegrationCandidateRecord,
    integrated: IntegratedCandidate,
    expectedRevision: number,
  ): Promise<void> {
    const now = this.timestamp();
    await this.store.transact(expectedRevision, (draft) => {
      const currentApproval = draft.approvals[approval.id];
      const currentCandidate = draft.candidates[candidate.id];
      if (
        currentApproval?.status !== 'approved' ||
        currentCandidate?.state !== 'ready'
      ) {
        throw new StaleMissionPlanError(
          'Approval journal changed before integration could be consumed.',
        );
      }
      draft.approvals[approval.id] = {
        ...currentApproval,
        status: 'consumed',
        consumedAt: now,
        integrationCommitSha: integrated.commitSha,
        integrationTreeSha: integrated.treeSha,
      };
      draft.candidates[candidate.id] = {
        ...currentCandidate,
        state: 'integrated',
        integratedAt: now,
        integrationCommitSha: integrated.commitSha,
        integrationTreeSha: integrated.treeSha,
      };
      for (const handoffId of candidate.orderedHandoffIds) {
        const handoff = draft.handoffs[handoffId];
        const task = handoff === undefined ? undefined : draft.tasks[handoff.taskId];
        if (task !== undefined && task.activeHandoffId === handoffId) {
          draft.tasks[task.id] = {
            ...task,
            state: 'integrated',
            updatedAt: now,
          };
        }
      }
      const mission = draft.missions[approval.missionId]!;
      draft.missions[mission.id] = {
        ...mission,
        phase: 'completed',
        updatedAt: now,
      };
      this.event(
        draft,
        'integration-consumed',
        approval.missionId,
        approval.id,
        now,
      );
    });
  }

  private event(
    draft: MutableMissionLedger,
    kind: MissionLedgerEventKind,
    missionId: MissionId,
    recordId: string,
    occurredAt: string,
  ): void {
    draft.events.push({
      sequence: draft.events.length + 1,
      kind,
      missionId,
      recordId,
      occurredAt,
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
