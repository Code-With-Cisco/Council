import { describe, expect, it } from 'vitest';

import {
  resolveAgencyCapabilityGrant,
  resolveCapabilityGrant,
} from '../src/orchestration/capabilityPolicy.js';
import { assessIntegrationImpact } from '../src/orchestration/destructivePolicy.js';
import { buildOfficeTower } from '../src/orchestration/officeState.js';
import {
  approveQueenBeeIntegration,
  assessQueenBeeIntegration,
  assignDepartment,
  buildCouncilPacket,
  createQueenBeeMission,
  evaluateCouncilReadiness,
  markQueenBeeIntegrated,
  recordDepartmentHeadReview,
  recordIntegrationGates,
  recordLlmCouncilReview,
  recordQueenBeeReview,
  recordSpecialistSubmission,
} from '../src/orchestration/queenBee.js';
import {
  assessDepartmentReadiness,
  evaluateDepartmentReadiness,
} from '../src/orchestration/readiness.js';
import type {
  DepartmentAssignment as DurableDepartmentAssignment,
  QueenBeeDepartmentResult,
  SpecialistWorkProduct,
} from '../src/orchestration/types.js';

const passedReadiness = {
  specialistSubmissionPresent: true,
  requirementsSatisfied: true,
  scopePreserved: true,
  evidenceAttached: true,
  acceptance: { status: 'passed' as const },
  independentReview: { status: 'passed' as const },
  unresolvedBlockers: [] as const,
  materialUncertainties: [] as const,
  departmentHeadAttested: true,
};

describe('host-owned Agency capability profiles', () => {
  it('keeps imported engineering specialists read-only', () => {
    const planning = resolveAgencyCapabilityGrant({
      division: 'engineering',
      risk: 'standard',
      missionAccessMode: 'read-only',
      implementationAssigned: false,
    });
    expect(planning.granted).not.toContain('workspace-write');
    expect(planning.granted).not.toContain('command-execution');

    const implementation = resolveAgencyCapabilityGrant({
      division: 'engineering',
      risk: 'standard',
      missionAccessMode: 'workspace-write',
      implementationAssigned: true,
    });
    expect(implementation.granted).not.toContain('workspace-write');
    expect(implementation.granted).not.toContain('command-execution');
    expect(implementation.granted).not.toContain('destructive-operation');
    expect(implementation.granted).not.toContain('persistent-memory');
  });

  it('keeps intrusive security execution disabled without independent authorization', () => {
    const unauthorized = resolveAgencyCapabilityGrant({
      division: 'security',
      risk: 'restricted-security',
      missionAccessMode: 'workspace-write',
      implementationAssigned: true,
      securityAuthorized: false,
    });
    expect(unauthorized.granted).not.toContain('workspace-write');
    expect(unauthorized.granted).not.toContain('command-execution');

    const authorized = resolveAgencyCapabilityGrant({
      division: 'security',
      risk: 'restricted-security',
      missionAccessMode: 'workspace-write',
      implementationAssigned: true,
      securityAuthorized: true,
    });
    expect(authorized.granted).not.toContain('workspace-write');
    expect(authorized.granted).not.toContain('command-execution');
    expect(authorized.granted).not.toContain('destructive-operation');
  });

  it('keeps high-stakes specialists analysis-only even on a write mission', () => {
    const grant = resolveAgencyCapabilityGrant({
      division: 'healthcare',
      risk: 'high-stakes',
      missionAccessMode: 'workspace-write',
      implementationAssigned: true,
    });
    expect(grant.granted).toEqual([
      'workspace-read',
      'workspace-search',
      'web-research',
    ]);
  });

  it('reserves implementation and executable acceptance for protected native roles', () => {
    const builder = resolveCapabilityGrant({
      profileId: 'native-builder',
      missionAccessMode: 'workspace-write',
      implementationAssigned: true,
    });
    expect(builder.granted).toContain('workspace-write');
    expect(builder.granted).toContain('command-execution');

    const test = resolveCapabilityGrant({
      profileId: 'native-test',
      missionAccessMode: 'read-only',
    });
    expect(test.granted).not.toContain('workspace-write');
    expect(test.granted).toContain('command-execution');
  });
});

describe('department readiness', () => {
  it('reaches 100 only when every auditable gate is satisfied', () => {
    expect(assessDepartmentReadiness(passedReadiness)).toMatchObject({
      readinessPercent: 100,
      ready: true,
      blockers: [],
    });

    const blocked = assessDepartmentReadiness({
      ...passedReadiness,
      materialUncertainties: ['Migration rollback behavior is unknown'],
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.readinessPercent).toBeLessThan(100);
    expect(blocked.blockers.join(' ')).toContain('Migration rollback behavior');
  });

  it('requires a rationale before a gate may be considered not applicable', () => {
    const invalid = assessDepartmentReadiness({
      ...passedReadiness,
      acceptance: { status: 'not-applicable' },
    });
    expect(invalid.ready).toBe(false);

    const valid = assessDepartmentReadiness({
      ...passedReadiness,
      acceptance: {
        status: 'not-applicable',
        rationale: 'This assignment produces analysis only and changes no executable artifact.',
      },
    });
    expect(valid.ready).toBe(true);
  });
});

describe('Queen Bee state machine', () => {
  function departmentReadyMission() {
    let mission = createQueenBeeMission({
      id: 'mission-routing-upgrade',
      provider: 'codex',
      objective: 'Add a routed orchestration layer.',
    });
    mission = assignDepartment(mission, {
      department: 'engineering',
      objective: 'Implement the orchestration state machine.',
      specialistIds: ['Backend Architect'],
      acceptanceCriteria: [
        {
          id: 'criterion-state-machine',
          description: 'The orchestration state machine is implemented and validated.',
          evidenceRequired: true,
        },
      ],
    });
    mission = recordSpecialistSubmission(mission, 'engineering', {
      specialistId: 'Backend Architect',
      summary: 'State machine implemented.',
      deliverables: ['orchestration state machine'],
      criterionAssessments: [
        {
          criterionId: 'criterion-state-machine',
          status: 'satisfied',
          evidence: ['typecheck', 'tests'],
          rationale: 'The implementation passes static and runtime validation.',
        },
      ],
      evidence: ['typecheck', 'tests'],
      risks: [],
      blockingFindings: [],
      assumptions: [],
    });
    mission = recordDepartmentHeadReview(mission, 'engineering', {
      feedback: 'All required gates passed.',
    });
    return mission;
  }

  it('runs department -> Queen Bee -> LLM Council -> approved main for non-destructive work', () => {
    let mission = departmentReadyMission();
    expect(mission.state).toBe('queen-review');
    expect(mission.departments[0]?.latestHeadReview?.readiness.ready).toBe(true);

    mission = recordQueenBeeReview(mission, {
      accepted: true,
      summary: 'Department work matches the original mission.',
      departmentRevisionRequests: {},
    });
    expect(mission.state).toBe('council-review');

    mission = recordLlmCouncilReview(mission, {
      verdict: 'approve',
      summary: 'Independent Council approved the bounded change.',
      departmentRevisionRequests: {},
      evidenceReference: 'council/session/1',
    });
    expect(mission.state).toBe('integration-assessment');

    mission = recordIntegrationGates(mission, {
      test: { status: 'passed', evidence: ['npm test'] },
      review: { status: 'passed', evidence: ['independent review'] },
    });

    mission = assessQueenBeeIntegration(mission, []);
    expect(mission.state).toBe('awaiting-user-approval');
    expect(mission.integration?.target).toBe('main');
    expect(mission.integration?.userApproved).toBe(false);

    mission = approveQueenBeeIntegration(mission);
    expect(mission.state).toBe('ready-to-integrate');

    mission = markQueenBeeIntegrated(mission);
    expect(mission.state).toBe('integrated');
  });

  it('requires user approval and a review branch for destructive work', () => {
    let mission = departmentReadyMission();
    mission = recordQueenBeeReview(mission, {
      accepted: true,
      summary: 'Ready for Council.',
      departmentRevisionRequests: {},
    });
    mission = recordLlmCouncilReview(mission, {
      verdict: 'approve',
      summary: 'Council approved subject to integration policy.',
      departmentRevisionRequests: {},
    });
    mission = recordIntegrationGates(mission, {
      test: { status: 'passed', evidence: ['npm test'] },
      review: { status: 'passed', evidence: ['independent review'] },
    });
    mission = assessQueenBeeIntegration(mission, [
      { kind: 'tracked-file-delete', detail: 'Remove obsolete migration.' },
    ]);

    expect(mission.state).toBe('awaiting-user-approval');
    expect(mission.integration?.target).toBe('council/review/mission-routing-upgrade');
    expect(mission.integration?.userApproved).toBe(false);

    mission = approveQueenBeeIntegration(mission);
    expect(mission.state).toBe('ready-to-integrate');
  });

  it('cannot assess integration until native Test and Review evidence is recorded', () => {
    let mission = departmentReadyMission();
    mission = recordQueenBeeReview(mission, {
      accepted: true,
      summary: 'Ready for Council.',
      departmentRevisionRequests: {},
    });
    mission = recordLlmCouncilReview(mission, {
      verdict: 'approve',
      summary: 'Council approved the bounded change.',
      departmentRevisionRequests: {},
    });

    expect(() => assessQueenBeeIntegration(mission, [])).toThrow(/gate evidence is missing/i);

    mission = recordIntegrationGates(mission, {
      test: { status: 'passed', evidence: [] },
      review: { status: 'passed', evidence: ['review/1'] },
    });
    expect(() => assessQueenBeeIntegration(mission, [])).toThrow(/passed without evidence/i);
  });

  it('rejects criteria-free assignments, empty submissions, and duplicate submissions', () => {
    let mission = createQueenBeeMission({
      id: 'mission-fail-closed',
      provider: 'codex',
      objective: 'Prove the department evidence boundary.',
    });
    expect(() => assignDepartment(mission, {
      department: 'engineering',
      objective: 'Validate the boundary.',
      specialistIds: ['Reviewer'],
      acceptanceCriteria: [],
    })).toThrow(/acceptance criteria/i);

    mission = assignDepartment(mission, {
      department: 'engineering',
      objective: 'Validate the boundary.',
      specialistIds: ['Reviewer'],
      acceptanceCriteria: [{
        id: 'criterion-proof',
        description: 'Evidence proves the boundary.',
        evidenceRequired: true,
      }],
    });
    expect(() => recordSpecialistSubmission(mission, 'engineering', {
      specialistId: 'Reviewer',
      summary: '',
      deliverables: [],
      criterionAssessments: [],
      evidence: [],
      risks: [],
      blockingFindings: [],
      assumptions: [],
    })).toThrow(/summary/i);

    mission = recordSpecialistSubmission(mission, 'engineering', {
      specialistId: 'Reviewer',
      summary: 'Boundary validated.',
      deliverables: ['validation report'],
      criterionAssessments: [{
        criterionId: 'criterion-proof',
        status: 'satisfied',
        evidence: ['proof'],
        rationale: 'The report contains the proof.',
      }],
      evidence: ['proof'],
      risks: [],
      blockingFindings: [],
      assumptions: [],
    });
    expect(() => recordSpecialistSubmission(mission, 'engineering', {
      specialistId: 'Reviewer',
      summary: 'Second submission.',
      deliverables: ['duplicate report'],
      criterionAssessments: [{
        criterionId: 'criterion-proof',
        status: 'satisfied',
        evidence: ['proof'],
        rationale: 'Duplicate.',
      }],
      evidence: ['proof'],
      risks: [],
      blockingFindings: [],
      assumptions: [],
    })).toThrow(/not accepting/i);
  });

  it('sends Council revisions back to the named department', () => {
    let mission = departmentReadyMission();
    mission = recordQueenBeeReview(mission, {
      accepted: true,
      summary: 'Ready for Council.',
      departmentRevisionRequests: {},
    });
    mission = recordLlmCouncilReview(mission, {
      verdict: 'revise',
      summary: 'Clarify failure recovery.',
      departmentRevisionRequests: {
        engineering: 'Add explicit recovery semantics and evidence.',
      },
    });

    expect(mission.state).toBe('department-work');
    expect(mission.departments[0]?.state).toBe('revision-required');
  });
});

describe('Council evidence packet', () => {
  function readyResult(): QueenBeeDepartmentResult {
    const assignment: DurableDepartmentAssignment = {
      id: 'assignment-engineering',
      missionId: 'mission-packet',
      departmentId: 'engineering',
      objective: 'Produce verified evidence.',
      includedScope: ['orchestration'],
      excludedScope: [],
      dependsOn: [],
      acceptanceCriteria: [{
        id: 'criterion-evidence',
        description: 'Verified evidence is present.',
        evidenceRequired: true,
      }],
      iteration: 1,
      state: 'head-review',
    };
    const product: SpecialistWorkProduct = {
      workId: 'work-engineering',
      assignmentId: assignment.id,
      departmentId: assignment.departmentId,
      specialistRole: 'Reviewer',
      summary: 'Evidence verified.',
      deliverables: ['evidence report'],
      criterionAssessments: [{
        criterionId: 'criterion-evidence',
        status: 'satisfied',
        evidence: ['evidence/report'],
        rationale: 'The report satisfies the criterion.',
      }],
      evidence: ['evidence/report'],
      risks: [],
      blockingFindings: [],
      assumptions: [],
    };
    return {
      assignment,
      product,
      review: {
        assignmentId: assignment.id,
        departmentId: assignment.departmentId,
        iteration: assignment.iteration,
        readiness: evaluateDepartmentReadiness(assignment, product),
      },
    };
  }

  it('recomputes readiness and rejects a forged ready review', () => {
    const valid = readyResult();
    expect(evaluateCouncilReadiness([valid]).ready).toBe(true);
    expect(buildCouncilPacket({
      missionId: 'mission-packet',
      exactQuestion: 'Is this evidence-backed change ready?',
      departmentResults: [valid],
    }).missionId).toBe('mission-packet');

    const forged: QueenBeeDepartmentResult = {
      ...valid,
      product: {
        ...valid.product,
        departmentId: 'design',
        deliverables: [],
        criterionAssessments: [],
        evidence: [],
        blockingFindings: ['Evidence is missing.'],
      },
    };
    expect(evaluateCouncilReadiness([forged]).ready).toBe(false);
    expect(() => buildCouncilPacket({
      missionId: 'mission-packet',
      exactQuestion: 'Can forged readiness pass?',
      departmentResults: [forged],
    })).toThrow(/not ready|mismatched|stale/i);
  });
});

describe('integration impact policy', () => {
  it('fails unknown impact toward review instead of direct main', () => {
    const assessment = assessIntegrationImpact([
      { kind: 'unknown-impact', detail: 'Provider mutation semantics could not be established.' },
    ]);
    expect(assessment.requiresUserApproval).toBe(true);
    expect(assessment.disposition).toBe('review-branch');
  });
});

describe('office tower', () => {
  it('keeps stable department, Council, and Queen Bee floors', () => {
    const floors = buildOfficeTower();
    expect(floors).toHaveLength(21);
    expect(floors.find((floor) => floor.floor === 1)?.label).toBe('Academic');
    expect(floors.find((floor) => floor.floor === 14)?.label).toBe('Security');
    expect(floors.find((floor) => floor.floor === 19)?.id).toBe('llm-council');
    expect(floors.find((floor) => floor.floor === 20)?.id).toBe('queen-bee');
  });
});
