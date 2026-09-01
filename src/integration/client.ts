/**
 * The Claude Code CLI client — the whole integration surface for session control.
 *
 * Contract for every method here: a failed command comes back as a CliFailure
 * to render, never as a thrown exception. Only programmer error throws.
 *
 * This app is not an agent runtime. It shells out to `claude` and reads state
 * files; the per-user supervisor daemon owns session lifecycle, persistence and
 * scheduling, and nothing below reimplements any of that.
 */

import type {
  CliResult,
  DaemonStatus,
  DaemonStopOutcome,
  RawRosterEntry,
  Session,
  StartedSession,
} from './types.js';
import { runClaude, runClaudeJson, type ExecOptions } from './cli/exec.js';
import { detectUnknownAgentWarning, summarizeOutput } from './cli/errors.js';
import {
  compareVersions,
  locateClaude,
  MINIMUM_CLAUDE_VERSION,
  parseVersion,
  type LocatedCli,
  type LocateOptions,
} from './cli/locate.js';
import { parseDaemonStatus, parseDaemonStop } from './parse/daemon.js';
import { parseRoster, parseStartedSession } from './parse/roster.js';

export interface StartSessionRequest {
  /** Subagent definition name. Validate against disk first — an unknown name only warns. */
  readonly agent?: string | undefined;
  /** App-generated launch name used only for the current launch transaction. */
  readonly name?: string | undefined;
  readonly prompt: string;
  /** Working directory. Required in practice: it decides which project the agent sees. */
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly permissionMode?: string | undefined;
  /** Council-owned per-launch additions to the host allow policy. */
  readonly allowedTools?: readonly string[] | undefined;
  /** Council-owned per-launch deny policy. Denies narrow any definition/settings grants. */
  readonly disallowedTools?: readonly string[] | undefined;
}

/**
 * A supervisor-hosted shell job (`claude --bg --exec`) rather than a Claude
 * session. It appears in the roster and answers to the same
 * logs/stop/respawn/rm commands, but spawns no model call.
 *
 * The test harness uses this to prove the full lifecycle without spending quota.
 */
export interface StartExecRequest {
  readonly command: string;
  readonly name?: string | undefined;
  readonly cwd: string;
}

export interface StartSessionOutcome extends StartedSession {
  /**
   * Set when the CLI warned that the requested agent does not exist and
   * dispatched a default template instead. The session is live and running the
   * wrong agent, so callers surface this rather than treating the start as clean.
   */
  readonly unknownAgent: string | undefined;
}

export interface ClaudeClientOptions {
  readonly locate?: LocateOptions | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

function normalizedToolList(values: readonly string[] | undefined, label: string): string[] {
  if (values === undefined) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value === '' || /[\u0000-\u001f\u007f,]/.test(value) || value.length > 512) {
      throw new Error(`${label} contains an invalid tool selector.`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function buildStartSessionArgv(request: StartSessionRequest): string[] {
  if (request.prompt.trim() === '') {
    throw new Error('start() requires a non-empty prompt');
  }

  const argv = ['--bg'];
  if (request.agent !== undefined) argv.push('--agent', request.agent);
  if (request.name !== undefined) argv.push('--name', request.name);
  if (request.model !== undefined) argv.push('--model', request.model);
  if (request.effort !== undefined) argv.push('--effort', request.effort);
  if (request.permissionMode !== undefined) argv.push('--permission-mode', request.permissionMode);
  const allowedTools = normalizedToolList(request.allowedTools, 'Allowed tools');
  const disallowedTools = normalizedToolList(request.disallowedTools, 'Disallowed tools');
  if (allowedTools.length > 0) argv.push('--allowedTools', allowedTools.join(','));
  if (disallowedTools.length > 0) argv.push('--disallowedTools', disallowedTools.join(','));
  argv.push(request.prompt);
  return argv;
}

export class ClaudeClient {
  private constructor(
    readonly cli: LocatedCli,
    private readonly env: NodeJS.ProcessEnv | undefined,
    private readonly defaultTimeoutMs: number | undefined,
  ) {}

  /** Returns null when no `claude` binary exists — a UI state, not an error. */
  static async create(options: ClaudeClientOptions = {}): Promise<ClaudeClient | null> {
    const cli = await locateClaude(options.locate ?? {});
    if (cli === null) return null;
    return new ClaudeClient(cli, options.env, options.defaultTimeoutMs);
  }

  /** For tests and for a user-supplied binary path that should not be re-probed. */
  static fromBinary(bin: string, options: ClaudeClientOptions = {}): ClaudeClient {
    return new ClaudeClient(
      { bin, version: undefined, meetsMinimum: true, discoveredVia: 'override' },
      options.env,
      options.defaultTimeoutMs,
    );
  }

  private exec(argv: readonly string[], opts: ExecOptions = {}): Promise<CliResult<string>> {
    return runClaude(this.cli.bin, argv, { env: this.env, timeoutMs: this.defaultTimeoutMs, ...opts });
  }

  /**
   * Re-probes the executable/version and a roster read immediately before a
   * launch. The roster command is also the narrowest non-interactive check of
   * the current authentication/capability state; it never starts a session.
   */
  async verifyLaunchCapability(): Promise<CliResult<string>> {
    const versionResult = await this.exec(['--version'], { timeoutMs: 10_000 });
    if (!versionResult.ok) return versionResult;

    const version = parseVersion(versionResult.value);
    if (
      version !== undefined &&
      compareVersions(version, MINIMUM_CLAUDE_VERSION) < 0
    ) {
      return {
        ok: false,
        kind: 'cli-error',
        message: `Claude Code ${version} is below the supported minimum ${MINIMUM_CLAUDE_VERSION}.`,
        raw: versionResult.raw,
        argv: versionResult.argv,
        exitCode: 0,
        durationMs: versionResult.durationMs,
      };
    }

    const rosterResult = await this.listSessions({ all: true });
    if (!rosterResult.ok) return rosterResult;
    return {
      ok: true,
      value: version ?? 'version unknown; roster capability confirmed',
      raw: `${versionResult.raw}\n${rosterResult.raw}`.trim(),
      argv: versionResult.argv,
      durationMs: versionResult.durationMs + rosterResult.durationMs,
    };
  }

  // ---------------------------------------------------------------- roster

  /**
   * Reads the roster.
   *
   * `--all` includes completed background sessions; without it a finished
   * specialist vanishes from the squad screen mid-session, so the app polls
   * with `--all` and filters in the UI instead.
   *
   * Note the result contains interactive rows too — terminals the user has
   * open. Those carry no `id` and no `state` and must never be acted on.
   */
  async listSessions(options: { all?: boolean; cwd?: string } = {}): Promise<CliResult<Session[]>> {
    const argv = ['agents', '--json'];
    if (options.all !== false) argv.push('--all');
    if (options.cwd !== undefined) argv.push('--cwd', options.cwd);

    const result = await runClaudeJson<RawRosterEntry[]>(this.cli.bin, argv, {
      env: this.env,
      timeoutMs: this.defaultTimeoutMs,
    });
    if (!result.ok) return result;
    return { ...result, value: parseRoster(result.value) };
  }

  // --------------------------------------------------------------- control

  /**
   * Dispatches a background session.
   *
   * Flag order matches the documented form: `claude --bg --agent <name>
   * --name <label> "<prompt>"`. The prompt is the trailing positional and is
   * passed as one argv element — no shell is involved, so it needs no quoting.
   */
  async start(request: StartSessionRequest): Promise<CliResult<StartSessionOutcome>> {
    const argv = buildStartSessionArgv(request);

    // Dispatch cold-starts the supervisor ("Starting background service…"),
    // which is slower than a steady-state call.
    const result = await this.exec(argv, { cwd: request.cwd, timeoutMs: 60_000 });
    if (!result.ok) return result;

    const started = parseStartedSession(result.value);
    if (started === null) {
      return {
        ok: false,
        kind: 'malformed-output',
        message: 'Could not read a session id from the dispatch output',
        raw: result.raw,
        argv,
        exitCode: 0,
        durationMs: result.durationMs,
      };
    }

    return {
      ...result,
      value: { ...started, unknownAgent: detectUnknownAgentWarning(result.value) ?? undefined },
    };
  }

  /**
   * Dispatches a supervisor-hosted shell job instead of a Claude session.
   *
   * Same roster row, same control commands, no model call. Used by the harness
   * to exercise the lifecycle for free, and by the app for the occasional
   * genuinely non-model job.
   */
  async startExec(request: StartExecRequest): Promise<CliResult<StartSessionOutcome>> {
    if (request.command.trim() === '') {
      throw new Error('startExec() requires a non-empty command');
    }

    const argv = ['--bg'];
    if (request.name !== undefined) argv.push('--name', request.name);
    argv.push('--exec', request.command);

    const result = await this.exec(argv, { cwd: request.cwd, timeoutMs: 60_000 });
    if (!result.ok) return result;

    const started = parseStartedSession(result.value);
    if (started === null) {
      return {
        ok: false,
        kind: 'malformed-output',
        message: 'Could not read a session id from the dispatch output',
        raw: result.raw,
        argv,
        exitCode: 0,
        durationMs: result.durationMs,
      };
    }

    return { ...result, value: { ...started, unknownAgent: undefined } };
  }

  /**
   * Recent terminal output for a session.
   *
   * Requires a reachable supervisor: with the daemon down this fails with
   * `connect ENOENT .../control.sock`, classified as `daemon-unreachable`.
   * That is expected for a cold session, not a fault — attaching or replying
   * wakes it, after which logs succeed.
   */
  async logs(id: string): Promise<CliResult<string>> {
    const argv = ['logs', id];
    const result = await this.exec(argv, { treatOutputAsSuccess: true });
    if (!result.ok) return result;

    const raw = result.value;
    let kind: 'unknown-session' | 'daemon-unreachable' | undefined;
    if (/^No job matching\b/im.test(raw)) {
      kind = 'unknown-session';
    } else if (new RegExp(`^Couldn't read logs for ${escapeRegExp(id)}\\b`, 'im').test(raw)) {
      kind = 'daemon-unreachable';
    }
    if (kind === undefined) return result;

    return {
      ok: false,
      kind,
      message: summarizeOutput(raw, `claude logs ${id} failed`),
      raw,
      argv,
      exitCode: 0,
      durationMs: result.durationMs,
    };
  }

  /** Stops a session, keeping its conversation. Resume later via attach. */
  stop(id: string): Promise<CliResult<string>> {
    return this.exec(['stop', id]);
  }

  /** Restarts a session with its conversation intact. */
  respawn(id: string): Promise<CliResult<string>> {
    return this.exec(['respawn', id]);
  }

  /**
   * Restarts every session. This is the "wake the squad" action.
   *
   * Never called automatically: after a machine restart the whole squad reads
   * `failed`, and the user has to see that before anything is respawned.
   */
  respawnAll(): Promise<CliResult<string>> {
    return this.exec(['respawn', '--all'], { timeoutMs: 120_000 });
  }

  /** Deletes a session and its worktree. Works on already-exited sessions, unlike stop. */
  remove(id: string): Promise<CliResult<string>> {
    return this.exec(['rm', id]);
  }

  // ---------------------------------------------------------------- daemon

  /**
   * Supervisor status.
   *
   * `treatOutputAsSuccess` is set because this command describes a down daemon
   * in prose that the error classifier would otherwise read as
   * `daemon-unreachable`. A stopped supervisor is the normal resting state in
   * v2.1.233 — service install is disabled, so it runs on demand and exits when
   * the last client disconnects. Reading it is what tells us so.
   */
  async daemonStatus(): Promise<CliResult<DaemonStatus>> {
    const result = await this.exec(['daemon', 'status'], { treatOutputAsSuccess: true });
    if (!result.ok) return result;
    return { ...result, value: parseDaemonStatus(result.value) };
  }

  /**
   * Stops the supervisor. Recovery action only.
   *
   * `keepWorkers` leaves detached sessions running, which is what makes this
   * safe to offer: a wedged supervisor can be restarted without killing work.
   * `any` also stops a transient (non-service) daemon, which is the only kind
   * this version produces.
   */
  async daemonStop(
    options: { any?: boolean; keepWorkers?: boolean } = {},
  ): Promise<CliResult<DaemonStopOutcome>> {
    const argv = ['daemon', 'stop'];
    if (options.any !== false) argv.push('--any');
    if (options.keepWorkers !== false) argv.push('--keep-workers');
    // Like `daemon status`, this describes "nothing to stop" in prose the error
    // classifier would otherwise read as a daemon failure. Stopping an already
    // stopped supervisor is a success.
    const result = await this.exec(argv, { timeoutMs: 30_000, treatOutputAsSuccess: true });
    if (!result.ok) return result;
    return { ...result, value: parseDaemonStop(result.value) };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
