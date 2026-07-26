/**
 * Parsing `claude agents --json [--all]`.
 *
 * Recorded shape from v2.1.220 (test/fixtures/roster-mixed.json). Interactive
 * rows are the sharp edge: they carry no `id` and no `state`, so anything that
 * assumes a roster row is a controllable background job breaks the moment the
 * user has a terminal open.
 */

import type { RawRosterEntry, Session, SessionKind, SessionState } from '../types.js';
import { SESSION_STATES } from '../types.js';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Unrecognised states are dropped rather than passed through: the UI switches on this. */
function asSessionState(value: unknown): SessionState | undefined {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value)
    ? (value as SessionState)
    : undefined;
}

/** Anything not explicitly `background` is treated as interactive — the safer default, since interactive rows are never acted on. */
function asKind(value: unknown): SessionKind {
  return value === 'background' ? 'background' : 'interactive';
}

/**
 * Decides whether a session is dormant.
 *
 * `pid` is NOT a reliable signal. The docs describe it as present "while the
 * process is alive", but verified against v2.1.220 a background session in
 * state `working` reports no `pid` at all — the supervisor hosts the process, so
 * the roster has no CLI pid to report. Treating a missing pid as dormant made an
 * actively-working agent render with the cold/dashed styling, which is the most
 * misleading thing the squad screen could show.
 *
 * State is the real signal, and the fallback is deliberately "not cold": an
 * unknown session looking normal is better than a working one looking asleep.
 */
export function deriveCold(
  kind: SessionKind,
  state: SessionState | undefined,
  pid: number | undefined,
): boolean {
  if (kind !== 'background') return false;
  if (pid !== undefined) return false;
  switch (state) {
    case 'working':
    case 'blocked':
      // Definitionally hosted: it is running tools or waiting on a person.
      return false;
    case 'done':
    case 'failed':
    case 'stopped':
      // Terminal: no live process. Attaching, peeking or replying restarts it
      // from the saved transcript.
      return true;
    case undefined:
      return false;
  }
}

/** Normalises one raw roster row. Tolerates unknown/missing fields by design. */
export function normalizeRosterEntry(raw: RawRosterEntry): Session {
  const kind = asKind(raw.kind);
  const state = asSessionState(raw.state);
  const startedAtMs = asNumber(raw.startedAt);
  const pid = asNumber(raw.pid);

  return {
    id: asString(raw.id),
    sessionId: asString(raw.sessionId),
    name: asString(raw.name),
    kind,
    state,
    waitingFor: asString(raw.waitingFor),
    status: asString(raw.status),
    detail: undefined,
    cwd: asString(raw.cwd),
    startedAt: startedAtMs === undefined ? undefined : new Date(startedAtMs),
    updatedAt: undefined,
    pid,
    cold: deriveCold(kind, state, pid),
    pinned: false,
    intent: undefined,
    source: 'roster',
  };
}

/**
 * Parses the full array. Non-array input yields an empty roster rather than
 * throwing — a malformed read reconciles away on the next poll.
 */
export function parseRoster(value: unknown): Session[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is RawRosterEntry => typeof entry === 'object' && entry !== null)
    .map(normalizeRosterEntry);
}

/** Background rows only — the ones with an `id` that attach/logs/stop accept. */
export function backgroundSessions(sessions: readonly Session[]): Session[] {
  return sessions.filter((s) => s.kind === 'background' && s.id !== undefined);
}

/**
 * Short id for a session id.
 *
 * Verified invariant: the daemon's short id is the first 8 characters of the
 * session UUID (`e1f523d7` for `e1f523d7-e83b-46b8-9eca-538f4e74e609`), and
 * `state.json` records the same value as `daemonShort`. Used to correlate hook
 * payloads — which carry `session_id` — with roster rows keyed by short id.
 */
export function shortIdFor(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Parses `backgrounded · <id> · <name>` from a dispatch.
 *
 * Real output includes preamble and follow-on hint lines:
 *
 *   Starting background service…
 *   backgrounded · e1f523d7 · probe-job
 *     claude agents             list sessions
 */
export function parseStartedSession(raw: string): { id: string; name: string | undefined } | null {
  const match = /^\s*backgrounded\s*·\s*([0-9a-f]{6,})\s*(?:·\s*(.*?))?\s*$/im.exec(raw);
  if (match?.[1] === undefined) return null;
  const name = match[2]?.trim();
  return { id: match[1], name: name === undefined || name === '' ? undefined : name };
}
