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
    if (
      value === '' ||
      /[\u0000-\u001f\u007f,]/.test(value) ||
      value.length > 512
    ) {
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
   * The caller must have validated `agent` against disk first. Claude silently
   * falls back to its default template for an unknown agent, so the raw warning
   * is checked and returned as `unknownAgent` even when the command exits 0.
   */
  async startSession(request: StartSessionRequest): Promise<CliResult<StartSessionOutcome>> {
    const argv = buildStartSessionArgv(request);
    const result = await this.exec(argv, { cwd: request.cwd });
    if (!result.ok) return result;
    const started = parseStartedSession(result.value);
    if (started === undefined) {
      return {
        ok: false,
        kind: 'malformed-output',
        message: 'Claude started without a recognized background-session acknowledgement.',
        raw: result.raw,
        argv: result.argv,
        exitCode: 0,
        durationMs: result.durationMs,
      };
    }
    return {
      ...result,
      value: {
        ...started,
        unknownAgent: detectUnknownAgentWarning(result.raw) ?? undefined,
      },
    };
  }

  async startExec(request: StartExecRequest): Promise<CliResult<StartedSession>> {
    if (request.command.trim() === '') throw new Error('startExec() requires a non-empty command');
    const argv = ['--bg', '--exec', request.command];
    if (request.name !== undefined) argv.splice(2, 0, '--name', request.name);
    const result = await this.exec(argv, { cwd: request.cwd });
    if (!result.ok) return result;
    const started = parseStartedSession(result.value);
    if (started === undefined) {
      return {
        ok: false,
        kind: 'malformed-output',
        message: 'Claude exec job started without a recognized background-session acknowledgement.',
        raw: result.raw,
        argv: result.argv,
        exitCode: 0,
        durationMs: result.durationMs,
      };
    }
    return { ...result, value: started };
  }

  async stopSession(id: string): Promise<CliResult<string>> {
    return this.exec(['stop', id]);
  }

  async resumeSession(id: string): Promise<CliResult<string>> {
    return this.exec(['respawn', id]);
  }

  async readLogs(id: string): Promise<CliResult<string>> {
    return this.exec(['logs', id, '--raw']);
  }

  async removeSession(id: string): Promise<CliResult<string>> {
    return this.exec(['rm', id]);
  }

  async daemonStatus(): Promise<CliResult<DaemonStatus>> {
    const result = await this.exec(['daemon', 'status']);
    if (!result.ok) return result;
    return { ...result, value: parseDaemonStatus(result.value) };
  }

  async daemonStop(): Promise<CliResult<DaemonStopOutcome>> {
    const result = await this.exec(['daemon', 'stop']);
    if (!result.ok) return result;
    return { ...result, value: parseDaemonStop(result.value) };
  }

  async daemonLogs(lines = 200): Promise<CliResult<string>> {
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10_000) {
      throw new Error('daemonLogs lines must be an integer between 1 and 10000');
    }
    return this.exec(['daemon', 'logs', '--lines', String(lines)]);
  }

  async version(): Promise<CliResult<string>> {
    const result = await this.exec(['--version']);
    if (!result.ok) return result;
    return { ...result, value: summarizeOutput(result.value) };
  }
}
