/**
 * Domain types for the Claude Code integration layer.
 *
 * Everything here is derived from the shipped CLI surface of Claude Code
 * v2.1.233 on Windows (see docs/cli-surface.md for the probe transcript). The
 * agent-view CLI is a research preview: fields documented as optional really are
 * absent in practice, so parsers must never assume presence.
 */

/** Discriminates a roster row that is a real background job from a terminal a human is sitting at. */
export type SessionKind = 'interactive' | 'background';

/**
 * Lifecycle state reported by `claude agents --json`.
 *
 * Only background sessions carry a state; interactive rows omit it entirely.
 * `stopped` covers Ctrl+X, `claude stop`, and external process termination —
 * machine shutdown lands sessions in `failed`, not `stopped`.
 *
 * The four transitional states are not a guess: 2.1.233 carries them as its own
 * named array (`["starting","resuming","adopted","crashed"]`) and groups all
 * four behind one attach message, "Session is starting — it will appear once
 * ready". `running` is what the supervisor writes once a session leaves them.
 * They were absent from this union until 2.1.233 was probed on Windows, which
 * meant a `crashed` session was dropped to `undefined` and then rendered as
 * though it were healthy.
 */
export type SessionState =
  | 'working'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'starting'
  | 'resuming'
  | 'adopted'
  | 'crashed'
  | 'running';

export const SESSION_STATES: readonly SessionState[] = [
  'working',
  'blocked',
  'done',
  'failed',
  'stopped',
  'starting',
  'resuming',
  'adopted',
  'crashed',
  'running',
];

/**
 * States the supervisor moves through while bringing a session back up.
 *
 * Mirrors the CLI's own array. `crashed` belongs here rather than with the
 * terminal states: the supervisor restarts from it, so it is a stage on the way
 * to `running`, not an end state a person has to act on.
 */
export const TRANSITIONAL_SESSION_STATES: readonly SessionState[] = [
  'starting',
  'resuming',
  'adopted',
  'crashed',
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
  | 'dialog open'
  | 'goal proposal';

export type WaitingFor = KnownWaitingFor | (string & {});

export const KNOWN_WAITING_FOR: readonly KnownWaitingFor[] = [
  'permission prompt',
  'input needed',
  'sandbox request',
  'worker request',
  'dialog open',
  // Added in 2.1.233. The pass-through above is why this only ever showed up as
  // unstyled text rather than vanishing, which is the behaviour to preserve:
  // the CLI can also forward an arbitrary `topDialogWaitingFor` verbatim.
  'goal proposal',
];

/**
 * A row exactly as `claude agents --json` emits it, before any normalisation.
 *
 * Verified against v2.1.233 on Windows: interactive rows carry only
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
  /** Observed values: 'idle' | 'active' | 'blocked'. Kept as string; undocumented. */
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
   * False when the CLI prose does not match a verified shape. The UI must show
   * "unknown", never confidently reinterpret an unverified Windows format.
   */
  readonly recognized: boolean;
  /**
   * A down daemon is NORMAL, not an error: service install is disabled in
   * v2.1.233, so the supervisor starts on demand and exits when the last
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

/**
 * Outcome of `claude daemon stop`. The command exits 0 in every observed case,
 * including when there was nothing to stop, so the text is the only signal.
 */
export interface DaemonStopOutcome {
  /** The supervisor was running and has been shut down. */
  readonly stopped: boolean;
  /** There was no supervisor to stop — a success, not a fault. */
  readonly alreadyStopped: boolean;
  /** False when the output matched nothing known; render `raw` in that case. */
  readonly recognized: boolean;
  /**
   * Set when the CLI reports a pid to terminate by hand because the supervisor
   * did not answer. On Windows a process holding its pipe cannot be displaced
   * by another `stop`, so the remaining recovery is `taskkill /PID <pid> /F`.
   */
  readonly manualKillPid: number | undefined;
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

/** A configured or discovered agent launch profile. */
export interface RosterMember {
  /** Stable opaque profile id used by the UI and supervisor. */
  readonly key: string;
  /** Original v1 key, retained only for recoverable migration/display. */
  readonly legacyKey?: string | undefined;
  /** Human-readable display name. */
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
  /** Persisted workspace identity. Legacy v1 profiles may omit this in the file. */
  readonly workspaceId?: string | undefined;
  /** Stable inventory identity selected from the resolved catalog. */
  readonly catalogId?: string | undefined;
  /** Fingerprint the user saw when this profile was resolved. */
  readonly definitionFingerprint?: string | undefined;
  /** True for saved preferences, false for an in-memory discovered profile. */
  readonly configured?: boolean | undefined;
  readonly mode?: 'normal' | 'internal' | undefined;
  readonly visible?: boolean | undefined;
  readonly order?: number | undefined;
  /** Stored for forward compatibility. Automatic startup is not performed in Milestone 1. */
  readonly autoStart?: boolean | undefined;
  readonly permissionMode?: string | undefined;
}

export interface RosterConfig {
  /** Source file version after normalization. */
  readonly version: 1 | 2;
  readonly members: readonly RosterMember[];
  /** Poll interval for `agents --json` reconciliation. Hooks are the fast path. */
  readonly pollIntervalMs: number;
}

/** Outcome of checking a roster member's `agent` against subagent definitions on disk. */
export interface AgentValidation {
  readonly agent: string;
  readonly found: boolean;
  readonly catalogId?: string | undefined;
  readonly fingerprint?: string | undefined;
  readonly launchable?: boolean | undefined;
  readonly scope?: 'project' | 'ancestor' | 'user' | undefined;
  readonly diagnostic?: string | undefined;
  /** Path of the definition file that would win, when found. */
  readonly path: string | undefined;
  /** Other definitions with the same `name`, which resolve by filesystem order. */
  readonly shadowedBy: readonly string[];
  /** Same-tier conflicting sources when no effective definition was selected. */
  readonly candidatePaths?: readonly string[] | undefined;
}

/**
 * Read-only binding data included in snapshots. The writable binding store
 * lives in the privileged supervisor layer.
 */
export interface SessionBindingRef {
  readonly providerId: 'claude-code';
  readonly workspaceId: string;
  readonly profileId: string;
  readonly shortSessionId: string;
  readonly fullSessionId?: string | undefined;
  readonly uniqueLaunchName: string;
  readonly agentName: string;
  readonly catalogId: string;
  readonly definitionFingerprint: string;
  readonly requestedCanonicalCwd: string;
  readonly missionExecutionId?: string | undefined;
  readonly missionAccessMode?:
    | 'read-only'
    | 'workspace-write'
    | undefined;
  readonly actualCanonicalCwd?: string | undefined;
  readonly createdAt: string;
  readonly lastConfirmedAt: string;
}

export type ProfileBindingState =
  | 'none'
  | 'active'
  | 'terminal'
  | 'failed'
  | 'stale'
  | 'unavailable';

/** A roster member joined to its live session, if any. This is the squad screen's row. */
export interface SquadSlot {
  readonly member: RosterMember;
  readonly session: Session | undefined;
  /** True when config declares this member but no session exists for it. */
  readonly missing: boolean;
  readonly validation: AgentValidation | undefined;
  readonly binding: SessionBindingRef | undefined;
  readonly bindingState: ProfileBindingState;
  /** False when no provider roster was available to prove the binding stale. */
  readonly staleBinding: boolean;
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
