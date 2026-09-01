import type { DepartmentId } from './capabilityPolicy.js';

export const MAX_DEPARTMENT_ITERATIONS = 6 as const;

export type DepartmentAssignmentId = string;
export type SpecialistWorkId = string;

export type DepartmentAssignmentState =
  | 'queued'
  | 'delegating'
  | 'specialist-working'
  | 'head-review'
  | 'ready'
  | 'blocked'
  | 'superseded';

export type CriterionStatus = 'satisfied' | 'unsatisfied' | 'not-evaluated';

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly evidenceRequired: boolean;
}

export interface CriterionAssessment {
  readonly criterionId: string;
  readonly status: CriterionStatus;
  readonly evidence: readonly string[];
  readonly rationale: string;
}

export interface DepartmentAssignment {
  readonly id: DepartmentAssignmentId;
  readonly missionId: string;
  readonly departmentId: DepartmentId;
  readonly objective: string;
  readonly includedScope: readonly string[];
  readonly excludedScope: readonly string[];
  readonly dependsOn: readonly DepartmentAssignmentId[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly iteration: number;
  readonly state: DepartmentAssignmentState;
}

export interface SpecialistBrief {
  readonly id: SpecialistWorkId;
  readonly assignmentId: DepartmentAssignmentId;
  readonly departmentId: DepartmentId;
  /** Council assigns this label from the actual task; it is not a permission boundary. */
  readonly specialistRole: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly evidencePacket: readonly string[];
  readonly iteration: number;
}

export interface SpecialistWorkProduct {
  readonly workId: SpecialistWorkId;
  readonly assignmentId: DepartmentAssignmentId;
  readonly departmentId: DepartmentId;
  readonly specialistRole: string;
  readonly summary: string;
  readonly deliverables: readonly string[];
  readonly criterionAssessments: readonly CriterionAssessment[];
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly blockingFindings: readonly string[];
  readonly assumptions: readonly string[];
}

export interface DepartmentReadiness {
  readonly assignmentId: DepartmentAssignmentId;
  readonly ready: boolean;
  readonly decision: 'ready' | 'iterate' | 'escalate';
  readonly evidenceComplete: boolean;
  readonly criteriaComplete: boolean;
  readonly unresolvedCriteria: readonly string[];
  readonly blockingFindings: readonly string[];
  readonly reasons: readonly string[];
}

export interface DepartmentHeadReview {
  readonly assignmentId: DepartmentAssignmentId;
  readonly departmentId: DepartmentId;
  readonly iteration: number;
  readonly readiness: DepartmentReadiness;
  readonly nextSpecialistBrief?: SpecialistBrief | undefined;
}

export type ApprovalSensitiveActionKind =
  | 'local-worktree-write'
  | 'branch-create'
  | 'branch-push'
  | 'main-merge'
  | 'force-push'
  | 'history-rewrite'
  | 'file-delete'
  | 'production-deploy'
  | 'release-publish'
  | 'production-data-mutation'
  | 'production-infrastructure-mutation'
  | 'credential-or-secret-change'
  | 'account-or-access-removal'
  | 'external-message-or-publication'
  | 'financial-transaction'
  | 'unknown-remote-mutation';

export interface ProposedAction {
  readonly kind: ApprovalSensitiveActionKind;
  readonly summary: string;
  readonly target?: string | undefined;
  readonly reversible: boolean;
  readonly remote: boolean;
}

export interface ApprovalDecision {
  readonly required: boolean;
  readonly reasons: readonly string[];
}

export interface QueenBeeDepartmentResult {
  readonly assignment: DepartmentAssignment;
  readonly review: DepartmentHeadReview;
  readonly product: SpecialistWorkProduct;
}

export interface QueenBeeCouncilPacket {
  readonly missionId: string;
  readonly exactQuestion: string;
  readonly departmentResults: readonly QueenBeeDepartmentResult[];
  readonly crossDepartmentConflicts: readonly string[];
  readonly unresolvedUncertainties: readonly string[];
  readonly proposedActions: readonly ProposedAction[];
}
