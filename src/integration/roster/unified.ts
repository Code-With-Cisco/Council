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
  RosterMember,
  Session,
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

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Decides whether a session belongs to a specialist.
 *
 * Dispatch sets `--name` to the member's label, so the name match is the
 * intended path. The cwd fallback catches sessions the user started from a
 * terminal in the specialist's home directory, which would otherwise show as
 * unassigned while visibly being that specialist's work.
 */
function matchesMember(session: Session, member: RosterMember): boolean {
  if (session.kind !== 'background') return false;

  if (session.name !== undefined) {
    const name = normalizeName(session.name);
    if (name === normalizeName(member.label) || name === normalizeName(member.key)) return true;
  }

  return session.cwd !== undefined && session.cwd === member.cwd && session.name === undefined;
}

/**
 * Picks one session when several match a specialist.
 *
 * Prefers the most recently started matching background session.
 *
 * Background rows carry no pid in the probed CLI surface, so pid cannot be a
 * meaningful tiebreaker here.
 */
function pickPrimary(candidates: readonly Session[]): Session | undefined {
  if (candidates.length <= 1) return candidates[0];
  return [...candidates].sort(
    (a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0),
  )[0];
}

export interface BuildRosterInput {
  readonly config: RosterConfig;
  readonly rosterSessions: readonly Session[];
  readonly jobs: JobsSnapshot;
  readonly teams: readonly TeamSnapshot[];
  /** Keyed by agent name. Absent when definitions have not been scanned yet. */
  readonly validations?: ReadonlyMap<string, AgentValidation> | undefined;
}

export function buildUnifiedRoster(input: BuildRosterInput): UnifiedRoster {
  const sessions = mergeSessions(input.rosterSessions, input.jobs);
  const claimed = new Set<Session>();

  const squad: SquadSlot[] = input.config.members.map((member) => {
    const candidates = sessions.filter((session) => matchesMember(session, member));
    const session = pickPrimary(candidates);
    if (session !== undefined) claimed.add(session);
    return {
      member,
      session,
      missing: session === undefined,
      validation: input.validations?.get(member.agent),
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
export function membersNeedingStart(roster: UnifiedRoster): RosterMember[] {
  return roster.squad.filter((slot) => slot.session === undefined).map((slot) => slot.member);
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
