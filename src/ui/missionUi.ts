/**
 * Renderer-safe Mission contract.
 *
 * The implementation adapter may compose the Mission ledger, provider
 * registry, and worktree manager, but this port deliberately exposes no
 * executable, argv, environment, provider-native conversation ID, canonical
 * path, or arbitrary Git mutation parameter.
 */

export type UiMissionProviderId = 'claude-code' | 'codex';

export interface UiMissionProviderStatus {
  readonly providerId: UiMissionProviderId;
  readonly displayName: string;
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly protocolReady: boolean;
  readonly persistentConversations: boolean;
  readonly approvals: boolean;
  readonly diagnostic: string | undefined;
}

export interface UiMissionAssignment {
  readonly profileId: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskState: string;
  readonly providerId?: UiMissionProviderId | undefined;
}

export interface UiMissionHandoff {
  readonly id: string;
  readonly taskId: string;
  /** Exact immutable handoff evidence, display-only in the renderer. */
  readonly commitSha: string;
  readonly treeSha: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface UiMissionGate {
  readonly id: string;
  readonly candidateId: string;
  readonly kind: 'test' | 'review';
  readonly status: 'passed' | 'failed';
  readonly commitSha: string;
  readonly treeSha: string;
  readonly commandIds: readonly string[];
  readonly gatePolicyFingerprint: string;
  readonly executorExecutionId: string;
  readonly executorProfileId: string;
  readonly evidence: readonly string[];
  readonly createdAt: string;
}

export interface UiMissionLease {
  readonly id: string;
  readonly state: 'provisioning' | 'ready' | 'orphaned' | 'released';
  readonly accessMode: 'read-only' | 'workspace-write';
  readonly baseCommitSha: string;
}

export interface UiMissionExecution {
  readonly id: string;
  readonly providerId: UiMissionProviderId;
  readonly state: 'starting' | 'running' | 'blocked' | 'completed' | 'failed';
  readonly accessMode: 'read-only' | 'workspace-write';
  readonly providerAction: 'start' | 'reuse' | 'resume';
  readonly gateResponsibility: 'test' | 'review' | undefined;
  readonly definitionFingerprint: string;
}

export interface UiMissionTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly assigneeProfileId: string | undefined;
  readonly execution: UiMissionExecution | undefined;
  readonly lease: UiMissionLease | undefined;
  readonly activeHandoff: UiMissionHandoff | undefined;
}

export interface UiMissionCandidate {
  readonly id: string;
  readonly state: 'ready' | 'integrated' | 'superseded';
  readonly commitSha: string;
  readonly treeSha: string;
  readonly targetLabel: string;
}

export interface UiMissionSummary {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly phase: string;
  readonly tasks: readonly UiMissionTask[];
  readonly latestCandidate: UiMissionCandidate | undefined;
  readonly testGate: UiMissionGate | undefined;
  readonly reviewGate: UiMissionGate | undefined;
}

export interface UiMissionProjection {
  readonly workspaceId: string;
  readonly revision: number;
  readonly missions: readonly UiMissionSummary[];
  readonly assignmentsByProfileId: Readonly<
    Record<string, readonly UiMissionAssignment[]>
  >;
}

export interface UiMissionState {
  readonly status: 'ready' | 'blocked' | 'unavailable';
  readonly workspaceId: string | undefined;
  readonly revision: number;
  readonly problem: string | undefined;
  readonly providers: readonly UiMissionProviderStatus[];
  readonly gatePolicy:
    | {
        readonly fingerprint: string;
        readonly testCommandIds: readonly string[];
        readonly reviewCommandIds: readonly string[];
        readonly diagnostic: string | undefined;
      }
    | undefined;
  readonly projection: UiMissionProjection | undefined;
}

export interface UiCreateMissionInput {
  readonly expectedRevision: number;
  readonly title: string;
  readonly objective: string;
  readonly tasks: readonly {
    readonly title: string;
    readonly description: string;
  }[];
}

export interface UiCreateMissionResult {
  readonly revision: number;
  readonly mission: UiMissionSummary;
}

export interface UiSquadSelection {
  readonly taskId: string;
  readonly profileId: string;
  /** Explicit Council provider choice, never a provider-native resource ID. */
  readonly providerId: UiMissionProviderId;
  readonly expectedDefinitionFingerprint: string;
  readonly writeCapable: boolean;
}

export interface UiPreviewSquadInput {
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly selections: readonly UiSquadSelection[];
  readonly gateAssignments: {
    readonly testProfileId: string;
    readonly reviewProfileId: string;
  };
}

export interface UiSquadParticipantPreview {
  readonly taskId: string;
  readonly profileId: string;
  readonly providerId: UiMissionProviderId;
  readonly definitionFingerprint: string;
  /** Complete normalized plain text; unavailable only for a hard-blocked preview. */
  readonly roleInstructions: string | undefined;
  readonly roleInstructionFingerprint: string;
  readonly providerAvailable: boolean;
  readonly providerAuthenticated: boolean;
  readonly protocolReady: boolean;
  readonly providerAction: 'start' | 'reuse' | 'resume';
  readonly launchable: boolean;
  readonly accessMode: 'read-only' | 'workspace-write';
  readonly leaseId: string | undefined;
  readonly baseCommitSha: string | undefined;
  readonly diagnostic: string | undefined;
}

export interface UiSquadGateAssignmentPreview {
  readonly kind: 'test' | 'review';
  readonly taskId: string;
  readonly profileId: string;
  /** The exact opaque execution ID is allocated only after confirmation. */
  readonly executionIntent: 'allocate-read-only-on-start';
}

export interface UiSquadStartPreview {
  readonly digest: string;
  readonly missionId: string;
  readonly revision: number;
  readonly repositoryHeadSha: string;
  readonly participants: readonly UiSquadParticipantPreview[];
  readonly gateAssignments: {
    readonly test: UiSquadGateAssignmentPreview;
    readonly review: UiSquadGateAssignmentPreview;
  };
  readonly blockers: readonly string[];
}

export interface UiSquadStartResult {
  readonly missionId: string;
  readonly revision: number;
  readonly startedTaskIds: readonly string[];
  readonly failures: readonly {
    readonly taskId: string;
    readonly message: string;
  }[];
}

export interface UiRetryMissionExecutionInput {
  readonly expectedRevision: number;
  readonly executionId: string;
}

export interface UiRetryMissionExecutionResult {
  readonly revision: number;
  readonly execution: UiMissionExecution;
}

export interface UiPreviewIntegrationInput {
  readonly missionId: string;
  readonly candidateId: string;
  readonly expectedRevision: number;
}

export interface UiIntegrationPreview {
  readonly digest: string;
  readonly approvalId: string;
  readonly missionId: string;
  readonly candidateId: string;
  readonly candidateCommitSha: string;
  readonly candidateTreeSha: string;
  readonly targetLabel: string;
  readonly expectedTargetCommitSha: string;
  readonly expectedTargetTreeSha: string;
  readonly testGateId: string;
  readonly reviewGateId: string;
  readonly approvalRevision: number;
}

export interface UiIntegrationResult {
  readonly missionId: string;
  readonly revision: number;
  readonly status: 'approved' | 'rejected' | 'integrated';
  readonly resultingCommitSha?: string | undefined;
}

export interface UiRecordHandoffInput {
  readonly expectedRevision: number;
  readonly taskId: string;
  readonly executionId: string;
  readonly claimedCommitSha: string;
  readonly claimedTreeSha: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly supersedesHandoffId?: string | undefined;
}

export interface UiCreateCandidateInput {
  readonly expectedRevision: number;
  readonly missionId: string;
  /** Ordered exact handoff identities; the privileged controller chooses the target. */
  readonly orderedHandoffIds: readonly string[];
}

export interface UiRecordGateInput {
  readonly expectedRevision: number;
  readonly candidateId: string;
  readonly kind: 'test' | 'review';
  /** Bounded identifiers revalidated against the privileged project allowlist. */
  readonly commandIds: readonly string[];
  /** Displayed policy fingerprint; the privileged controller must re-resolve it. */
  readonly gatePolicyFingerprint: string;
  readonly executorProfileId: string;
}

export interface MissionUiController {
  getState(): Promise<UiMissionState>;
  createMission(input: UiCreateMissionInput): Promise<UiCreateMissionResult>;
  previewSquad(input: UiPreviewSquadInput): Promise<UiSquadStartPreview>;
  startSquad(previewDigest: string): Promise<UiSquadStartResult>;
  retryBlockedExecution(
    input: UiRetryMissionExecutionInput,
  ): Promise<UiRetryMissionExecutionResult>;
  recordHandoff(input: UiRecordHandoffInput): Promise<UiMissionHandoff>;
  createCandidate(input: UiCreateCandidateInput): Promise<UiMissionCandidate>;
  /**
   * Runs the privileged GateRunner and records its result. The renderer request
   * is only a plan; it never supplies a verdict, object IDs, or evidence.
   */
  recordGate(input: UiRecordGateInput): Promise<UiMissionGate>;
  previewIntegration(
    input: UiPreviewIntegrationInput,
  ): Promise<UiIntegrationPreview>;
  approveIntegration(previewDigest: string): Promise<UiIntegrationResult>;
  rejectIntegration(previewDigest: string): Promise<UiIntegrationResult>;
}
