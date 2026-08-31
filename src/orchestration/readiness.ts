import {
  MAX_DEPARTMENT_ITERATIONS,
  type DepartmentAssignment,
  type DepartmentReadiness,
  type SpecialistWorkProduct,
} from './types.js';

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * "100% ready" in Council means every explicit acceptance criterion has an
 * evidence-backed satisfied assessment and no blocker remains. It is never a
 * model's self-reported probability or confidence score.
 */
export function evaluateDepartmentReadiness(
  assignment: DepartmentAssignment,
  product: SpecialistWorkProduct,
): DepartmentReadiness {
  const reasons: string[] = [];
  const unresolvedCriteria: string[] = [];

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

  const knownCriterionIds = new Set(assignment.acceptanceCriteria.map((criterion) => criterion.id));
  for (const assessment of product.criterionAssessments) {
    if (!knownCriterionIds.has(assessment.criterionId)) {
      reasons.push(`The product includes an assessment for unknown criterion ${assessment.criterionId}.`);
    }
  }

  const blockingFindings = unique(product.blockingFindings.filter((finding) => finding.trim() !== ''));
  if (blockingFindings.length > 0) {
    reasons.push('Blocking findings remain unresolved.');
  }

  const criteriaComplete = unresolvedCriteria.length === 0;
  const evidenceComplete =
    product.evidence.length > 0 &&
    assignment.acceptanceCriteria.every((criterion) => {
      if (!criterion.evidenceRequired) return true;
      const assessment = product.criterionAssessments.find(
        (candidate) => candidate.criterionId === criterion.id,
      );
      return (assessment?.evidence.length ?? 0) > 0;
    });
  if (!evidenceComplete) reasons.push('The work product does not contain complete supporting evidence.');

  const identityMatches =
    product.assignmentId === assignment.id &&
    product.departmentId === assignment.departmentId;
  const ready =
    identityMatches &&
    criteriaComplete &&
    evidenceComplete &&
    blockingFindings.length === 0 &&
    reasons.every((reason) => !reason.includes('unknown criterion'));

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
      : reasons,
  };
}
