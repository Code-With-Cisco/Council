import { DEPARTMENTS, EXECUTIVE_FLOORS } from './departments.js';
import type {
  DepartmentAssignment,
  QueenBeeMission,
  QueenBeeMissionState,
} from './queenBee.js';

export type OfficeFloorKind = 'lobby' | 'department' | 'council' | 'queen-bee';
export type OfficeFloorStatus =
  | 'idle'
  | 'working'
  | 'reviewing'
  | 'waiting'
  | 'ready'
  | 'blocked';

export interface OfficeOccupant {
  readonly id: string;
  readonly label: string;
  readonly role: 'queen-bee' | 'department-head' | 'specialist' | 'council';
  readonly status: OfficeFloorStatus;
}

export interface OfficeFloor {
  readonly floor: number;
  readonly kind: OfficeFloorKind;
  readonly id: string;
  readonly label: string;
  readonly status: OfficeFloorStatus;
  readonly occupants: readonly OfficeOccupant[];
}

function departmentStatus(
  assignment: DepartmentAssignment | undefined,
): OfficeFloorStatus {
  if (assignment === undefined) return 'idle';
  switch (assignment.state) {
    case 'assigned':
    case 'specialist-working':
    case 'revision-required':
      return 'working';
    case 'head-review':
      return 'reviewing';
    case 'ready-for-queen':
      return 'ready';
    case 'blocked':
      return 'blocked';
  }
}

function queenStatus(state: QueenBeeMissionState | undefined): OfficeFloorStatus {
  if (state === undefined || state === 'intake' || state === 'integrated') return 'idle';
  if (state === 'blocked') return 'blocked';
  if (state === 'awaiting-user-approval') return 'waiting';
  if (state === 'queen-review' || state === 'integration-assessment') return 'reviewing';
  if (state === 'ready-to-integrate') return 'ready';
  return 'working';
}

function councilStatus(state: QueenBeeMissionState | undefined): OfficeFloorStatus {
  if (state === 'council-review') return 'working';
  if (state === 'integration-assessment' || state === 'ready-to-integrate') return 'ready';
  if (state === 'blocked') return 'blocked';
  return 'idle';
}

export function buildOfficeTower(mission?: QueenBeeMission): readonly OfficeFloor[] {
  const byDepartment = new Map(
    (mission?.departments ?? []).map((assignment) => [assignment.department, assignment]),
  );

  const floors: OfficeFloor[] = [
    {
      floor: EXECUTIVE_FLOORS.lobby,
      kind: 'lobby',
      id: 'lobby',
      label: 'Council Lobby',
      status: mission === undefined ? 'idle' : 'working',
      occupants: [],
    },
  ];

  for (const department of DEPARTMENTS) {
    const assignment = byDepartment.get(department.id);
    const status = departmentStatus(assignment);
    const occupants: OfficeOccupant[] = [
      {
        id: `head:${department.id}`,
        label: `${department.displayName} Department Head`,
        role: 'department-head',
        status,
      },
    ];
    for (const specialistId of assignment?.specialistIds ?? []) {
      occupants.push({
        id: specialistId,
        label: specialistId,
        role: 'specialist',
        status,
      });
    }
    floors.push({
      floor: department.officeFloor,
      kind: 'department',
      id: department.id,
      label: department.displayName,
      status,
      occupants,
    });
  }

  floors.push(
    {
      floor: EXECUTIVE_FLOORS.councilChamber,
      kind: 'council',
      id: 'llm-council',
      label: 'LLM Council Chamber',
      status: councilStatus(mission?.state),
      occupants: [
        {
          id: 'council-lead',
          label: 'Council Lead',
          role: 'council',
          status: councilStatus(mission?.state),
        },
      ],
    },
    {
      floor: EXECUTIVE_FLOORS.queenBee,
      kind: 'queen-bee',
      id: 'queen-bee',
      label: 'Queen Bee Executive Office',
      status: queenStatus(mission?.state),
      occupants: [
        {
          id: 'queen-bee',
          label: 'Queen Bee',
          role: 'queen-bee',
          status: queenStatus(mission?.state),
        },
      ],
    },
  );

  return floors.sort((left, right) => left.floor - right.floor);
}
