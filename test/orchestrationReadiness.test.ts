import { describe, expect, it } from 'vitest';
import { evaluateDepartmentReadiness } from '../src/orchestration/readiness.js';
import type {
  DepartmentAssignment,
  SpecialistWorkProduct,
} from '../src/orchestration/types.js';

function assignment(iteration = 1): DepartmentAssignment {
  return {
    id: 'department_assignment_engineering',
    missionId: 'mission_test',
    departmentId: 'engineering',
    objective: 'Produce an evidence-backed implementation recommendation.',
    includedScope: ['mission orchestration'],
    excludedScope: ['production deployment'],
    dependsOn: [],
    acceptanceCriteria: [
      {
        id: 'criterion-behavior',
        description: 'The required behavior is accounted for.',
        evidenceRequired: true,
      },
      {
        id: 'criterion-risk',
        description: 'Material risks are addressed.',
        evidenceRequired: true,
      },
    ],
    iteration,
    state: 'head-review',
  };
}

function product(): SpecialistWorkProduct {
  return {
    workId: 'specialist_work_1',
    assignmentId: 'department_assignment_engineering',
    departmentId: 'engineering',
    specialistRole: 'Software Architect',
    summary: 'The bounded recommendation satisfies both criteria.',
    deliverables: ['implementation brief'],
    criterionAssessments: [
      {
        criterionId: 'criterion-behavior',
        status: 'satisfied',
        evidence: ['behavior-evidence'],
        rationale: 'The required flow is explicitly covered.',
      },
      {
        criterionId: 'criterion-risk',
        status: 'satisfied',
        evidence: ['risk-evidence'],
        rationale: 'The material risks have explicit mitigations.',
      },
    ],
    evidence: ['behavior-evidence', 'risk-evidence'],
    risks: [],
    blockingFindings: [],
    assumptions: [],
  };
}

describe('department readiness', () => {
  it('marks work ready only when every criterion has required evidence and no blockers remain', () => {
    const result = evaluateDepartmentReadiness(assignment(), product());

    expect(result.ready).toBe(true);
    expect(result.decision).toBe('ready');
    expect(result.criteriaComplete).toBe(true);
    expect(result.evidenceComplete).toBe(true);
  });

  it('iterates when a required criterion lacks evidence', () => {
    const source = product();
    const missingEvidence: SpecialistWorkProduct = {
      ...source,
      criterionAssessments: source.criterionAssessments.map((assessment, index) =>
        index === 0 ? { ...assessment, evidence: [] } : assessment,
      ),
    };

    const result = evaluateDepartmentReadiness(assignment(), missingEvidence);

    expect(result.ready).toBe(false);
    expect(result.decision).toBe('iterate');
    expect(result.unresolvedCriteria).toContain('criterion-behavior');
  });

  it('iterates while a blocking finding remains even if criteria are satisfied', () => {
    const blocked: SpecialistWorkProduct = {
      ...product(),
      blockingFindings: ['Dependency evidence is stale.'],
    };

    const result = evaluateDepartmentReadiness(assignment(), blocked);

    expect(result.ready).toBe(false);
    expect(result.decision).toBe('iterate');
    expect(result.blockingFindings).toEqual(['Dependency evidence is stale.']);
  });

  it('escalates rather than looping after the sixth unsuccessful iteration', () => {
    const source = product();
    const incomplete: SpecialistWorkProduct = {
      ...source,
      criterionAssessments: source.criterionAssessments.map((assessment, index) =>
        index === 1 ? { ...assessment, status: 'unsatisfied' } : assessment,
      ),
    };

    const result = evaluateDepartmentReadiness(assignment(6), incomplete);

    expect(result.ready).toBe(false);
    expect(result.decision).toBe('escalate');
    expect(result.unresolvedCriteria).toContain('criterion-risk');
  });

  it('rejects a product from a different assignment', () => {
    const mismatched: SpecialistWorkProduct = {
      ...product(),
      assignmentId: 'department_assignment_other',
    };

    const result = evaluateDepartmentReadiness(assignment(), mismatched);

    expect(result.ready).toBe(false);
    expect(result.reasons.join(' ')).toContain('different department assignment');
  });

  it('fails closed when acceptance criteria or deliverables are empty', () => {
    const noCriteria: DepartmentAssignment = {
      ...assignment(),
      acceptanceCriteria: [],
    };
    expect(evaluateDepartmentReadiness(noCriteria, product())).toMatchObject({
      ready: false,
      criteriaComplete: false,
    });

    const noDeliverables: SpecialistWorkProduct = {
      ...product(),
      deliverables: [],
    };
    expect(evaluateDepartmentReadiness(assignment(), noDeliverables)).toMatchObject({
      ready: false,
      evidenceComplete: false,
    });
  });

  it('requires criterion evidence to be present in the product evidence packet', () => {
    const disconnectedEvidence: SpecialistWorkProduct = {
      ...product(),
      evidence: ['unrelated-evidence'],
    };

    const result = evaluateDepartmentReadiness(assignment(), disconnectedEvidence);

    expect(result.ready).toBe(false);
    expect(result.evidenceComplete).toBe(false);
  });
});
