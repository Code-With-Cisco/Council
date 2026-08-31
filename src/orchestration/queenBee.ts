import type {
  DepartmentAssignment,
  QueenBeeCouncilPacket,
  QueenBeeDepartmentResult,
  ProposedAction,
} from './types.js';

export interface DepartmentPlanValidation {
  readonly valid: boolean;
  readonly orderedAssignmentIds: readonly string[];
  readonly problems: readonly string[];
}

function dependencyOrder(
  assignments: readonly DepartmentAssignment[],
): DepartmentPlanValidation {
  const problems: string[] = [];
  const byId = new Map<string, DepartmentAssignment>();

  for (const assignment of assignments) {
    if (byId.has(assignment.id)) {
      problems.push(`Duplicate department assignment id: ${assignment.id}.`);
    } else {
      byId.set(assignment.id, assignment);
    }
  }

  const missionIds = new Set(assignments.map((assignment) => assignment.missionId));
  if (missionIds.size > 1) {
    problems.push('A Queen Bee department plan cannot mix assignments from multiple Missions.');
  }

  for (const assignment of assignments) {
    for (const dependencyId of assignment.dependsOn) {
      if (!byId.has(dependencyId)) {
        problems.push(
          `Department assignment ${assignment.id} depends on unknown assignment ${dependencyId}.`,
        );
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
  assignments: readonly DepartmentAssignment[],
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
  const assignments = results.map((result) => result.assignment);
  const plan = validateDepartmentPlan(assignments);
  problems.push(...plan.problems);

  const resultByAssignmentId = new Map(
    results.map((result) => [result.assignment.id, result] as const),
  );

  for (const result of results) {
    if (!result.review.readiness.ready) {
      problems.push(
        `Department ${result.assignment.departmentId} is not ready: ${result.review.readiness.reasons.join(' ')}`,
      );
    }
    if (result.product.assignmentId !== result.assignment.id) {
      problems.push(`Department ${result.assignment.departmentId} returned a mismatched work product.`);
    }
    for (const dependencyId of result.assignment.dependsOn) {
      const dependency = resultByAssignmentId.get(dependencyId);
      if (dependency === undefined || !dependency.review.readiness.ready) {
        problems.push(
          `Department ${result.assignment.departmentId} depends on unfinished assignment ${dependencyId}.`,
        );
      }
    }
  }

  const assignmentsWithResults = new Set(results.map((result) => result.assignment.id));
  if (assignmentsWithResults.size !== results.length) {
    problems.push('Queen Bee received duplicate department results for the same assignment.');
  }

  return {
    ready: problems.length === 0,
    problems: [...new Set(problems)],
  };
}

export interface CouncilPacketInput {
  readonly missionId: string;
  readonly exactQuestion: string;
  readonly departmentResults: readonly QueenBeeDepartmentResult[];
  readonly crossDepartmentConflicts?: readonly string[] | undefined;
  readonly unresolvedUncertainties?: readonly string[] | undefined;
  readonly proposedActions?: readonly ProposedAction[] | undefined;
}

/**
 * Freezes the exact evidence Queen Bee sends to the independent LLM Council.
 * The caller must not silently summarize or omit a department after this point.
 */
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
      throw new Error(
        `Council packet blocked: assignment ${result.assignment.id} belongs to another Mission.`,
      );
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
