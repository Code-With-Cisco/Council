/**
 * Reading per-session state from `<config>/jobs/`.
 *
 * The supervisor rewrites `state.json` as work progresses, independently of any
 * CLI invocation, so this is the low-latency complement to roster polling: it
 * carries `detail` (a human-readable one-liner), `intent` (the dispatch prompt)
 * and `updatedAt`, none of which appear in `agents --json`.
 *
 * Undocumented and therefore read defensively — a shape change degrades the
 * enrichment rather than breaking the roster.
 */

import { readFile, readdir } from 'node:fs/promises';
import type { ClaudePaths } from '../paths.js';
import type { JobStateFile, ParseProblem, Session, SessionState } from '../types.js';
import { SESSION_STATES } from '../types.js';
import { deriveCold } from '../parse/roster.js';

async function readJsonFile<T>(file: string): Promise<{ value: T | undefined; problem: ParseProblem | undefined }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A missing file is normal: the directory is created on first background
    // dispatch and individual jobs disappear on `claude rm`.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { value: undefined, problem: undefined };
    return {
      value: undefined,
      problem: { path: file, message: err instanceof Error ? err.message : String(err) },
    };
  }

  try {
    return { value: JSON.parse(text) as T, problem: undefined };
  } catch (err) {
    // Torn read: the supervisor rewrites this file without an atomic rename, so
    // a poll can land mid-write. Treat as transient — the next tick re-reads.
    return {
      value: undefined,
      problem: { path: file, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export interface JobsSnapshot {
  /** Keyed by short session id, matching the roster's `id`. */
  readonly states: ReadonlyMap<string, JobStateFile>;
  readonly pinned: ReadonlySet<string>;
  readonly problems: readonly ParseProblem[];
}

/** Reads `<config>/jobs/pins.json`, a plain array of pinned short ids. */
export async function readPins(paths: ClaudePaths): Promise<{ pinned: Set<string>; problem: ParseProblem | undefined }> {
  const { value, problem } = await readJsonFile<unknown>(paths.pinsFile());
  const pinned = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') pinned.add(entry);
      // Tolerate an object form should the file gain structure later.
      else if (typeof entry === 'object' && entry !== null && 'id' in entry) {
        const id = (entry as { id?: unknown }).id;
        if (typeof id === 'string') pinned.add(id);
      }
    }
  }
  return { pinned, problem };
}

export async function readJobState(paths: ClaudePaths, id: string): Promise<JobStateFile | undefined> {
  const { value } = await readJsonFile<JobStateFile>(paths.jobStateFile(id));
  return value;
}

/** Reads every job directory plus pin state in one pass. */
export async function readJobsSnapshot(paths: ClaudePaths): Promise<JobsSnapshot> {
  const problems: ParseProblem[] = [];
  const states = new Map<string, JobStateFile>();

  let entries: string[] = [];
  try {
    entries = await readdir(paths.jobsDir());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      problems.push({ path: paths.jobsDir(), message: err instanceof Error ? err.message : String(err) });
    }
  }

  const jobIds = entries.filter((entry) => !entry.endsWith('.json'));
  await Promise.all(
    jobIds.map(async (id) => {
      const { value, problem } = await readJsonFile<JobStateFile>(paths.jobStateFile(id));
      if (problem !== undefined) problems.push(problem);
      if (value !== undefined) states.set(id, value);
    }),
  );

  const { pinned, problem } = await readPins(paths);
  if (problem !== undefined) problems.push(problem);

  return { states, pinned, problems };
}

function asSessionState(value: unknown): SessionState | undefined {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value)
    ? (value as SessionState)
    : undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Merges job-file detail onto a roster row.
 *
 * The roster stays authoritative for `state`: it reflects the supervisor's live
 * view, whereas `state.json` can lag behind a session that has just been
 * stopped. The job file only fills gaps and supplies fields the roster lacks.
 */
export function enrichSession(session: Session, job: JobStateFile | undefined, pinned: boolean): Session {
  if (job === undefined) {
    if (pinned === session.pinned) return session;
    // Pinned sessions are exempt from the ~1h idle stop, so never dormant.
    return { ...session, pinned, cold: pinned ? false : session.cold };
  }

  const state = session.state ?? asSessionState(job.state);

  return {
    ...session,
    state,
    detail: job.detail ?? session.detail,
    intent: job.intent ?? session.intent,
    name: session.name ?? job.name,
    cwd: session.cwd ?? job.cwd,
    sessionId: session.sessionId ?? job.sessionId,
    updatedAt: parseDate(job.updatedAt) ?? session.updatedAt,
    startedAt: session.startedAt ?? parseDate(job.createdAt),
    pinned,
    // Recomputed rather than carried over: the roster may have had no state at
    // all, and the job file has just supplied one.
    cold: pinned ? false : deriveCold(session.kind, state, session.pid),
    source: 'roster+jobfile',
  };
}

/**
 * Builds sessions for jobs that have a state file but no roster row.
 *
 * `claude agents --json` without `--all` omits completed sessions, and a
 * session whose process is gone can drop out entirely. Surfacing these keeps a
 * specialist visible as dormant rather than having its card disappear.
 */
export function sessionsFromJobsOnly(
  snapshot: JobsSnapshot,
  known: ReadonlySet<string>,
): Session[] {
  const extra: Session[] = [];
  for (const [id, job] of snapshot.states) {
    if (known.has(id)) continue;
    const state = asSessionState(job.state);
    const pinned = snapshot.pinned.has(id);
    extra.push({
      id,
      sessionId: job.sessionId,
      name: job.name,
      kind: 'background',
      state,
      waitingFor: undefined,
      status: undefined,
      detail: job.detail,
      cwd: job.cwd,
      startedAt: parseDate(job.createdAt),
      updatedAt: parseDate(job.updatedAt),
      pid: undefined,
      cold: pinned ? false : deriveCold('background', state, undefined),
      pinned,
      intent: job.intent,
      source: 'jobfile',
    });
  }
  return extra;
}
