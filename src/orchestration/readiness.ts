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
