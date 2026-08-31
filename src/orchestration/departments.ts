import {
  AGENCY_DIVISIONS,
  defaultCapabilityProfileForDivision,
  type AgencyDivision,
  type CapabilityProfileId,
} from './capabilityPolicy.js';

export interface DepartmentDefinition {
  readonly id: AgencyDivision;
  readonly displayName: string;
  readonly officeFloor: number;
  readonly headAgent: 'department-head';
  readonly specialistPathPrefix: string;
  readonly defaultCapabilityProfile: CapabilityProfileId;
}

const DISPLAY_NAMES: Readonly<Record<AgencyDivision, string>> = {
  academic: 'Academic',
  design: 'Design',
  engineering: 'Engineering',
  finance: 'Finance',
  'game-development': 'Game Development',
  gis: 'GIS & Spatial Data',
  healthcare: 'Healthcare',
  marketing: 'Marketing',
  'paid-media': 'Paid Media',
  product: 'Product',
  'project-management': 'Project Management',
  research: 'Research',
  sales: 'Sales',
  security: 'Security',
  'spatial-computing': 'Spatial Computing',
  specialized: 'Specialized Services',
  support: 'Support',
  testing: 'Testing & Quality',
};

export const EXECUTIVE_FLOORS = Object.freeze({
  lobby: 0,
  departmentsStart: 1,
  councilChamber: 19,
  queenBee: 20,
});

export const DEPARTMENTS: readonly DepartmentDefinition[] = AGENCY_DIVISIONS.map(
  (id, index) => ({
    id,
    displayName: DISPLAY_NAMES[id],
    officeFloor: EXECUTIVE_FLOORS.departmentsStart + index,
    headAgent: 'department-head',
    specialistPathPrefix: `.claude/agents/agency-agents/${id}/`,
    defaultCapabilityProfile: defaultCapabilityProfileForDivision(id),
  }),
);

const BY_ID = new Map<AgencyDivision, DepartmentDefinition>(
  DEPARTMENTS.map((department) => [department.id, department]),
);

export function departmentById(
  id: AgencyDivision,
): DepartmentDefinition {
  const department = BY_ID.get(id);
  if (department === undefined) {
    throw new Error(`Unknown Council department: ${id}`);
  }
  return department;
}

export function isAgencyDivision(value: string): value is AgencyDivision {
  return (AGENCY_DIVISIONS as readonly string[]).includes(value);
}
