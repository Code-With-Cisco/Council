/**
 * Council-owned Mission domain records.
 *
 * Provider sessions, repository stories, and provider-native task lists are
 * evidence. This ledger is the authority for Council dispatch, handoffs,
 * gates, and integration approval.
 */

export const MISSION_LEDGER_VERSION = 1 as const;

export type MissionId = string;
export type MissionTaskId = string;
export type WorktreeLeaseId = string;
export type MissionExecutionId = string;
export type HandoffId = string;
export type IntegrationCandidateId = string;
export type MissionGateId = string;
export type IntegrationApprovalId = string;

export type MissionPhase =
  | 'draft'
  | 'active'
  | 'blocked'
  | 'awaiting-approval'
  | 'integrating'
  | 'completed'
  | 'canceled';

export type MissionTaskState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'handoff-ready'
  | 'gating'
  | 'approved'
  | 'integrated'
  | 'failed'
  | 'canceled';

export type WorktreeLeaseState =
  | 'provisioning'
  | 'ready'
  | 'orphaned'
  | 'released';

export type MissionExecutionState =
  | 'starting'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed';

export type MissionGateKind = 'test' | 'review';
export type MissionGateStatus = 'passed' | 'failed';
export type IntegrationCandidateState = 'ready' | 'integrated' | 'superseded';
export type IntegrationApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'consumed'
  | 'expired';

export interface MissionRecord {
  readonly id: MissionId;
  readonly workspaceId: string;
  readonly title: string;
  readonly objective: string;
  readonly phase: MissionPhase;
  readonly taskIds: readonly MissionTaskId[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MissionTaskRecord {
  readonly id: MissionTaskId;
  readonly missionId: MissionId;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string;
  readonly state: MissionTaskState;
  readonly dependsOn: readonly MissionTaskId[];
  readonly assigneeProfileId?: string | undefined;
  readonly worktreeLeaseId?: WorktreeLeaseId | undefined;
  readonly executionId?: MissionExecutionId | undefined;
  readonly handoffIds: readonly HandoffId[];
  readonly activeHandoffId?: HandoffId | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorktreeLeaseRecord {
  readonly id: WorktreeLeaseId;
  readonly missionId: MissionId;
  readonly taskId: MissionTaskId;
  readonly workspaceId: string;
  readonly branchName: string;
  readonly canonicalPath: string;
  readonly baseCommitSha: string;
  readonly baseTreeSha: string;
  readonly state: WorktreeLeaseState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MissionExecutionRecord {
  readonly id: MissionExecutionId;
  readonly missionId: MissionId;
  readonly taskId: MissionTaskId;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly providerId: string;
  /** Exact provider-owned thread/session identity, retained for audit only. */
  readonly providerResourceId?: string | undefined;
  readonly state: MissionExecutionState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HandoffRecord {
  readonly id: HandoffId;
  readonly missionId: MissionId;
  readonly taskId: MissionTaskId;
  readonly workspaceId: string;
  readonly executionId: MissionExecutionId;
  readonly leaseId: WorktreeLeaseId;
  readonly baseCommitSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly supersedesHandoffId?: HandoffId | undefined;
  readonly createdAt: string;
}

export interface IntegrationCandidateRecord {
  readonly id: IntegrationCandidateId;
  readonly missionId: MissionId;
  readonly workspaceId: string;
  readonly targetRef: string;
  readonly baseCommitSha: string;
  readonly baseTreeSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly orderedHandoffIds: readonly HandoffId[];
  readonly state: IntegrationCandidateState;
  readonly createdAt: string;
  readonly integratedAt?: string | undefined;
  readonly integrationCommitSha?: string | undefined;
  readonly integrationTreeSha?: string | undefined;
}

export interface MissionGateRecord {
  readonly id: MissionGateId;
  readonly missionId: MissionId;
  readonly workspaceId: string;
  readonly candidateId: IntegrationCandidateId;
  readonly kind: MissionGateKind;
  readonly status: MissionGateStatus;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly executorProfileId: string;
  readonly evidence: readonly string[];
  readonly createdAt: string;
}

export interface IntegrationApprovalRecord {
  readonly id: IntegrationApprovalId;
  readonly missionId: MissionId;
  readonly workspaceId: string;
  readonly candidateId: IntegrationCandidateId;
  readonly testGateId: MissionGateId;
  readonly reviewGateId: MissionGateId;
  readonly expectedTargetCommitSha: string;
  readonly expectedTargetTreeSha: string;
  readonly previewDigest: string;
  /**
   * The exact ledger revision produced by inserting this journal. Any intervening
   * Mission mutation expires the preview before approval can authorize work.
   */
  readonly approvalRevision: number;
  readonly status: IntegrationApprovalStatus;
  readonly createdAt: string;
  readonly decidedAt?: string | undefined;
  readonly consumedAt?: string | undefined;
  readonly integrationCommitSha?: string | undefined;
  readonly integrationTreeSha?: string | undefined;
}

export type MissionLedgerEventKind =
  | 'mission-created'
  | 'squad-started'
  | 'handoff-recorded'
  | 'candidate-created'
  | 'gate-recorded'
  | 'integration-previewed'
  | 'integration-approved'
  | 'integration-rejected'
  | 'integration-consumed'
  | 'integration-expired';

export interface MissionLedgerEvent {
  readonly sequence: number;
  readonly kind: MissionLedgerEventKind;
  readonly missionId: MissionId;
  readonly recordId: string;
  readonly occurredAt: string;
}

export interface MissionLedgerFileV1 {
  readonly version: typeof MISSION_LEDGER_VERSION;
  readonly revision: number;
  readonly missions: Readonly<Record<MissionId, MissionRecord>>;
  readonly tasks: Readonly<Record<MissionTaskId, MissionTaskRecord>>;
  readonly leases: Readonly<Record<WorktreeLeaseId, WorktreeLeaseRecord>>;
  readonly executions: Readonly<Record<MissionExecutionId, MissionExecutionRecord>>;
  readonly handoffs: Readonly<Record<HandoffId, HandoffRecord>>;
  readonly candidates: Readonly<
    Record<IntegrationCandidateId, IntegrationCandidateRecord>
  >;
  readonly gates: Readonly<Record<MissionGateId, MissionGateRecord>>;
  readonly approvals: Readonly<
    Record<IntegrationApprovalId, IntegrationApprovalRecord>
  >;
  readonly events: readonly MissionLedgerEvent[];
}

export interface RepositoryTargetSnapshot {
  readonly workspaceId: string;
  readonly targetRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
}

export interface SquadSelection {
  readonly taskId: MissionTaskId;
  readonly profileId: string;
  readonly expectedDefinitionFingerprint: string;
  readonly writeCapable: boolean;
}

export interface ProviderStartPreview {
  readonly taskId: MissionTaskId;
  readonly profileId: string;
  readonly providerId: string;
  readonly definitionFingerprint: string;
  readonly action: 'start' | 'reuse' | 'resume';
  readonly launchable: boolean;
  readonly diagnostic?: string | undefined;
}

export interface WorktreeLeasePreview {
  readonly taskId: MissionTaskId;
  readonly leaseId: WorktreeLeaseId;
  readonly branchName: string;
  readonly canonicalPath: string;
  readonly baseCommitSha: string;
  readonly baseTreeSha: string;
  readonly available: boolean;
  readonly diagnostic?: string | undefined;
}

export interface SquadParticipantPreview {
  readonly taskId: MissionTaskId;
  readonly profileId: string;
  readonly provider: ProviderStartPreview;
  readonly lease: WorktreeLeasePreview | undefined;
}

export interface SquadStartPreview {
  readonly digest: string;
  readonly missionId: MissionId;
  readonly workspaceId: string;
  readonly ledgerRevision: number;
  readonly repository: RepositoryTargetSnapshot;
  readonly participants: readonly SquadParticipantPreview[];
  readonly blockers: readonly string[];
}

export interface IntegrationPreview {
  readonly digest: string;
  readonly approvalId: IntegrationApprovalId;
  readonly missionId: MissionId;
  readonly candidateId: IntegrationCandidateId;
  readonly candidateCommitSha: string;
  readonly candidateTreeSha: string;
  readonly targetRef: string;
  readonly expectedTargetCommitSha: string;
  readonly expectedTargetTreeSha: string;
  readonly testGateId: MissionGateId;
  readonly reviewGateId: MissionGateId;
  readonly approvalRevision: number;
}
