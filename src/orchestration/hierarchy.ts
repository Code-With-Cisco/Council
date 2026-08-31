import type { AgencyDivision } from './capabilityPolicy.js';
import { departmentById } from './departments.js';

export type DepartmentAssignmentState =
  | 'queued'
  | 'head-planning'
  | 'specialist-working'
  | 'head-reviewing'
  | 'revision-required'
  | 'ready-for-queen-bee'
  | 'blocked';

export type ReadinessCriterionId =
  | 'scope-complete'
  | 'deliverables-present'
  | 'evidence-attached'
  | 'acceptance-satisfied'
  | 'validation-passed'
  | 'risks-disclosed'
  | 'ownership-compliant';

export interface ReadinessCriterion {
  readonly id: ReadinessCriterionId;
  readonly satisfied: boolean;
  readonly evidence: readonly string[];
  readonly note?: string | undefined;
}

export interface DepartmentReadinessInput {
  readonly department: AgencyDivision;
  readonly specialistProfileIds: readonly string[];
  readonly criteria: readonly ReadinessCriterion[];
  readonly unresolvedBlockers: readonly string[];
  readonly unresolvedQuestions: readonly string[];
}

export interface DepartmentReadinessAssessment {
  readonly department: AgencyDivision;
  readonly departmentHead: string;
  readonly specialistProfileIds: readonly string[];
  /** Percentage of required readiness criteria currently satisfied. */
  readonly readinessPercent: number;
  /**
   * True only when the deterministic readiness contract is fully satisfied.
   * This is not a claim of omniscience, factual infallibility, or zero residual
   * uncertainty.
   */
  readonly readyForQueenBee: boolean;
  readonly missingCriteria: readonly ReadinessCriterionId[];
  readonly unresolvedBlockers: readonly string[];
  readonly unresolvedQuestions: readonly string[];
}

const REQUIRED_READINESS_CRITERIA: readonly ReadinessCriterionId[] = [
  'scope-complete',
  'deliverables-present',
  'evidence-attached',
  'acceptance-satisfied',
  'validation-passed',
  'risks-disclosed',
  'ownership-compliant',
];

export function departmentHeadProfileId(department: AgencyDivision): string {
  return `department-head:${department}`;
}

export function assessDepartmentReadiness(
  input: DepartmentReadinessInput,
): DepartmentReadinessAssessment {
  const byId = new Map(input.criteria.map((criterion) => [criterion.id, criterion]));
  const missingCriteria = REQUIRED_READINESS_CRITERIA.filter(
    (id) => byId.get(id)?.satisfied !== true,
  );
  const satisfied = REQUIRED_READINESS_CRITERIA.length - missingCriteria.length;
  const readinessPercent = Math.round(
    (satisfied / REQUIRED_READINESS_CRITERIA.length) * 100,
  );
  const readyForQueenBee =
    readinessPercent === 100 &&
    input.unresolvedBlockers.length === 0 &&
    input.unresolvedQuestions.length === 0;

  return {
    department: input.department,
    departmentHead: departmentHeadProfileId(input.department),
    specialistProfileIds: [...new Set(input.specialistProfileIds)],
    readinessPercent,
    readyForQueenBee,
    missingCriteria,
    unresolvedBlockers: [...input.unresolvedBlockers],
    unresolvedQuestions: [...input.unresolvedQuestions],
  };
}

export interface DepartmentDispatch {
  readonly department: AgencyDivision;
  readonly departmentHeadProfileId: string;
  readonly floor: number;
  readonly assignment: string;
  readonly specialistProfileIds: readonly string[];
  readonly state: DepartmentAssignmentState;
}

export function createDepartmentDispatch(request: {
  readonly department: AgencyDivision;
  readonly assignment: string;
  readonly specialistProfileIds?: readonly string[] | undefined;
}): DepartmentDispatch {
  if (request.assignment.trim() === '') {
    throw new Error('Department assignment must be non-empty.');
  }
  const department = departmentById(request.department);
  return {
    department: request.department,
    departmentHeadProfileId: departmentHeadProfileId(request.department),
    floor: department.officeFloor,
    assignment: request.assignment,
    specialistProfileIds: [...new Set(request.specialistProfileIds ?? [])],
    state: 'queued',
  };
}

export type PromotionRiskReason =
  | 'destructive-operation'
  | 'history-rewrite'
  | 'data-deletion'
  | 'schema-or-data-migration'
  | 'security-boundary-change'
  | 'credential-or-secret-change'
  | 'permission-or-auth-change'
  | 'deployment-or-release-change'
  | 'high-impact-change'
  | 'explicit-user-review-request';

export type PromotionRoute = 'direct-main' | 'review-branch';

export interface PromotionAssessmentInput {
  readonly destructiveOperation?: boolean | undefined;
  readonly rewritesHistory?: boolean | undefined;
  readonly deletesData?: boolean | undefined;
  readonly migratesSchemaOrData?: boolean | undefined;
  readonly changesSecurityBoundary?: boolean | undefined;
  readonly changesCredentialsOrSecrets?: boolean | undefined;
  readonly changesPermissionsOrAuth?: boolean | undefined;
  readonly changesDeploymentOrRelease?: boolean | undefined;
  readonly highImpact?: boolean | undefined;
  readonly userRequestedReview?: boolean | undefined;
}

export interface PromotionAssessment {
  readonly route: PromotionRoute;
  readonly requiresUserApproval: boolean;
  readonly reasons: readonly PromotionRiskReason[];
}

/**
 * Queen Bee promotion policy.
 *
 * A review branch is mandatory for destructive/high-impact work. Direct main
 * is available only for low-risk work after all required Mission/Council gates
 * have independently passed. The caller must enforce those gates separately.
 */
export function assessPromotionRisk(
  input: PromotionAssessmentInput,
): PromotionAssessment {
  const reasons: PromotionRiskReason[] = [];
  if (input.destructiveOperation) reasons.push('destructive-operation');
  if (input.rewritesHistory) reasons.push('history-rewrite');
  if (input.deletesData) reasons.push('data-deletion');
  if (input.migratesSchemaOrData) reasons.push('schema-or-data-migration');
  if (input.changesSecurityBoundary) reasons.push('security-boundary-change');
  if (input.changesCredentialsOrSecrets) reasons.push('credential-or-secret-change');
  if (input.changesPermissionsOrAuth) reasons.push('permission-or-auth-change');
  if (input.changesDeploymentOrRelease) reasons.push('deployment-or-release-change');
  if (input.highImpact) reasons.push('high-impact-change');
  if (input.userRequestedReview) reasons.push('explicit-user-review-request');

  return reasons.length === 0
    ? { route: 'direct-main', requiresUserApproval: false, reasons }
    : { route: 'review-branch', requiresUserApproval: true, reasons };
}

export interface QueenBeeReconciliationInput {
  readonly departmentAssessments: readonly DepartmentReadinessAssessment[];
  readonly councilPassed: boolean;
  readonly testGatePassed: boolean;
  readonly reviewGatePassed: boolean;
  readonly councilFindings: readonly string[];
}

export interface QueenBeeReconciliation {
  readonly readyForPromotion: boolean;
  readonly departmentsNeedingRevision: readonly AgencyDivision[];
  readonly blockers: readonly string[];
}

export function reconcileForQueenBee(
  input: QueenBeeReconciliationInput,
): QueenBeeReconciliation {
  const departmentsNeedingRevision = input.departmentAssessments
    .filter((assessment) => !assessment.readyForQueenBee)
    .map((assessment) => assessment.department);
  const blockers: string[] = [];

  if (departmentsNeedingRevision.length > 0) {
    blockers.push('One or more Department Heads have not reached 100% readiness.');
  }
  if (!input.councilPassed) blockers.push('LLM Council review has not passed.');
  if (!input.testGatePassed) blockers.push('Independent Test gate has not passed.');
  if (!input.reviewGatePassed) blockers.push('Independent Review gate has not passed.');
  if (input.councilFindings.length > 0) {
    blockers.push('LLM Council returned material findings that require reconciliation.');
  }

  return {
    readyForPromotion: blockers.length === 0,
    departmentsNeedingRevision,
    blockers,
  };
}
