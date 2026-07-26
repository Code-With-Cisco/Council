/**
 * Process wrapper for the `claude` CLI.
 *
 * Two rules hold everywhere below:
 *
 *  1. A failed command is a value, not an exception. Callers get a CliFailure
 *     they can render. Only programmer error (empty argv) throws.
 *  2. `shell: false` always. Prompts are user text and reach the CLI as a single
 *     argv element, so quoting never has to be reasoned about.
 */

import { spawn } from 'node:child_process';
import type { CliFailure, CliResult } from '../types.js';
import { classifyOutput, summarizeOutput } from './errors.js';

export interface ExecOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * Skip failure classification and return raw output as success. Used by
   * `daemon status`, which describes a down daemon in prose that would
   * otherwise classify as `daemon-unreachable` — a normal state, not an error.
   */
  readonly treatOutputAsSuccess?: boolean | undefined;
}

/** Default ceiling for a single CLI call. Roster reads are far quicker than this. */
export const DEFAULT_TIMEOUT_MS = 20_000;

interface RawRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly spawnError: Error | undefined;
  readonly timedOut: boolean;
}

function runProcess(bin: string, argv: readonly string[], opts: ExecOptions): Promise<RawRun> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(bin, [...argv], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number | null, spawnError: Error | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        spawnError,
        timedOut,
      });
    };

    function onAbort(): void {
      child.kill('SIGTERM');
    }

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // The CLI can sit in a signal handler; escalate rather than hang a poll.
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      }, timeoutMs);
      timer.unref();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: Error) => finish(null, err));
    child.on('close', (code) => finish(code, undefined));
  });
}

function failure(
  kind: CliFailure['kind'],
  message: string,
  raw: string,
  argv: readonly string[],
  exitCode: number | null,
  durationMs: number,
): CliFailure {
  return { ok: false, kind, message, raw, argv, exitCode, durationMs };
}

/**
 * Runs the CLI and returns combined stdout+stderr on success.
 *
 * Both streams are combined because the CLI mixes diagnostics across them —
 * the unknown-agent warning arrives on stderr while the session id that
 * follows it arrives on stdout, and both are needed to interpret a dispatch.
 */
export async function runClaude(
  bin: string,
  argv: readonly string[],
  opts: ExecOptions = {},
): Promise<CliResult<string>> {
  if (argv.length === 0) {
    throw new Error('runClaude requires at least one argument');
  }

  const run = await runProcess(bin, argv, opts);
  const raw = run.stdout + (run.stderr === '' ? '' : (run.stdout === '' ? '' : '\n') + run.stderr);

  if (run.spawnError !== undefined) {
    const code = (run.spawnError as NodeJS.ErrnoException).code;
    const kind = code === 'ENOENT' ? 'cli-missing' : 'spawn-failed';
    return failure(kind, run.spawnError.message, raw, argv, run.exitCode, run.durationMs);
  }

  if (run.timedOut) {
    const limit = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return failure(
      'timeout',
      `claude ${argv[0]} timed out after ${limit}ms`,
      raw,
      argv,
      run.exitCode,
      run.durationMs,
    );
  }

  if (opts.treatOutputAsSuccess !== true) {
    const kind = classifyOutput(raw, run.exitCode);
    if (kind !== null) {
      return failure(
        kind,
        summarizeOutput(raw, `claude ${argv.join(' ')} failed`),
        raw,
        argv,
        run.exitCode,
        run.durationMs,
      );
    }
  }

  return { ok: true, value: raw, raw, argv, durationMs: run.durationMs };
}

/**
 * Runs the CLI and parses stdout as JSON.
 *
 * The JSON body is isolated from the first `[` or `{`, because the CLI prefixes
 * unrelated notices ("Starting background service…") to otherwise-clean output.
 */
export async function runClaudeJson<T>(
  bin: string,
  argv: readonly string[],
  opts: ExecOptions = {},
): Promise<CliResult<T>> {
  const result = await runClaude(bin, argv, opts);
  if (!result.ok) return result;

  const text = result.value;
  const start = text.search(/[[{]/);
  if (start === -1) {
    return failure(
      'malformed-output',
      `Expected JSON from \`claude ${argv.join(' ')}\``,
      text,
      argv,
      0,
      result.durationMs,
    );
  }

  try {
    const value = JSON.parse(text.slice(start)) as T;
    return { ok: true, value, raw: text, argv, durationMs: result.durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure('malformed-output', message, text, argv, 0, result.durationMs);
  }
}
