import {
  DEPARTMENT_IDS,
  defaultSpecialistCapabilityProfile,
  type CapabilityProfileId,
  type DepartmentId,
} from './capabilityPolicy.js';

export interface DepartmentDefinition {
  readonly id: DepartmentId;
  readonly displayName: string;
  readonly officeFloor: number;
  readonly headAgent: 'department-head';
  readonly specialistAgent: 'department-specialist';
  readonly defaultCapabilityProfile: CapabilityProfileId;
}

const DISPLAY_NAMES: Readonly<Record<DepartmentId, string>> = {
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

/**
 * The building model is Council-owned durable topology, not provider team
 * state. Floors remain stable even when no provider sessions are running.
 */
export const EXECUTIVE_FLOORS = Object.freeze({
  lobby: 0,
  departmentsStart: 1,
  councilChamber: 19,
  queenBee: 20,
});

export const DEPARTMENTS: readonly DepartmentDefinition[] = DEPARTMENT_IDS.map(
  (id, index) => ({
    id,
    displayName: DISPLAY_NAMES[id],
    officeFloor: EXECUTIVE_FLOORS.departmentsStart + index,
    headAgent: 'department-head',
    specialistAgent: 'department-specialist',
    defaultCapabilityProfile: defaultSpecialistCapabilityProfile(id),
  }),
);

const BY_ID = new Map<DepartmentId, DepartmentDefinition>(
  DEPARTMENTS.map((department) => [department.id, department]),
);

export function departmentById(id: DepartmentId): DepartmentDefinition {
  const department = BY_ID.get(id);
  if (department === undefined) {
    throw new Error(`Unknown Council department: ${id}`);
  }
  return department;
}

export function isDepartmentId(value: string): value is DepartmentId {
  return (DEPARTMENT_IDS as readonly string[]).includes(value);
}
