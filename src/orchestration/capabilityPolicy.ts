export const AGENCY_DIVISIONS = [
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

export type AgencyDivision = (typeof AGENCY_DIVISIONS)[number];
export type AgencyRisk = 'standard' | 'restricted-security' | 'high-stakes';
export const DEPARTMENT_IDS = AGENCY_DIVISIONS;
export type DepartmentId = AgencyDivision;
export type DepartmentRisk = AgencyRisk;

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

export interface AgencyCapabilityResolutionInput {
  readonly division: AgencyDivision;
  readonly risk: AgencyRisk;
  readonly missionAccessMode: 'read-only' | 'workspace-write';
  readonly implementationAssigned: boolean;
  readonly securityAuthorized?: boolean | undefined;
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

export interface ProviderToolPolicy {
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
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

const AGENCY_DIVISION_SET = new Set<string>(AGENCY_DIVISIONS);

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
    description: 'Security specialist. Intrusive execution requires independently established authorization and a scoped Mission worktree.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: true,
  },
  'high-stakes': {
    id: 'high-stakes',
    description: 'High-stakes domain specialist limited to research and analysis; it does not independently take consequential real-world actions.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'department-head': {
    id: 'department-head',
    description: 'Council-owned department coordinator with read/search and delegation authority, but no implementation authority.',
    baseline: ['workspace-read', 'workspace-search', 'delegation'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'queen-bee': {
    id: 'queen-bee',
    description: 'User-facing orchestration authority for decomposition, reconciliation, delegation, and branch staging.',
    baseline: ['workspace-read', 'workspace-search', 'web-research', 'delegation'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'native-builder': {
    id: 'native-builder',
    description: 'Council-owned implementation role constrained by Mission/worktree/story gates.',
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
    description: 'Independent read-only test/review authority.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
};

const DIVISION_DEFAULTS: Readonly<Record<AgencyDivision, CapabilityProfileId>> = {
  academic: 'specialist-research',
  design: 'specialist-research',
  engineering: 'specialist-local',
  finance: 'high-stakes',
  'game-development': 'specialist-local',
  gis: 'specialist-research',
  healthcare: 'high-stakes',
  marketing: 'specialist-research',
  'paid-media': 'specialist-research',
  product: 'specialist-research',
  'project-management': 'specialist-research',
  research: 'specialist-research',
  sales: 'specialist-research',
  security: 'restricted-security',
  'spatial-computing': 'specialist-local',
  specialized: 'specialist-local',
  support: 'specialist-local',
  testing: 'specialist-local',
};

export function defaultSpecialistCapabilityProfile(
  departmentId: DepartmentId,
  risk: DepartmentRisk = 'standard',
): CapabilityProfileId {
  return defaultCapabilityProfileForDivision(departmentId, risk);
}

export function agencyDivisionFromDefinitionPath(
  definitionPath: string | undefined,
): AgencyDivision | undefined {
  if (definitionPath === undefined) return undefined;
  const normalized = definitionPath.replace(/\\/g, '/').toLowerCase();
  const match = /\/agency-agents\/([^/]+)\//.exec(normalized);
  const candidate = match?.[1];
  return candidate !== undefined && AGENCY_DIVISION_SET.has(candidate)
    ? (candidate as AgencyDivision)
    : undefined;
}

export function agencyRiskFromDefinitionPath(
  definitionPath: string | undefined,
  division = agencyDivisionFromDefinitionPath(definitionPath),
): AgencyRisk | undefined {
  if (division === undefined) return undefined;
  if (division === 'security') return 'restricted-security';
  if (division === 'healthcare' || division === 'finance') return 'high-stakes';
  if (/legal|compliance|privacy/i.test(definitionPath ?? '')) return 'high-stakes';
  return 'standard';
}

export function defaultCapabilityProfileForDivision(
  division: AgencyDivision,
  risk: AgencyRisk = 'standard',
): CapabilityProfileId {
  if (risk === 'restricted-security') return 'restricted-security';
  if (risk === 'high-stakes') return 'high-stakes';
  return DIVISION_DEFAULTS[division];
}

export function resolveAgencyCapabilityGrant(
  input: AgencyCapabilityResolutionInput,
): EffectiveCapabilityGrant {
  const profileId = defaultCapabilityProfileForDivision(input.division, input.risk);
  return resolveCapabilityGrant({
    profileId,
    missionAccessMode: input.missionAccessMode,
    implementationAssigned: input.implementationAssigned,
    securityAuthorized: input.securityAuthorized,
  });
}

/** Resolves protected Council roles separately from imported specialist routing. */
export function resolveCapabilityGrant(
  input: CapabilityResolutionInput,
): EffectiveCapabilityGrant {
  const profile = CAPABILITY_PROFILES[input.profileId];
  const granted = new Set<HostCapability>(profile.baseline);
  const explanation: string[] = [];
  const protectedBuilderAssignment =
    profile.id === 'native-builder' &&
    input.missionAccessMode === 'workspace-write' &&
    input.implementationAssigned === true;

  if (profile.missionWriteEligible && protectedBuilderAssignment) {
    granted.add('workspace-write');
    explanation.push('Workspace writes are enabled only for protected Builder inside its exact Mission worktree.');
  }
  if (profile.id === 'native-test') {
    granted.add('command-execution');
    explanation.push('Command execution is limited to the protected Test Engineer gate contract.');
  } else if (profile.commandExecutionEligible && protectedBuilderAssignment) {
    granted.add('command-execution');
    explanation.push('Command execution is limited to the protected Builder Mission contract.');
  }
  granted.delete('destructive-operation');
  granted.delete('persistent-memory');

  return {
    profileId: profile.id,
    granted: ALL_HOST_CAPABILITIES.filter((capability) => granted.has(capability)),
    denied: ALL_HOST_CAPABILITIES.filter((capability) => !granted.has(capability)),
    permissionMode: granted.has('workspace-write') ? 'host-default' : 'plan',
    explanation,
  };
}

export function resolveAgencyCapabilityForDefinition(request: {
  readonly definitionPath: string | undefined;
  readonly missionAccessMode: 'read-only' | 'workspace-write';
  readonly implementationAssigned: boolean;
  readonly securityAuthorized?: boolean | undefined;
}): EffectiveCapabilityGrant | undefined {
  const division = agencyDivisionFromDefinitionPath(request.definitionPath);
  const risk = agencyRiskFromDefinitionPath(request.definitionPath, division);
  if (division === undefined || risk === undefined) return undefined;
  return resolveAgencyCapabilityGrant({
    division,
    risk,
    missionAccessMode: request.missionAccessMode,
    implementationAssigned: request.implementationAssigned,
    securityAuthorized: request.securityAuthorized,
  });
}

const CLAUDE_TOOLS_BY_CAPABILITY: Readonly<
  Partial<Record<HostCapability, readonly string[]>>
> = {
  'workspace-read': ['Read'],
  'workspace-search': ['Glob', 'Grep'],
  'web-research': ['WebSearch', 'WebFetch'],
  'workspace-write': ['Write', 'Edit', 'NotebookEdit'],
  'command-execution': ['Bash', 'PowerShell'],
  delegation: ['Task', 'SendMessage'],
};

/**
 * Translates the provider-neutral host grant into the narrow Claude CLI tool
 * selectors enforced at process launch. Denials are emitted explicitly so a
 * broader agent definition or user setting cannot silently restore authority.
 */
export function providerToolPolicyForGrant(
  grant: EffectiveCapabilityGrant,
): ProviderToolPolicy {
  const allowedTools = new Set<string>();
  const disallowedTools = new Set<string>();

  for (const capability of grant.granted) {
    for (const tool of CLAUDE_TOOLS_BY_CAPABILITY[capability] ?? []) {
      allowedTools.add(tool);
    }
  }
  for (const capability of grant.denied) {
    for (const tool of CLAUDE_TOOLS_BY_CAPABILITY[capability] ?? []) {
      disallowedTools.add(tool);
    }
  }
  for (const tool of disallowedTools) allowedTools.delete(tool);

  return {
    allowedTools: [...allowedTools],
    disallowedTools: [...disallowedTools],
  };
}
