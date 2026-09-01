import {
  MAX_DEPARTMENT_ITERATIONS,
  type DepartmentAssignment as DurableDepartmentAssignment,
  type DepartmentReadiness as DurableDepartmentReadiness,
  type SpecialistWorkProduct,
} from './types.js';

export type ReadinessCheckId =
  | 'specialist-submission'
  | 'requirements-satisfied'
  | 'scope-preserved'
  | 'evidence-attached'
  | 'acceptance-evidence'
  | 'independent-review'
  | 'no-unresolved-blockers'
  | 'no-material-uncertainty'
  | 'department-head-attestation';

export type ReadinessCheckStatus = 'passed' | 'failed' | 'pending' | 'not-applicable';

export interface OptionalReadinessGate {
  readonly status: Exclude<ReadinessCheckStatus, 'not-applicable'> | 'not-applicable';
  /** Required when status is not-applicable so the omission is explicit and reviewable. */
  readonly rationale?: string | undefined;
}

export interface DepartmentReadinessInput {
  readonly specialistSubmissionPresent: boolean;
  readonly requirementsSatisfied: boolean;
  readonly scopePreserved: boolean;
  readonly evidenceAttached: boolean;
  readonly acceptance: OptionalReadinessGate;
  readonly independentReview: OptionalReadinessGate;
  readonly unresolvedBlockers: readonly string[];
  readonly materialUncertainties: readonly string[];
  readonly departmentHeadAttested: boolean;
}

export interface ReadinessCheck {
  readonly id: ReadinessCheckId;
  readonly status: ReadinessCheckStatus;
  readonly detail: string;
}

export interface DepartmentReadinessAssessment {
  /**
   * Operational readiness, not a claim of epistemic certainty. 100 means every
   * required, auditable gate below is satisfied.
   */
  readonly readinessPercent: number;
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
  readonly blockers: readonly string[];
}

function booleanCheck(
  id: ReadinessCheckId,
  value: boolean,
  passedDetail: string,
  failedDetail: string,
): ReadinessCheck {
  return {
    id,
    status: value ? 'passed' : 'failed',
    detail: value ? passedDetail : failedDetail,
  };
}

function optionalGateCheck(
  id: ReadinessCheckId,
  gate: OptionalReadinessGate,
  label: string,
): ReadinessCheck {
  if (gate.status === 'not-applicable') {
    const rationale = gate.rationale?.trim();
    return rationale
      ? {
          id,
          status: 'not-applicable',
          detail: `${label} is not applicable: ${rationale}`,
        }
      : {
          id,
          status: 'failed',
          detail: `${label} was marked not applicable without a rationale.`,
        };
  }

  return {
    id,
    status: gate.status,
    detail:
      gate.status === 'passed'
        ? `${label} passed.`
        : gate.status === 'pending'
          ? `${label} is still pending.`
          : `${label} failed.`,
  };
}

export function assessDepartmentReadiness(
  input: DepartmentReadinessInput,
): DepartmentReadinessAssessment {
  const checks: ReadinessCheck[] = [
    booleanCheck(
      'specialist-submission',
      input.specialistSubmissionPresent,
      'A bounded specialist submission is present.',
      'No specialist submission has been recorded.',
    ),
    booleanCheck(
      'requirements-satisfied',
      input.requirementsSatisfied,
      'The assigned requirements are satisfied.',
      'One or more assigned requirements are not satisfied.',
    ),
    booleanCheck(
      'scope-preserved',
      input.scopePreserved,
      'The submission stayed inside the department assignment.',
      'The submission exceeded or changed the assigned scope.',
    ),
    booleanCheck(
      'evidence-attached',
      input.evidenceAttached,
      'The submission includes evidence for its claims and work product.',
      'Required evidence is missing.',
    ),
    optionalGateCheck('acceptance-evidence', input.acceptance, 'Acceptance evidence'),
    optionalGateCheck(
      'independent-review',
      input.independentReview,
      'Independent review',
    ),
    booleanCheck(
      'no-unresolved-blockers',
      input.unresolvedBlockers.length === 0,
      'No unresolved blockers remain.',
      `Unresolved blockers remain: ${input.unresolvedBlockers.join('; ')}`,
    ),
    booleanCheck(
      'no-material-uncertainty',
      input.materialUncertainties.length === 0,
      'No material uncertainty remains undisclosed or unresolved.',
      `Material uncertainties remain: ${input.materialUncertainties.join('; ')}`,
    ),
    booleanCheck(
      'department-head-attestation',
      input.departmentHeadAttested,
      'The department head attests that every required gate is satisfied.',
      'The department head has not attested readiness.',
    ),
  ];

  const satisfied = checks.filter(
    (check) => check.status === 'passed' || check.status === 'not-applicable',
  ).length;
  const readinessPercent = Math.round((satisfied / checks.length) * 100);
  const blockers = checks
    .filter((check) => check.status === 'failed' || check.status === 'pending')
    .map((check) => check.detail);

  return {
    readinessPercent,
    ready: readinessPercent === 100 && blockers.length === 0,
    checks,
    blockers,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Adapts durable Mission assignment evidence into the canonical fail-closed
 * readiness gate. This preserves the durable orchestration API without
 * creating a second readiness decision.
 */
export function evaluateDepartmentReadiness(
  assignment: DurableDepartmentAssignment,
  product: SpecialistWorkProduct,
): DurableDepartmentReadiness {
  const reasons: string[] = [];
  const unresolvedCriteria: string[] = [];
  const hasAcceptanceCriteria = assignment.acceptanceCriteria.length > 0;
  if (!hasAcceptanceCriteria) {
    reasons.push('The department assignment has no acceptance criteria.');
  }
  const hasDeliverables = product.deliverables.some((deliverable) => deliverable.trim() !== '');
  if (!hasDeliverables) {
    reasons.push('The specialist work product has no deliverables.');
  }
  const identityMatches =
    product.assignmentId === assignment.id &&
    product.departmentId === assignment.departmentId;
  if (product.assignmentId !== assignment.id) {
    reasons.push('The specialist product belongs to a different department assignment.');
  }
  if (product.departmentId !== assignment.departmentId) {
    reasons.push('The specialist product reports a different department.');
  }

  const assessmentsByCriterion = new Map<string, typeof product.criterionAssessments>();
  for (const assessment of product.criterionAssessments) {
    const existing = assessmentsByCriterion.get(assessment.criterionId) ?? [];
    assessmentsByCriterion.set(assessment.criterionId, [...existing, assessment]);
  }
  for (const criterion of assignment.acceptanceCriteria) {
    const assessments = assessmentsByCriterion.get(criterion.id) ?? [];
    if (assessments.length !== 1) {
      unresolvedCriteria.push(criterion.id);
      reasons.push(
        assessments.length === 0
          ? `Acceptance criterion ${criterion.id} has no assessment.`
          : `Acceptance criterion ${criterion.id} has multiple competing assessments.`,
      );
      continue;
    }
    const assessment = assessments[0];
    if (assessment?.status !== 'satisfied') {
      unresolvedCriteria.push(criterion.id);
      reasons.push(`Acceptance criterion ${criterion.id} is not satisfied.`);
      continue;
    }
    if (criterion.evidenceRequired && assessment.evidence.length === 0) {
      unresolvedCriteria.push(criterion.id);
      reasons.push(`Acceptance criterion ${criterion.id} is missing required evidence.`);
    }
  }

  const knownCriterionIds = new Set(
    assignment.acceptanceCriteria.map((criterion) => criterion.id),
  );
  const unknownCriterionIds = product.criterionAssessments
    .filter((assessment) => !knownCriterionIds.has(assessment.criterionId))
    .map((assessment) => assessment.criterionId);
  for (const criterionId of unknownCriterionIds) {
    reasons.push(`The product includes an assessment for unknown criterion ${criterionId}.`);
  }
  const blockingFindings = unique(
    product.blockingFindings.filter((finding) => finding.trim() !== ''),
  );
  if (blockingFindings.length > 0) reasons.push('Blocking findings remain unresolved.');
  const criteriaComplete = hasAcceptanceCriteria && unresolvedCriteria.length === 0;
  const productEvidence = new Set(product.evidence.filter((evidence) => evidence.trim() !== ''));
  const evidenceComplete =
    hasDeliverables &&
    productEvidence.size > 0 &&
    assignment.acceptanceCriteria.every((criterion) => {
      if (!criterion.evidenceRequired) return true;
      const assessment = product.criterionAssessments.find(
        (candidate) => candidate.criterionId === criterion.id,
      );
      return (
        (assessment?.evidence.length ?? 0) > 0 &&
        assessment!.evidence.every((evidence) => productEvidence.has(evidence))
      );
    });
  if (!evidenceComplete) {
    reasons.push('The work product does not contain complete supporting evidence.');
  }

  const canonical = assessDepartmentReadiness({
    specialistSubmissionPresent: identityMatches,
    requirementsSatisfied: criteriaComplete,
    scopePreserved: identityMatches && unknownCriterionIds.length === 0,
    evidenceAttached: evidenceComplete,
    acceptance: { status: criteriaComplete ? 'passed' : 'failed' },
    independentReview: {
      status: 'not-applicable',
      rationale: 'Independent executable Test/Review gates run after department readiness.',
    },
    unresolvedBlockers: blockingFindings,
    materialUncertainties: unknownCriterionIds.map(
      (criterionId) => `Unknown criterion: ${criterionId}`,
    ),
    departmentHeadAttested:
      identityMatches && criteriaComplete && evidenceComplete && blockingFindings.length === 0,
  });
  const ready = canonical.ready;
  const iterationLimitReached = assignment.iteration >= MAX_DEPARTMENT_ITERATIONS;
  return {
    assignmentId: assignment.id,
    ready,
    decision: ready ? 'ready' : iterationLimitReached ? 'escalate' : 'iterate',
    evidenceComplete,
    criteriaComplete,
    unresolvedCriteria: unique(unresolvedCriteria),
    blockingFindings,
    reasons: ready
      ? ['All explicit acceptance criteria are satisfied with required evidence and no blocker remains.']
      : unique([...reasons, ...canonical.blockers]),
  };
}
