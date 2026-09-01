import type { AgencyDivision } from './capabilityPolicy.js';
import {
  assessIntegrationImpact,
  reviewBranchForMission,
  type ChangeImpactSignal,
  type IntegrationImpactAssessment,
} from './destructivePolicy.js';
import {
  assessDepartmentReadiness,
  type DepartmentReadinessAssessment,
  type DepartmentReadinessInput,
} from './readiness.js';

export type QueenBeeProvider = 'claude' | 'codex' | 'chatgpt';

export type QueenBeeMissionState =
  | 'intake'
  | 'department-work'
  | 'queen-review'
  | 'council-review'
  | 'integration-assessment'
  | 'awaiting-user-approval'
  | 'ready-to-integrate'
  | 'integrated'
  | 'blocked';

export type DepartmentAssignmentState =
  | 'assigned'
  | 'specialist-working'
  | 'head-review'
  | 'revision-required'
  | 'ready-for-queen'
  | 'blocked';

export interface SpecialistSubmission {
  readonly specialistId: string;
  readonly revision: number;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
}

export interface DepartmentHeadReview {
  readonly revision: number;
  readonly feedback: string;
  readonly readiness: DepartmentReadinessAssessment;
}

export interface DepartmentAssignment {
  readonly department: AgencyDivision;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly specialistIds: readonly string[];
  readonly state: DepartmentAssignmentState;
  readonly iteration: number;
  readonly latestSubmission?: SpecialistSubmission | undefined;
  readonly latestHeadReview?: DepartmentHeadReview | undefined;
}

export interface QueenBeeReview {
  readonly accepted: boolean;
  readonly summary: string;
  readonly departmentRevisionRequests: Readonly<Partial<Record<AgencyDivision, string>>>;
}

export type CouncilVerdict = 'approve' | 'revise' | 'block';

export interface LlmCouncilReview {
  readonly verdict: CouncilVerdict;
  readonly summary: string;
  readonly departmentRevisionRequests: Readonly<Partial<Record<AgencyDivision, string>>>;
  readonly evidenceReference?: string | undefined;
}

export interface QueenBeeIntegrationDecision {
  readonly impact: IntegrationImpactAssessment;
  readonly target: 'main' | string;
  readonly userApproved: boolean;
}

export interface QueenBeeMission {
  readonly id: string;
  readonly provider: QueenBeeProvider;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly state: QueenBeeMissionState;
  readonly departments: readonly DepartmentAssignment[];
  readonly queenReview?: QueenBeeReview | undefined;
  readonly councilReview?: LlmCouncilReview | undefined;
  readonly integration?: QueenBeeIntegrationDecision | undefined;
  readonly blockers: readonly string[];
}

export const MAX_DEPARTMENT_ITERATIONS = 8;

function replaceDepartment(
  mission: QueenBeeMission,
  department: AgencyDivision,
  transform: (assignment: DepartmentAssignment) => DepartmentAssignment,
): QueenBeeMission {
  const index = mission.departments.findIndex(
    (assignment) => assignment.department === department,
  );
  if (index < 0) throw new Error(`Department ${department} is not assigned to this mission.`);
  const departments = [...mission.departments];
  departments[index] = transform(departments[index]!);
  return { ...mission, departments };
}

function requireState(
  mission: QueenBeeMission,
  allowed: readonly QueenBeeMissionState[],
  operation: string,
): void {
  if (!allowed.includes(mission.state)) {
    throw new Error(
      `${operation} is not valid while mission ${mission.id} is ${mission.state}.`,
    );
  }
}

export function createQueenBeeMission(request: {
  readonly id: string;
  readonly provider: QueenBeeProvider;
  readonly objective: string;
  readonly constraints?: readonly string[] | undefined;
}): QueenBeeMission {
  if (request.id.trim() === '') throw new TypeError('Mission ID is required.');
  if (request.objective.trim() === '') throw new TypeError('Mission objective is required.');
  return {
    id: request.id,
    provider: request.provider,
    objective: request.objective.trim(),
    constraints: [...(request.constraints ?? [])],
    state: 'intake',
    departments: [],
    blockers: [],
  };
}

export function assignDepartment(
  mission: QueenBeeMission,
  request: {
    readonly department: AgencyDivision;
    readonly objective: string;
    readonly specialistIds: readonly string[];
    readonly constraints?: readonly string[] | undefined;
  },
): QueenBeeMission {
  requireState(mission, ['intake', 'department-work'], 'Department assignment');
  if (mission.departments.some((entry) => entry.department === request.department)) {
    throw new Error(`Department ${request.department} already has a mission assignment.`);
  }
  if (request.objective.trim() === '') throw new TypeError('Department objective is required.');
  const specialistIds = [...new Set(request.specialistIds.map((value) => value.trim()))].filter(Boolean);
  if (specialistIds.length === 0) {
    throw new TypeError('A department assignment requires at least one specialist.');
  }
  return {
    ...mission,
    state: 'department-work',
    departments: [
      ...mission.departments,
      {
        department: request.department,
        objective: request.objective.trim(),
        constraints: [...(request.constraints ?? [])],
        specialistIds,
        state: 'assigned',
        iteration: 0,
      },
    ],
  };
}

export function recordSpecialistSubmission(
  mission: QueenBeeMission,
  department: AgencyDivision,
  submission: Omit<SpecialistSubmission, 'revision'>,
): QueenBeeMission {
  requireState(mission, ['department-work'], 'Specialist submission');
  return replaceDepartment(mission, department, (assignment) => {
    if (assignment.state === 'ready-for-queen' || assignment.state === 'blocked') {
      throw new Error(`Department ${department} is not accepting specialist submissions.`);
    }
    if (!assignment.specialistIds.includes(submission.specialistId)) {
      throw new Error(
        `Specialist ${submission.specialistId} is not assigned to department ${department}.`,
      );
    }
    const iteration = assignment.iteration + 1;
    if (iteration > MAX_DEPARTMENT_ITERATIONS) {
      return {
        ...assignment,
        state: 'blocked',
        iteration,
      };
    }
    return {
      ...assignment,
      state: 'head-review',
      iteration,
      latestSubmission: {
        ...submission,
        revision: iteration,
        evidence: [...submission.evidence],
        risks: [...submission.risks],
      },
    };
  });
}

export function recordDepartmentHeadReview(
  mission: QueenBeeMission,
  department: AgencyDivision,
  request: {
    readonly readiness: DepartmentReadinessInput;
    readonly feedback: string;
  },
): QueenBeeMission {
  requireState(mission, ['department-work'], 'Department head review');
  let next = replaceDepartment(mission, department, (assignment) => {
    if (assignment.state !== 'head-review' || assignment.latestSubmission === undefined) {
      throw new Error(`Department ${department} has no specialist submission awaiting head review.`);
    }
    const readiness = assessDepartmentReadiness(request.readiness);
    if (!readiness.ready && request.feedback.trim() === '') {
      throw new TypeError('A rejected department submission requires revision feedback.');
    }
    const blocked = !readiness.ready && assignment.iteration >= MAX_DEPARTMENT_ITERATIONS;
    return {
      ...assignment,
      state: readiness.ready
        ? 'ready-for-queen'
        : blocked
          ? 'blocked'
          : 'revision-required',
      latestHeadReview: {
        revision: assignment.latestSubmission.revision,
        feedback: request.feedback.trim(),
        readiness,
      },
    };
  });

  const blockedDepartment = next.departments.find((entry) => entry.state === 'blocked');
  if (blockedDepartment !== undefined) {
    next = {
      ...next,
      state: 'blocked',
      blockers: [
        ...next.blockers,
        `${blockedDepartment.department} exhausted the ${MAX_DEPARTMENT_ITERATIONS}-iteration specialist review limit.`,
      ],
    };
  } else if (
    next.departments.length > 0 &&
    next.departments.every((entry) => entry.state === 'ready-for-queen')
  ) {
    next = { ...next, state: 'queen-review' };
  }

  return next;
}

export function recordQueenBeeReview(
  mission: QueenBeeMission,
  review: QueenBeeReview,
): QueenBeeMission {
  requireState(mission, ['queen-review'], 'Queen Bee review');
  if (review.accepted) {
    return {
      ...mission,
      queenReview: review,
      state: 'council-review',
    };
  }

  const requested = Object.entries(review.departmentRevisionRequests) as Array<
    [AgencyDivision, string]
  >;
  if (requested.length === 0) {
    throw new TypeError('A rejected Queen Bee review must identify a department revision.');
  }
  const requestedIds = new Set(requested.map(([department]) => department));
  const departments = mission.departments.map((assignment) =>
    requestedIds.has(assignment.department)
      ? { ...assignment, state: 'revision-required' as const }
      : assignment,
  );
  return {
    ...mission,
    queenReview: review,
    councilReview: undefined,
    integration: undefined,
    departments,
    state: 'department-work',
  };
}

export function recordLlmCouncilReview(
  mission: QueenBeeMission,
  review: LlmCouncilReview,
): QueenBeeMission {
  requireState(mission, ['council-review'], 'LLM Council review');
  if (review.verdict === 'approve') {
    return {
      ...mission,
      councilReview: review,
      state: 'integration-assessment',
    };
  }
  if (review.verdict === 'block') {
    return {
      ...mission,
      councilReview: review,
      state: 'blocked',
      blockers: [...mission.blockers, review.summary],
    };
  }

  const requested = Object.entries(review.departmentRevisionRequests) as Array<
    [AgencyDivision, string]
  >;
  if (requested.length === 0) {
    throw new TypeError('A Council revision verdict must identify a department revision.');
  }
  const requestedIds = new Set(requested.map(([department]) => department));
  return {
    ...mission,
    councilReview: review,
    integration: undefined,
    departments: mission.departments.map((assignment) =>
      requestedIds.has(assignment.department)
        ? { ...assignment, state: 'revision-required' as const }
        : assignment,
    ),
    state: 'department-work',
  };
}

export function assessQueenBeeIntegration(
  mission: QueenBeeMission,
  signals: readonly ChangeImpactSignal[],
): QueenBeeMission {
  requireState(mission, ['integration-assessment'], 'Integration assessment');
  const impact = assessIntegrationImpact(signals);
  const needsApproval = impact.requiresUserApproval;
  return {
    ...mission,
    integration: {
      impact,
      target: needsApproval ? reviewBranchForMission(mission.id) : 'main',
      userApproved: !needsApproval,
    },
    state: needsApproval ? 'awaiting-user-approval' : 'ready-to-integrate',
  };
}

export function approveQueenBeeIntegration(
  mission: QueenBeeMission,
): QueenBeeMission {
  requireState(mission, ['awaiting-user-approval'], 'User integration approval');
  if (mission.integration === undefined) {
    throw new Error('No integration assessment is available for approval.');
  }
  return {
    ...mission,
    integration: { ...mission.integration, userApproved: true },
    state: 'ready-to-integrate',
  };
}

export function markQueenBeeIntegrated(
  mission: QueenBeeMission,
): QueenBeeMission {
  requireState(mission, ['ready-to-integrate'], 'Integration completion');
  if (mission.integration === undefined || mission.integration.userApproved !== true) {
    throw new Error('Integration cannot complete without the required approval state.');
  }
  return { ...mission, state: 'integrated' };
}
