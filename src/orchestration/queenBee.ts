import type { AgencyDivision } from './capabilityPolicy.js';
import { MAX_DEPARTMENT_ITERATIONS as DURABLE_MAX_DEPARTMENT_ITERATIONS } from './types.js';
import type {
  AcceptanceCriterion,
  CriterionAssessment,
  DepartmentAssignment as DurableDepartmentAssignment,
  DepartmentReadiness as DurableDepartmentReadiness,
  QueenBeeCouncilPacket,
  QueenBeeDepartmentResult,
  ProposedAction,
  SpecialistWorkProduct,
} from './types.js';
import {
  assessIntegrationImpact,
  reviewBranchForMission,
  type ChangeImpactSignal,
  type IntegrationImpactAssessment,
} from './destructivePolicy.js';
import {
  evaluateDepartmentReadiness,
  type OptionalReadinessGate,
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
  readonly deliverables: readonly string[];
  readonly criterionAssessments: readonly CriterionAssessment[];
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly blockingFindings: readonly string[];
  readonly assumptions: readonly string[];
}

export interface DepartmentHeadReview {
  readonly revision: number;
  readonly feedback: string;
  readonly readiness: DurableDepartmentReadiness;
}

export interface DepartmentAssignment {
  readonly department: AgencyDivision;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
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

export interface IntegrationGateEvidence extends OptionalReadinessGate {
  readonly evidence: readonly string[];
}

export interface QueenBeeIntegrationGates {
  readonly test: IntegrationGateEvidence;
  readonly review: IntegrationGateEvidence;
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
  readonly integrationGates?: QueenBeeIntegrationGates | undefined;
  readonly integration?: QueenBeeIntegrationDecision | undefined;
  readonly blockers: readonly string[];
}

export const MAX_DEPARTMENT_ITERATIONS = DURABLE_MAX_DEPARTMENT_ITERATIONS;

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
    readonly acceptanceCriteria: readonly AcceptanceCriterion[];
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
  const acceptanceCriteria = request.acceptanceCriteria.map((criterion) => ({
    ...criterion,
    id: criterion.id.trim(),
    description: criterion.description.trim(),
  }));
  if (
    acceptanceCriteria.length === 0 ||
    acceptanceCriteria.some((criterion) => criterion.id === '' || criterion.description === '')
  ) {
    throw new TypeError('A department assignment requires explicit, non-empty acceptance criteria.');
  }
  if (new Set(acceptanceCriteria.map((criterion) => criterion.id)).size !== acceptanceCriteria.length) {
    throw new TypeError('Department acceptance criterion IDs must be unique.');
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
        acceptanceCriteria,
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
    if (!['assigned', 'revision-required'].includes(assignment.state)) {
      throw new Error(`Department ${department} is not accepting specialist submissions.`);
    }
    if (!assignment.specialistIds.includes(submission.specialistId)) {
      throw new Error(
        `Specialist ${submission.specialistId} is not assigned to department ${department}.`,
      );
    }
    if (submission.summary.trim() === '') {
      throw new TypeError('A specialist submission requires a non-empty summary.');
    }
    const deliverables = submission.deliverables.map((value) => value.trim()).filter(Boolean);
    const evidence = submission.evidence.map((value) => value.trim()).filter(Boolean);
    if (deliverables.length === 0 || evidence.length === 0) {
      throw new TypeError('A specialist submission requires deliverables and evidence.');
    }
    if (submission.criterionAssessments.length === 0) {
      throw new TypeError('A specialist submission requires criterion assessments.');
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
        summary: submission.summary.trim(),
        revision: iteration,
        deliverables,
        criterionAssessments: submission.criterionAssessments.map((assessment) => ({
          ...assessment,
          evidence: [...assessment.evidence],
        })),
        evidence,
        risks: [...submission.risks],
        blockingFindings: [...submission.blockingFindings],
        assumptions: [...submission.assumptions],
      },
    };
  });
}

export function recordDepartmentHeadReview(
  mission: QueenBeeMission,
  department: AgencyDivision,
  request: {
    readonly feedback: string;
  },
): QueenBeeMission {
  requireState(mission, ['department-work'], 'Department head review');
  let next = replaceDepartment(mission, department, (assignment) => {
    if (assignment.state !== 'head-review' || assignment.latestSubmission === undefined) {
      throw new Error(`Department ${department} has no specialist submission awaiting head review.`);
    }
    const assignmentId = `${mission.id}:${department}`;
    const durableAssignment: DurableDepartmentAssignment = {
      id: assignmentId,
      missionId: mission.id,
      departmentId: department,
      objective: assignment.objective,
      includedScope: [assignment.objective],
      excludedScope: assignment.constraints,
      dependsOn: [],
      acceptanceCriteria: assignment.acceptanceCriteria,
      iteration: assignment.iteration,
      state: 'head-review',
    };
    const submission = assignment.latestSubmission;
    const product: SpecialistWorkProduct = {
      workId: `${assignmentId}:revision:${submission.revision}`,
      assignmentId,
      departmentId: department,
      specialistRole: submission.specialistId,
      summary: submission.summary,
      deliverables: submission.deliverables,
      criterionAssessments: submission.criterionAssessments,
      evidence: submission.evidence,
      risks: submission.risks,
      blockingFindings: submission.blockingFindings,
      assumptions: submission.assumptions,
    };
    const readiness = evaluateDepartmentReadiness(durableAssignment, product);
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
    integrationGates: undefined,
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
    integrationGates: undefined,
    integration: undefined,
    departments: mission.departments.map((assignment) =>
      requestedIds.has(assignment.department)
        ? { ...assignment, state: 'revision-required' as const }
        : assignment,
    ),
    state: 'department-work',
  };
}

function integrationGateProblem(
  label: string,
  gate: IntegrationGateEvidence | undefined,
): string | undefined {
  if (gate === undefined) return `${label} gate evidence is missing.`;
  if (gate.status === 'passed') {
    return gate.evidence.some((entry) => entry.trim() !== '')
      ? undefined
      : `${label} gate passed without evidence.`;
  }
  if (gate.status === 'not-applicable') {
    return (gate.rationale ?? '').trim() !== ''
      ? undefined
      : `${label} gate was marked not applicable without a rationale.`;
  }
  return `${label} gate has status ${gate.status}.`;
}

function requireIntegrationGates(mission: QueenBeeMission): void {
  const problems = [
    integrationGateProblem('Native Test', mission.integrationGates?.test),
    integrationGateProblem('Native Review', mission.integrationGates?.review),
  ].filter((problem): problem is string => problem !== undefined);
  if (problems.length > 0) {
    throw new Error(`Integration gates are not satisfied: ${problems.join(' ')}`);
  }
}

export function recordIntegrationGates(
  mission: QueenBeeMission,
  gates: QueenBeeIntegrationGates,
): QueenBeeMission {
  requireState(mission, ['integration-assessment'], 'Integration gate recording');
  return {
    ...mission,
    integrationGates: {
      test: { ...gates.test, evidence: [...gates.test.evidence] },
      review: { ...gates.review, evidence: [...gates.review.evidence] },
    },
  };
}

export function assessQueenBeeIntegration(
  mission: QueenBeeMission,
  signals: readonly ChangeImpactSignal[],
): QueenBeeMission {
  requireState(mission, ['integration-assessment'], 'Integration assessment');
  requireIntegrationGates(mission);
  const impact = assessIntegrationImpact(signals);
  const needsApproval = impact.requiresUserApproval;
  return {
    ...mission,
    integration: {
      impact,
      target: needsApproval ? reviewBranchForMission(mission.id) : 'main',
      userApproved: false,
    },
    state: 'awaiting-user-approval',
  };
}

export function approveQueenBeeIntegration(
  mission: QueenBeeMission,
): QueenBeeMission {
  requireState(mission, ['awaiting-user-approval'], 'User integration approval');
  if (mission.integration === undefined) {
    throw new Error('No integration assessment is available for approval.');
  }
  requireIntegrationGates(mission);
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
  requireIntegrationGates(mission);
  return { ...mission, state: 'integrated' };
}

export interface DepartmentPlanValidation {
  readonly valid: boolean;
  readonly orderedAssignmentIds: readonly string[];
  readonly problems: readonly string[];
}

function dependencyOrder(
  assignments: readonly DurableDepartmentAssignment[],
): DepartmentPlanValidation {
  const problems: string[] = [];
  const byId = new Map<string, DurableDepartmentAssignment>();
  for (const assignment of assignments) {
    if (byId.has(assignment.id)) {
      problems.push(`Duplicate department assignment id: ${assignment.id}.`);
    } else {
      byId.set(assignment.id, assignment);
    }
  }
  if (new Set(assignments.map((assignment) => assignment.missionId)).size > 1) {
    problems.push('A Queen Bee department plan cannot mix assignments from multiple Missions.');
  }
  for (const assignment of assignments) {
    for (const dependencyId of assignment.dependsOn) {
      if (!byId.has(dependencyId)) {
        problems.push(`Department assignment ${assignment.id} depends on unknown assignment ${dependencyId}.`);
      }
      if (dependencyId === assignment.id) {
        problems.push(`Department assignment ${assignment.id} cannot depend on itself.`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (assignmentId: string): void => {
    if (visited.has(assignmentId)) return;
    if (visiting.has(assignmentId)) {
      problems.push(`Department dependency cycle detected at ${assignmentId}.`);
      return;
    }
    const assignment = byId.get(assignmentId);
    if (assignment === undefined) return;
    visiting.add(assignmentId);
    for (const dependencyId of assignment.dependsOn) visit(dependencyId);
    visiting.delete(assignmentId);
    visited.add(assignmentId);
    order.push(assignmentId);
  };
  for (const assignment of assignments) visit(assignment.id);
  return {
    valid: problems.length === 0,
    orderedAssignmentIds: problems.length === 0 ? order : [],
    problems: [...new Set(problems)],
  };
}

export function validateDepartmentPlan(
  assignments: readonly DurableDepartmentAssignment[],
): DepartmentPlanValidation {
  if (assignments.length === 0) {
    return {
      valid: false,
      orderedAssignmentIds: [],
      problems: ['A Mission must contain at least one department assignment.'],
    };
  }
  return dependencyOrder(assignments);
}

export interface CouncilReadiness {
  readonly ready: boolean;
  readonly problems: readonly string[];
}

export function evaluateCouncilReadiness(
  results: readonly QueenBeeDepartmentResult[],
): CouncilReadiness {
  const problems: string[] = [];
  const plan = validateDepartmentPlan(results.map((result) => result.assignment));
  problems.push(...plan.problems);
  const resultByAssignmentId = new Map(
    results.map((result) => [result.assignment.id, result] as const),
  );
  const computedReadinessByAssignmentId = new Map(
    results.map((result) => [
      result.assignment.id,
      evaluateDepartmentReadiness(result.assignment, result.product),
    ] as const),
  );
  for (const result of results) {
    const computedReadiness = computedReadinessByAssignmentId.get(result.assignment.id)!;
    if (!computedReadiness.ready) {
      problems.push(`Department ${result.assignment.departmentId} is not ready: ${computedReadiness.reasons.join(' ')}`);
    }
    if (
      result.review.assignmentId !== result.assignment.id ||
      result.review.departmentId !== result.assignment.departmentId ||
      result.review.iteration !== result.assignment.iteration
    ) {
      problems.push(`Department ${result.assignment.departmentId} returned a mismatched head review.`);
    }
    if (JSON.stringify(result.review.readiness) !== JSON.stringify(computedReadiness)) {
      problems.push(`Department ${result.assignment.departmentId} supplied stale or unverified readiness.`);
    }
    if (
      result.product.assignmentId !== result.assignment.id ||
      result.product.departmentId !== result.assignment.departmentId
    ) {
      problems.push(`Department ${result.assignment.departmentId} returned a mismatched work product.`);
    }
    for (const dependencyId of result.assignment.dependsOn) {
      const dependency = resultByAssignmentId.get(dependencyId);
      const dependencyReadiness = computedReadinessByAssignmentId.get(dependencyId);
      if (dependency === undefined || dependencyReadiness?.ready !== true) {
        problems.push(`Department ${result.assignment.departmentId} depends on unfinished assignment ${dependencyId}.`);
      }
    }
  }
  if (new Set(results.map((result) => result.assignment.id)).size !== results.length) {
    problems.push('Queen Bee received duplicate department results for the same assignment.');
  }
  return { ready: problems.length === 0, problems: [...new Set(problems)] };
}

export interface CouncilPacketInput {
  readonly missionId: string;
  readonly exactQuestion: string;
  readonly departmentResults: readonly QueenBeeDepartmentResult[];
  readonly crossDepartmentConflicts?: readonly string[] | undefined;
  readonly unresolvedUncertainties?: readonly string[] | undefined;
  readonly proposedActions?: readonly ProposedAction[] | undefined;
}

export function buildCouncilPacket(input: CouncilPacketInput): QueenBeeCouncilPacket {
  const readiness = evaluateCouncilReadiness(input.departmentResults);
  if (!readiness.ready) {
    throw new Error(`Council packet blocked: ${readiness.problems.join(' ')}`);
  }
  if (input.exactQuestion.trim() === '') {
    throw new Error('Council packet blocked: the exact Mission question is empty.');
  }
  for (const result of input.departmentResults) {
    if (result.assignment.missionId !== input.missionId) {
      throw new Error(`Council packet blocked: assignment ${result.assignment.id} belongs to another Mission.`);
    }
  }
  return Object.freeze({
    missionId: input.missionId,
    exactQuestion: input.exactQuestion,
    departmentResults: Object.freeze([...input.departmentResults]),
    crossDepartmentConflicts: Object.freeze([...(input.crossDepartmentConflicts ?? [])]),
    unresolvedUncertainties: Object.freeze([...(input.unresolvedUncertainties ?? [])]),
    proposedActions: Object.freeze([...(input.proposedActions ?? [])]),
  });
}
