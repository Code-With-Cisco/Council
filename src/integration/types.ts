/**
 * Domain types for the Claude Code integration layer.
 *
 * Everything here is derived from the shipped CLI surface of Claude Code
 * v2.1.220 (see docs/cli-surface.md for the probe transcript). The agent-view
 * CLI is a research preview: fields documented as optional really are absent in
 * practice, so parsers must never assume presence.
 */

/** Discriminates a roster row that is a real background job from a terminal a human is sitting at. */
export type SessionKind = 'interactive' | 'background';

/**
 * Lifecycle state reported by `claude agents --json`.
 *
 * Only background sessions carry a state; interactive rows omit it entirely.
 * `stopped` covers Ctrl+X, `claude stop`, and external process termination —
 * machine shutdown lands sessions in `failed`, not `stopped`.
 */
export type SessionState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

export const SESSION_STATES: readonly SessionState[] = [
  'working',
  'blocked',
  'done',
  'failed',
  'stopped',
];

/**
 * Why a session is parked. The docs enumerate five values, but this is a
 * research-preview surface — an unrecognised string is passed through rather
 * than dropped, so a new reason renders as text instead of vanishing.
 */
export type KnownWaitingFor =
  | 'permission prompt'
  | 'input needed'
  | 'sandbox request'
  | 'worker request'
  | 'dialog open';

export type WaitingFor = KnownWaitingFor | (string & {});

export const KNOWN_WAITING_FOR: readonly KnownWaitingFor[] = [
  'permission prompt',
  'input needed',
  'sandbox request',
  'worker request',
  'dialog open',
];

/**
 * A row exactly as `claude agents --json` emits it, before any normalisation.
 *
 * Verified against v2.1.220: interactive rows carry only
 * `{pid, cwd, kind, startedAt, sessionId, name}` — no `id`, no `state`.
 */
export interface RawRosterEntry {
  readonly id?: string | undefined;
  readonly cwd?: string | undefined;
  readonly kind?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly name?: string | undefined;
  readonly state?: string | undefined;
  readonly status?: string | undefined;
  readonly waitingFor?: string | undefined;
  readonly pid?: number | undefined;
}

/**
 * Contents of `<config>/jobs/<id>/state.json`.
 *
 * Richer than the roster row and updated by the supervisor independently of
 * any CLI invocation, which makes it the low-latency source for `detail`.
 * Undocumented, so every field is optional and the file is read best-effort.
 */
export interface JobStateFile {
  readonly state?: string | undefined;
  /** Human-readable one-liner — last output line or terminal summary. */
  readonly detail?: string | undefined;
  /** Observed values: 'idle' | 'active'. Kept as string; undocumented. */
  readonly tempo?: string | undefined;
  readonly output?: string | null | undefined;
  readonly children?: unknown;
  /** e.g. 'exec' for `--bg --exec` shell jobs, otherwise an agent template. */
  readonly template?: string | undefined;
  /** The original prompt or shell command the session was dispatched with. */
  readonly intent?: string | undefined;
  readonly name?: string | undefined;
  /** 'user' when set via --name, otherwise auto-generated. */
  readonly nameSource?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly resumeSessionId?: string | undefined;
  /** Short id the daemon knows this job by — equals the roster `id`. */
  readonly daemonShort?: string | undefined;
  readonly cwd?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly firstTerminalAt?: string | undefined;
  readonly backend?: string | undefined;
  readonly respawnFlags?: readonly string[] | undefined;
}

/** Where a field in the unified session came from, for debugging stale reads. */
export type SessionSource = 'roster' | 'jobfile' | 'roster+jobfile';

/**
 * The app's normalised session. This is what the UI renders and what IPC
 * carries; nothing downstream should touch `RawRosterEntry` or `JobStateFile`.
 */
export interface Session {
  /** Short id used by attach/logs/stop/respawn/rm. Absent for interactive rows. */
  readonly id: string | undefined;
  readonly sessionId: string | undefined;
  readonly name: string | undefined;
  readonly kind: SessionKind;
  readonly state: SessionState | undefined;
  readonly waitingFor: WaitingFor | undefined;
  /** Free-text status from the roster (`status`) when present. */
  readonly status: string | undefined;
  /** One-line summary from the job state file — usually the last output line. */
  readonly detail: string | undefined;
  readonly cwd: string | undefined;
  readonly startedAt: Date | undefined;
  readonly updatedAt: Date | undefined;
  readonly pid: number | undefined;
  /** True when the supervisor is not currently hosting a process for this session. */
  readonly cold: boolean;
  /** From `<config>/jobs/pins.json`. Pinning is a TUI keystroke; we only read it. */
  readonly pinned: boolean;
  /** The session's dispatch prompt or shell command, when recoverable. */
  readonly intent: string | undefined;
  readonly source: SessionSource;
}

/**
 * Parsed `claude daemon status`. The command prints prose, not JSON, and always
 * exits 0 — including when the daemon is down.
 */
export interface DaemonStatus {
  /**
   * A down daemon is NORMAL, not an error: service install is disabled in
   * v2.1.220, so the supervisor starts on demand and exits when the last
   * client disconnects. Never surface this as a fault.
   */
  readonly running: boolean;
  readonly pid: number | undefined;
  readonly version: string | undefined;
  readonly uptime: string | undefined;
  /** e.g. 'transient — started on-demand by `claude --bg` (pid 9798) in /path'. */
  readonly origin: string | undefined;
  readonly socketDir: string | undefined;
  readonly controlSocketReachable: boolean;
  readonly workerCount: number | undefined;
  readonly rosterPresent: boolean;
  readonly logPath: string | undefined;
  /** Unparsed output, retained so an unrecognised format is still renderable. */
  readonly raw: string;
}

/** Why a CLI invocation failed. Derived from output text, never from exit codes. */
export type CliFailureKind =
  /** The `claude` binary could not be located on this machine. */
  | 'cli-missing'
  /** Process spawn failed (ENOENT, EACCES, ...). */
  | 'spawn-failed'
  /** The call exceeded its timeout and was killed. */
  | 'timeout'
  /** `No job matching '<id>'` — the session id is unknown. */
  | 'unknown-session'
  /** The supervisor socket is unreachable, so the request could not be served. */
  | 'daemon-unreachable'
  /** Output was expected to be JSON and was not. */
  | 'malformed-output'
  /** The CLI reported an authentication problem. */
  | 'not-authenticated'
  /** Recognised as a failure but not classified further. */
  | 'cli-error';

export interface CliFailure {
  readonly ok: false;
  readonly kind: CliFailureKind;
  /** Message suitable for rendering in the UI. */
  readonly message: string;
  /** Full captured stdout+stderr, for the log drawer. */
  readonly raw: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface CliSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly raw: string;
  readonly argv: readonly string[];
  readonly durationMs: number;
}

/**
 * Every CLI interaction returns this. Errors from the CLI are states to render,
 * so nothing in this module throws for a failed command — only for programmer
 * error (bad arguments).
 */
export type CliResult<T> = CliSuccess<T> | CliFailure;

/** Result of dispatching a new background session. */
export interface StartedSession {
  /** Short id parsed from `backgrounded · <id> · <name>`. */
  readonly id: string;
  readonly name: string | undefined;
}

/** One of the five specialists, as declared in the user-editable roster config. */
export interface RosterMember {
  /** Stable key used by the UI for identity colour and sigil. */
  readonly key: string;
  /** Display name, e.g. 'Arden'. */
  readonly label: string;
  /**
   * `name` frontmatter of a subagent definition under `<config>/agents/` or
   * `<project>/.claude/agents/`. Passed to `claude --bg --agent <name>`.
   *
   * A typo here does NOT fail: v2.1.220 prints `warning: no agent named 'x' —
   * spawning with default template` and silently dispatches a generic session,
   * so this is validated against disk before dispatch.
   */
  readonly agent: string;
  /** Absolute path to the specialist's home project directory. */
  readonly cwd: string;
  readonly role?: string | undefined;
  /** Prompt used when the boot sequence starts this session. */
  readonly bootPrompt?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

export interface RosterConfig {
  readonly version: 1;
  readonly members: readonly RosterMember[];
  /** Poll interval for `agents --json` reconciliation. Hooks are the fast path. */
  readonly pollIntervalMs: number;
}

/** Outcome of checking a roster member's `agent` against subagent definitions on disk. */
export interface AgentValidation {
  readonly agent: string;
  readonly found: boolean;
  /** Path of the definition file that would win, when found. */
  readonly path: string | undefined;
  /** Other definitions with the same `name`, which resolve by filesystem order. */
  readonly shadowedBy: readonly string[];
}

/** A roster member joined to its live session, if any. This is the squad screen's row. */
export interface SquadSlot {
  readonly member: RosterMember;
  readonly session: Session | undefined;
  /** True when config declares this member but no session exists for it. */
  readonly missing: boolean;
  readonly validation: AgentValidation | undefined;
}

/** Agent-team membership read from `<config>/teams/<team>/config.json`. */
export interface TeamMember {
  readonly name: string;
  readonly agentId: string | undefined;
  /** 'team-lead' for the lead; present for teammates only when spawned from a definition. */
  readonly agentType: string | undefined;
}

export interface TeamSnapshot {
  /** Session-derived: `session-` + first 8 chars of the lead's session id. */
  readonly team: string;
  readonly members: readonly TeamMember[];
  /** Tasks read from `<config>/tasks/<team>/`. */
  readonly tasks: readonly TeamTask[];
  /** Set when a file failed to parse — rendered as "needs attention", never thrown. */
  readonly parseErrors: readonly ParseProblem[];
}

export interface TeamTask {
  readonly id: string;
  readonly name: string | undefined;
  readonly state: string | undefined;
  readonly assignee: string | undefined;
  readonly dependsOn: readonly string[];
}

/** A file the app could read but not understand. Surfaced, never thrown. */
export interface ParseProblem {
  readonly path: string;
  readonly message: string;
}
