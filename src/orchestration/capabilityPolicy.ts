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

export type CapabilityProfileId =
  | 'advisory'
  | 'research'
  | 'product-design'
  | 'engineering'
  | 'content-growth'
  | 'restricted-security'
  | 'high-stakes'
  | 'department-head'
  | 'queen-bee'
  | 'native-builder'
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
  readonly division: AgencyDivision;
  readonly risk: AgencyRisk;
  readonly missionAccessMode: 'read-only' | 'workspace-write';
  readonly implementationAssigned: boolean;
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

const AGENCY_DIVISION_SET = new Set<string>(AGENCY_DIVISIONS);

export const CAPABILITY_PROFILES: Readonly<Record<CapabilityProfileId, CapabilityProfile>> = {
  advisory: {
    id: 'advisory',
    description: 'Read-only specialist analysis inside the assigned evidence boundary.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  research: {
    id: 'research',
    description: 'Read-only workspace analysis plus host-approved public research.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: false,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'product-design': {
    id: 'product-design',
    description: 'Product/design analysis with write access only inside an explicitly assigned Mission worktree.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: true,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  engineering: {
    id: 'engineering',
    description: 'Engineering analysis with implementation and command execution only inside an assigned Mission worktree.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: true,
    commandExecutionEligible: true,
    requiresSecurityAuthorization: false,
  },
  'content-growth': {
    id: 'content-growth',
    description: 'Research/content specialist with artifact writes only when the Mission explicitly assigns implementation.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: true,
    commandExecutionEligible: false,
    requiresSecurityAuthorization: false,
  },
  'restricted-security': {
    id: 'restricted-security',
    description: 'Security specialist. Intrusive execution requires independently established authorization and a scoped Mission worktree.',
    baseline: ['workspace-read', 'workspace-search', 'web-research'],
    missionWriteEligible: true,
    commandExecutionEligible: true,
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
    missionWriteEligible: true,
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
  'native-review': {
    id: 'native-review',
    description: 'Independent read-only test/review authority.',
    baseline: ['workspace-read', 'workspace-search'],
    missionWriteEligible: false,
    commandExecutionEligible: true,
    requiresSecurityAuthorization: false,
  },
};

const DIVISION_DEFAULTS: Readonly<Record<AgencyDivision, CapabilityProfileId>> = {
  academic: 'research',
  design: 'product-design',
  engineering: 'engineering',
  finance: 'high-stakes',
  'game-development': 'engineering',
  gis: 'research',
  healthcare: 'high-stakes',
  marketing: 'content-growth',
  'paid-media': 'content-growth',
  product: 'product-design',
  'project-management': 'product-design',
  research: 'research',
  sales: 'content-growth',
  security: 'restricted-security',
  'spatial-computing': 'engineering',
  specialized: 'advisory',
  support: 'advisory',
  testing: 'native-review',
};

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
  input: CapabilityResolutionInput,
): EffectiveCapabilityGrant {
  const profileId = defaultCapabilityProfileForDivision(input.division, input.risk);
  const profile = CAPABILITY_PROFILES[profileId];
  const granted = new Set<HostCapability>(profile.baseline);
  const explanation: string[] = [];

  const securitySatisfied =
    !profile.requiresSecurityAuthorization || input.securityAuthorized === true;
  const missionWriteSatisfied =
    input.missionAccessMode === 'workspace-write' && input.implementationAssigned;

  if (profile.requiresSecurityAuthorization && !securitySatisfied) {
    explanation.push('Intrusive security capabilities remain disabled until authorization and scope are independently established.');
  }

  if (profile.missionWriteEligible && missionWriteSatisfied && securitySatisfied) {
    granted.add('workspace-write');
    explanation.push('Workspace writes are enabled only for the explicitly assigned Mission worktree.');
  } else if (profile.missionWriteEligible) {
    explanation.push('Workspace writes remain disabled because no write-capable implementation assignment is active.');
  }

  if (
    profile.commandExecutionEligible &&
    missionWriteSatisfied &&
    securitySatisfied
  ) {
    granted.add('command-execution');
    explanation.push('Command execution is scoped to the assigned Mission and host execution policy.');
  } else if (profile.commandExecutionEligible) {
    explanation.push('Command execution remains disabled outside a qualifying Mission assignment.');
  }

  // Imported personas never grant these to themselves. Destructive authority is
  // always a separate user-approval decision, and memory is host-owned.
  granted.delete('destructive-operation');
  granted.delete('persistent-memory');

  const denied = ALL_HOST_CAPABILITIES.filter((capability) => !granted.has(capability));
  return {
    profileId,
    granted: ALL_HOST_CAPABILITIES.filter((capability) => granted.has(capability)),
    denied,
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
