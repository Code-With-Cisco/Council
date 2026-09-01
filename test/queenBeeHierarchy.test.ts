import { describe, expect, it } from 'vitest';
import {
  assessDepartmentReadiness,
  assessPromotionRisk,
  createDepartmentDispatch,
  reconcileForQueenBee,
  type ReadinessCriterion,
} from '../src/orchestration/hierarchy.js';
import {
  resolveAgencyCapabilityGrant,
} from '../src/orchestration/capabilityPolicy.js';
import { DEPARTMENTS } from '../src/orchestration/departments.js';

const READY: readonly ReadinessCriterion[] = [
  'scope-complete',
  'deliverables-present',
  'evidence-attached',
  'acceptance-satisfied',
  'validation-passed',
  'risks-disclosed',
  'ownership-compliant',
].map((id) => ({ id, satisfied: true, evidence: [`${id}:ok`] })) as readonly ReadinessCriterion[];

describe('Queen Bee hierarchy policy', () => {
  it('requires the full deterministic readiness contract before a department can return work', () => {
    const assessment = assessDepartmentReadiness({
      department: 'engineering',
      specialistProfileIds: ['frontend', 'backend'],
      criteria: READY,
      unresolvedBlockers: [],
      unresolvedQuestions: [],
    });

    expect(assessment.readinessPercent).toBe(100);
    expect(assessment.readyForQueenBee).toBe(true);
    expect(assessment.departmentHead).toBe('department-head:engineering');
  });

  it('does not treat a numerical 100% score as ready while a material question remains', () => {
    const assessment = assessDepartmentReadiness({
      department: 'product',
      specialistProfileIds: ['product-manager'],
      criteria: READY,
      unresolvedBlockers: [],
      unresolvedQuestions: ['Which migration path is approved?'],
    });

    expect(assessment.readinessPercent).toBeLessThan(100);
    expect(assessment.readyForQueenBee).toBe(false);
  });

  it('keeps an incomplete department in the revision loop', () => {
    const criteria = READY.map((criterion) =>
      criterion.id === 'validation-passed'
        ? { ...criterion, satisfied: false, evidence: [] }
        : criterion,
    );
    const assessment = assessDepartmentReadiness({
      department: 'testing',
      specialistProfileIds: ['test-engineer'],
      criteria,
      unresolvedBlockers: ['Regression suite failed.'],
      unresolvedQuestions: [],
    });

    expect(assessment.readyForQueenBee).toBe(false);
    expect(assessment.missingCriteria).toContain('validation-passed');
    expect(assessment.readinessPercent).toBeLessThan(100);
  });

  it('assigns one stable office floor to every imported Agency division', () => {
    expect(DEPARTMENTS).toHaveLength(18);
    expect(new Set(DEPARTMENTS.map((department) => department.officeFloor)).size).toBe(18);
    expect(DEPARTMENTS.map((department) => department.officeFloor).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
    expect(createDepartmentDispatch({
      department: 'research',
      assignment: 'Compare architecture options.',
    }).floor).toBeGreaterThan(0);
  });

  it('routes destructive or high-impact work to a user-reviewed branch', () => {
    expect(assessPromotionRisk({})).toEqual({
      route: 'review-branch',
      requiresUserApproval: true,
      reasons: ['unknown-impact'],
    });
    expect(assessPromotionRisk({ impactKnown: true })).toEqual({
      route: 'direct-main',
      requiresUserApproval: false,
      reasons: [],
    });
    expect(assessPromotionRisk({ rewritesHistory: true })).toEqual({
      route: 'review-branch',
      requiresUserApproval: true,
      reasons: ['history-rewrite'],
    });
    expect(assessPromotionRisk({ changesPermissionsOrAuth: true, highImpact: true }).route).toBe(
      'review-branch',
    );
  });

  it('requires all departments and independent gates before promotion', () => {
    const ready = assessDepartmentReadiness({
      department: 'engineering',
      specialistProfileIds: ['frontend'],
      criteria: READY,
      unresolvedBlockers: [],
      unresolvedQuestions: [],
    });
    expect(reconcileForQueenBee({
      departmentAssessments: [ready],
      councilPassed: true,
      testGatePassed: true,
      reviewGatePassed: true,
      councilFindings: [],
    }).readyForPromotion).toBe(true);

    expect(reconcileForQueenBee({
      departmentAssessments: [ready],
      councilPassed: true,
      testGatePassed: false,
      reviewGatePassed: true,
      councilFindings: [],
    }).readyForPromotion).toBe(false);
  });
});

describe('host-owned Agency capability policy', () => {
  it('keeps engineering read-only until an implementation worktree is assigned', () => {
    const readOnly = resolveAgencyCapabilityGrant({
      division: 'engineering',
      risk: 'standard',
      missionAccessMode: 'read-only',
      implementationAssigned: false,
    });
    expect(readOnly.granted).not.toContain('workspace-write');
    expect(readOnly.granted).not.toContain('command-execution');

    const implementation = resolveAgencyCapabilityGrant({
      division: 'engineering',
      risk: 'standard',
      missionAccessMode: 'workspace-write',
      implementationAssigned: true,
    });
    expect(implementation.granted).toContain('workspace-write');
    expect(implementation.granted).toContain('command-execution');
  });

  it('does not enable intrusive security capabilities without independent authorization', () => {
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

  it('keeps high-stakes specialists non-writing even inside a nominal write mission', () => {
    const grant = resolveAgencyCapabilityGrant({
      division: 'healthcare',
      risk: 'high-stakes',
      missionAccessMode: 'workspace-write',
      implementationAssigned: true,
    });
    expect(grant.granted).not.toContain('workspace-write');
    expect(grant.granted).not.toContain('command-execution');
  });
});
