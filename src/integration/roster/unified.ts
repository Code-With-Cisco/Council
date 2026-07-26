/**
 * The unified roster.
 *
 * Three sources have to become one list because none of them is complete:
 *
 *  - `claude agents --json --all` knows live state but omits teammates entirely
 *    and carries no `detail`.
 *  - `<config>/jobs/<id>/state.json` carries `detail`, `intent` and timestamps,
 *    and still describes sessions the roster has dropped.
 *  - `<config>/teams/` is the only place teammates appear at all.
 *
 * Precedence is roster > job file, because the roster reflects the supervisor's
 * live view while a job file can lag a session that was just stopped.
 */

import type {
  AgentValidation,
  ParseProblem,
  RosterConfig,
  Session,
  SessionBindingRef,
  SquadSlot,
  TeamSnapshot,
} from '../types.js';
import type { JobsSnapshot } from '../fs/jobs.js';
import { enrichSession, sessionsFromJobsOnly } from '../fs/jobs.js';

export interface UnifiedRoster {
  /** Every background session known from any source, plus interactive rows. */
  readonly sessions: readonly Session[];
  /** One slot per configured specialist, in config order. This is the squad screen. */
  readonly squad: readonly SquadSlot[];
  /** Sessions not claimed by any specialist — ad-hoc work started elsewhere. */
  readonly unassigned: readonly Session[];
  readonly teams: readonly TeamSnapshot[];
  readonly problems: readonly ParseProblem[];
}

/** Merges roster rows with job-file state and pin flags. */
export function mergeSessions(rosterSessions: readonly Session[], jobs: JobsSnapshot): Session[] {
  const known = new Set<string>();
  const merged = rosterSessions.map((session) => {
    if (session.id === undefined) return session;
    known.add(session.id);
    return enrichSession(session, jobs.states.get(session.id), jobs.pinned.has(session.id));
  });

  merged.push(...sessionsFromJobsOnly(jobs, known));
  return merged;
}

/**
 * Resolves only the exact provider identity persisted by the binding store.
 *
 * Job-file-only rows are historical evidence, not proof that the provider
 * roster can address a session. Lifecycle commands all re-read that roster,
 * so accepting a job-only row here would advertise actions that must fail and
 * would hide the safe Clear-binding recovery path.
 *
 * If a full id is available it is authoritative. We deliberately do not fall
 * back to the short id when a different full id is visible: short-id
 * coincidence must never transfer ownership.
 */
function findBoundSession(
  sessions: readonly Session[],
  binding: SessionBindingRef,
): Session | undefined {
  if (binding.fullSessionId !== undefined) {
    const matches = sessions.filter(
      (session) =>
        session.kind === 'background' &&
        session.source !== 'jobfile' &&
        session.sessionId === binding.fullSessionId &&
        (session.id === undefined || session.id === binding.shortSessionId),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  const matches = sessions.filter(
    (session) =>
      session.kind === 'background' &&
      session.source !== 'jobfile' &&
      session.id === binding.shortSessionId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export interface BuildRosterInput {
  readonly config: RosterConfig;
  readonly rosterSessions: readonly Session[];
  readonly jobs: JobsSnapshot;
  readonly teams: readonly TeamSnapshot[];
  /** Keyed by opaque profile id. Absent when definitions have not been scanned yet. */
  readonly validations?: ReadonlyMap<string, AgentValidation> | undefined;
  /** Exact durable ownership, keyed by opaque profile id. */
  readonly bindings?: ReadonlyMap<string, SessionBindingRef> | undefined;
  /** False when the provider roster could not be read at all. */
  readonly rosterAvailable?: boolean | undefined;
}

export function buildUnifiedRoster(input: BuildRosterInput): UnifiedRoster {
  const sessions = mergeSessions(input.rosterSessions, input.jobs);
  const claimed = new Set<Session>();

  const squad: SquadSlot[] = input.config.members.map((member) => {
    const candidateBinding = input.bindings?.get(member.key);
    const binding =
      candidateBinding !== undefined &&
      candidateBinding.profileId === member.key &&
      (member.workspaceId === undefined ||
        candidateBinding.workspaceId === member.workspaceId)
        ? candidateBinding
        : undefined;
    const exact = binding === undefined ? undefined : findBoundSession(sessions, binding);
    const session = exact !== undefined && !claimed.has(exact) ? exact : undefined;
    if (session !== undefined) claimed.add(session);
    const rosterAvailable = input.rosterAvailable !== false;
    const staleBinding =
      rosterAvailable && binding !== undefined && session === undefined;
    const bindingState =
      binding === undefined
        ? 'none'
        : !rosterAvailable
          ? 'unavailable'
        : staleBinding
          ? 'stale'
          : session?.state === 'failed'
            ? 'failed'
            : session?.state === 'done' || session?.state === 'stopped'
              ? 'terminal'
              : 'active';
    return {
      member,
      session,
      missing: session === undefined,
      validation: input.validations?.get(member.key),
      binding,
      bindingState,
      staleBinding,
    };
  });

  const unassigned = sessions.filter(
    (session) => session.kind === 'background' && !claimed.has(session),
  );

  const problems: ParseProblem[] = [...input.jobs.problems];
  for (const team of input.teams) problems.push(...team.parseErrors);

  return { sessions, squad, unassigned, teams: input.teams, problems };
}

/**
 * Specialists the boot sequence needs to start.
 *
 * A `failed` session is deliberately excluded: after a machine restart every
 * session reports `failed`, and that case is a user-visible "wake the squad"
 * action, never an automatic respawn.
 */
export function membersNeedingStart(roster: UnifiedRoster): RosterConfig['members'][number][] {
  return roster.squad
    .filter((slot) => slot.bindingState === 'none')
    .map((slot) => slot.member);
}

/**
 * Sessions that a machine restart left behind.
 *
 * The docs are explicit that sessions survive sleep but stop on shutdown and
 * reappear as `failed`. Surfaced as one deliberate action rather than silently
 * respawned.
 */
export function membersNeedingWake(roster: UnifiedRoster): SquadSlot[] {
  return roster.squad.filter((slot) => slot.session?.state === 'failed');
}

/** Sessions parked on a decision. This is the app's single attention channel. */
export function sessionsNeedingInput(roster: UnifiedRoster): Session[] {
  return roster.sessions.filter(
    (session) => session.state === 'blocked' || session.waitingFor !== undefined,
  );
}
