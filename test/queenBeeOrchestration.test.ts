import { describe, expect, it } from 'vitest';

import { resolveAgencyCapabilityGrant } from '../src/orchestration/capabilityPolicy.js';
import { assessIntegrationImpact } from '../src/orchestration/destructivePolicy.js';
import { buildOfficeTower } from '../src/orchestration/officeState.js';
import {
  approveQueenBeeIntegration,
  assessQueenBeeIntegration,
  assignDepartment,
  createQueenBeeMission,
  markQueenBeeIntegrated,
  recordDepartmentHeadReview,
  recordLlmCouncilReview,
  recordQueenBeeReview,
  recordSpecialistSubmission,
} from '../src/orchestration/queenBee.js';
import { assessDepartmentReadiness } from '../src/orchestration/readiness.js';

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
  it('grants engineering writes only for an explicit write implementation assignment', () => {
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
    expect(implementation.granted).toContain('workspace-write');
    expect(implementation.granted).toContain('command-execution');
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
    expect(authorized.granted).toContain('workspace-write');
    expect(authorized.granted).toContain('command-execution');
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
    });
    mission = recordSpecialistSubmission(mission, 'engineering', {
      specialistId: 'Backend Architect',
      summary: 'State machine implemented.',
      evidence: ['typecheck', 'tests'],
      risks: [],
    });
    mission = recordDepartmentHeadReview(mission, 'engineering', {
      readiness: passedReadiness,
      feedback: 'All required gates passed.',
    });
    return mission;
  }

  it('runs department -> Queen Bee -> LLM Council -> direct main for non-destructive work', () => {
    let mission = departmentReadyMission();
    expect(mission.state).toBe('queen-review');
    expect(mission.departments[0]?.latestHeadReview?.readiness.readinessPercent).toBe(100);

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

    mission = assessQueenBeeIntegration(mission, []);
    expect(mission.state).toBe('ready-to-integrate');
    expect(mission.integration?.target).toBe('main');
    expect(mission.integration?.userApproved).toBe(true);

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
    mission = assessQueenBeeIntegration(mission, [
      { kind: 'tracked-file-delete', detail: 'Remove obsolete migration.' },
    ]);

    expect(mission.state).toBe('awaiting-user-approval');
    expect(mission.integration?.target).toBe('council/review/mission-routing-upgrade');
    expect(mission.integration?.userApproved).toBe(false);

    mission = approveQueenBeeIntegration(mission);
    expect(mission.state).toBe('ready-to-integrate');
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
