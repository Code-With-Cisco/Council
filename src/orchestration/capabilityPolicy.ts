export const DEPARTMENT_IDS = [
  'academic',
  'design',
  'engineering',
  'finance',
  'game-development',
  'gis',
  'healthcare',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'research',
  'sales',
  'security',
  'spatial-computing',
  'specialized',
  'support',
  'testing',
] as const;

export type DepartmentId = (typeof DEPARTMENT_IDS)[number];
export type DepartmentRisk = 'standard' | 'restricted-security' | 'high-stakes';

export type CapabilityProfileId =
  | 'specialist-local'
  | 'specialist-research'
  | 'restricted-security'
  | 'high-stakes'
  | 'department-head'
  | 'queen-bee'
  | 'native-builder'
  | 'native-test'
  | 'native-review';

export type HostCapability =
  | 'workspace-read'
  | 'workspace-search'
  | 'web-research'
  | 'workspace-write'
  | 'command-execution'
  | 'delegation'
  | 'destructive-operation'
  | 'persistent-memory';

export interface CapabilityProfile {
  readonly id: CapabilityProfileId;
  readonly description: string;
  readonly baseline: readonly HostCapability[];
  readonly missionWriteEligible: boolean;
  readonly commandExecutionEligible: boolean;
  readonly requiresSecurityAuthorization: boolean;
}

export interface CapabilityResolutionInput {
  readonly profileId: CapabilityProfileId;
  readonly missionAccessMode: 'read-only' | 'workspace-write';
  readonly implementationAssigned?: boolean | undefined;
  readonly securityAuthorized?: boolean | undefined;
}

export interface EffectiveCapabilityGrant {
  readonly profileId: CapabilityProfileId;
  readonly granted: readonly HostCapability[];
  readonly denied: readonly HostCapability[];
  readonly permissionMode: 'plan' | 'host-default';
  readonly explanation: readonly string[];
}

const ALL_HOST_CAPABILITIES: readonly HostCapability[] = [
  'workspace-read',
  'workspace-search',
  'web-research',
  'workspace-write',
  'command-execution',
  'delegation',
  'destructive-operation',
  'persistent-memory',
];

/**
 * These profiles are owned by Council. Agent prose, Mission evidence, source
 * files, external references, or another model cannot expand them.
 */
export const CAPABILITY_PROFILES: Readonly<Record<CapabilityProfileId, CapabilityProfile>> = {
  'specialist-local': {
    id: 'specialist-local',
    description: 'Read-only domain analysis inside the assigned Mission evidence boundary.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'specialist-research': {
    id: 'specialist-research',
    description: 'Read-only domain analysis plus host-approved public research.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'restricted-security': {
    id: 'restricted-security',
    description: 'Read-only security analysis. Intrusive activity is never granted by this specialist profile.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: true,
  },
  'high-stakes': {
    id: 'high-stakes',
    description: 'Read-only high-stakes analysis that cannot independently take consequential real-world action.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'department-head': {
    id: 'department-head',
    description: 'Department coordinator with evidence review and delegation authority, never implementation authority.',
    baseline: ['workspace-read', 'workspace-search', 'delegation'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'queen-bee': {
    id: 'queen-bee',
    description: 'User-facing orchestration authority for decomposition, reconciliation, delegation, and final recommendation.',
    baseline: ['workspace-read', 'workspace-search', 'web-research', 'delegation'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'native-builder': {
    id: 'native-builder',
    description: 'Protected Council implementation role constrained by Mission, worktree, story, and user-approval gates.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: true,
    commandExecutionEligible: true,
    requiresSecurityAuthorization: false,
  },
  'native-test': {
    id: 'native-test',
    description: 'Protected independent test authority with command execution but no repository implementation authority.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: false,
    commandExecutionEligible: true,
    requiresSecurityAuthorization: false,
  },
  'native-review': {
    id: 'native-review',
    description: 'Protected independent read-only conformance review authority.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
};

const RESEARCH_DEPARTMENTS = new Set<DepartmentId>([
  'academic',
  'design',
  'finance',
  'gis',
  'healthcare',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'research',
  'sales',
]);

export function defaultSpecialistCapabilityProfile(
  departmentId: DepartmentId,
  risk: DepartmentRisk = 'standard',
): CapabilityProfileId {
  if (risk === 'restricted-security' || departmentId === 'security') {
    return 'restricted-security';
  }
  if (risk === 'high-stakes' || departmentId === 'finance' || departmentId === 'healthcare') {
    return 'high-stakes';
  }
  return RESEARCH_DEPARTMENTS.has(departmentId)
    ? 'specialist-research'
    : 'specialist-local';
}

export function resolveCapabilityGrant(
  input: CapabilityResolutionInput,
): EffectiveCapabilityGrant {
  const profile = CAPABILITY_PROFILES[input.profileId];
  const granted = new Set<HostCapability>(profile.baseline);
  const explanation: string[] = [];

  const securitySatisfied =
    !profile.requiresSecurityAuthorization || input.securityAuthorized === true;
  if (profile.requiresSecurityAuthorization && !securitySatisfied) {
    explanation.push(
      'Security work remains analysis-only until authorization and scope are independently established.',
    );
  }

  const implementationSatisfied =
    profile.id === 'native-builder' &&
    input.missionAccessMode === 'workspace-write' &&
    input.implementationAssigned === true;

  if (profile.missionWriteEligible && implementationSatisfied) {
    granted.add('workspace-write');
    explanation.push(
      'Workspace writes are enabled only for the protected Builder inside its exact Mission worktree.',
    );
  } else if (profile.missionWriteEligible) {
    explanation.push(
      'Workspace writes remain disabled because no qualifying protected Builder assignment is active.',
    );
  }

  if (profile.commandExecutionEligible) {
    if (profile.id === 'native-test') {
      granted.add('command-execution');
      explanation.push(
        'Command execution is limited to the protected Test Engineer gate contract.',
      );
    } else if (implementationSatisfied) {
      granted.add('command-execution');
      explanation.push(
        'Command execution is limited to the protected Builder Mission contract.',
      );
    }
  }

  // These are never inferable from an agent definition or model response.
  granted.delete('destructive-operation');
  granted.delete('persistent-memory');

  const denied = ALL_HOST_CAPABILITIES.filter((capability) => !granted.has(capability));
  return {
    profileId: profile.id,
    granted: ALL_HOST_CAPABILITIES.filter((capability) => granted.has(capability)),
    denied,
    permissionMode: granted.has('workspace-write') ? 'host-default' : 'plan',
    explanation,
  };
}
