import type {
  HandoffRecord,
  IntegrationCandidateRecord,
  MissionGateRecord,
  MissionLedgerFileV1,
  MissionPhase,
  MissionTaskState,
} from './types.js';

export interface MissionTaskProjection {
  readonly id: string;
  readonly missionId: string;
  readonly title: string;
  readonly state: MissionTaskState;
  readonly assigneeProfileId: string | undefined;
  readonly activeHandoff: HandoffRecord | undefined;
}

export interface MissionSummaryProjection {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly phase: MissionPhase;
  readonly tasks: readonly MissionTaskProjection[];
  readonly latestCandidate: IntegrationCandidateRecord | undefined;
  readonly testGate: MissionGateRecord | undefined;
  readonly reviewGate: MissionGateRecord | undefined;
}

export interface ProfileMissionAssignment {
  readonly profileId: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskState: MissionTaskState;
}

export interface MissionProjection {
  readonly workspaceId: string;
  readonly revision: number;
  readonly missions: readonly MissionSummaryProjection[];
  readonly assignmentsByProfileId: Readonly<
    Record<string, readonly ProfileMissionAssignment[]>
  >;
}

function latestByCreatedAt<T extends { readonly createdAt: string }>(
  values: readonly T[],
): T | undefined {
  return [...values].sort((left, right) => {
    const byTime = right.createdAt.localeCompare(left.createdAt);
    return byTime === 0 ? 0 : byTime;
  })[0];
}

/** Builds a renderer-safe Mission view without mixing it into provider state. */
export function projectMissionLedger(
  ledger: MissionLedgerFileV1,
  workspaceId: string,
): MissionProjection {
  const assignments: Record<string, ProfileMissionAssignment[]> =
    Object.create(null) as Record<string, ProfileMissionAssignment[]>;

  const missions = Object.values(ledger.missions)
    .filter((mission) => mission.workspaceId === workspaceId)
    .sort((left, right) => {
      const byTime = right.updatedAt.localeCompare(left.updatedAt);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    })
    .map((mission): MissionSummaryProjection => {
      const tasks = mission.taskIds
        .map((taskId) => ledger.tasks[taskId])
        .filter((task) => task !== undefined)
        .map((task): MissionTaskProjection => {
          if (task.assigneeProfileId !== undefined) {
            const assignment: ProfileMissionAssignment = {
              profileId: task.assigneeProfileId,
              missionId: mission.id,
              missionTitle: mission.title,
              taskId: task.id,
              taskTitle: task.title,
              taskState: task.state,
            };
            (assignments[task.assigneeProfileId] ??= []).push(assignment);
          }
          return {
            id: task.id,
            missionId: mission.id,
            title: task.title,
            state: task.state,
            assigneeProfileId: task.assigneeProfileId,
            activeHandoff:
              task.activeHandoffId === undefined
                ? undefined
                : ledger.handoffs[task.activeHandoffId],
          };
        });

      const candidates = Object.values(ledger.candidates).filter(
        (candidate) => candidate.missionId === mission.id,
      );
      const latestCandidate = latestByCreatedAt(candidates);
      const candidateGates =
        latestCandidate === undefined
          ? []
          : Object.values(ledger.gates).filter(
              (gate) => gate.candidateId === latestCandidate.id,
            );
      return {
        id: mission.id,
        title: mission.title,
        objective: mission.objective,
        phase: mission.phase,
        tasks,
        latestCandidate,
        testGate: latestByCreatedAt(
          candidateGates.filter((gate) => gate.kind === 'test'),
        ),
        reviewGate: latestByCreatedAt(
          candidateGates.filter((gate) => gate.kind === 'review'),
        ),
      };
    });

  for (const profileAssignments of Object.values(assignments)) {
    profileAssignments.sort((left, right) => {
      const byMission = left.missionTitle.localeCompare(right.missionTitle);
      return byMission === 0
        ? left.taskTitle.localeCompare(right.taskTitle)
        : byMission;
    });
  }

  return {
    workspaceId,
    revision: ledger.revision,
    missions,
    assignmentsByProfileId: assignments,
  };
}
