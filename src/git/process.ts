import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type {
  GitProcessFailure,
  GitProcessFailureKind,
  GitProcessResult,
} from './contracts.js';

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface GitProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

interface CapturedStream {
  text: string;
  bytes: number;
}

function failure(
  kind: GitProcessFailureKind,
  message: string,
  stdout: CapturedStream,
  stderr: CapturedStream,
  exitCode: number | null,
  startedAt: number,
): GitProcessFailure {
  return {
    ok: false,
    kind,
    message,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Bounded process boundary for Git.
 *
 * Mutation callers must treat timeout, abort, and output-limit outcomes as
 * uncertain and reconcile repository state before retrying.
 */
export function runGitProcess(
  executable: string,
  argv: readonly string[],
  options: GitProcessOptions,
): Promise<GitProcessResult> {
  if (executable.trim() === '') throw new TypeError('Git executable must not be empty.');
  if (argv.length === 0) throw new TypeError('Git argv must not be empty.');
  if (!path.isAbsolute(options.cwd)) {
    throw new TypeError('Git cwd must be an absolute path.');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Git timeout must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('Git output limit must be a positive safe integer.');
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout: CapturedStream = { text: '', bytes: 0 };
    const stderr: CapturedStream = { text: '', bytes: 0 };
    let settled = false;
    let terminalKind: Exclude<GitProcessFailureKind, 'command-failed' | 'spawn-failed'> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    };

    const child = spawn(executable, [...argv], {
      cwd: options.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = (result: GitProcessResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const terminalMessage = (
      kind: Exclude<GitProcessFailureKind, 'command-failed' | 'spawn-failed'>,
    ): string =>
      kind === 'timeout'
        ? `Git command timed out after ${timeoutMs}ms.`
        : kind === 'aborted'
          ? 'Git command was aborted.'
          : `Git command exceeded the ${maxOutputBytes}-byte output limit.`;

    const terminate = (
      kind: Exclude<GitProcessFailureKind, 'command-failed' | 'spawn-failed'>,
    ): void => {
      if (terminalKind !== undefined) return;
      terminalKind = kind;
      child.kill('SIGTERM');
      escalationTimer = setTimeout(() => {
        child.kill('SIGKILL');
        // Some Windows process trees never deliver a close event after their
        // immediate child exits. Keep the process boundary bounded and require
        // semantic callers to reconcile any mutation with an unknown outcome.
        settle(
          failure(
            kind,
            terminalMessage(kind),
            stdout,
            stderr,
            null,
            startedAt,
          ),
        );
      }, 2_000);
      escalationTimer.unref();
    };

    function onAbort(): void {
      terminate('aborted');
    }

    const capture = (target: CapturedStream, chunk: Buffer | string): void => {
      if (terminalKind === 'output-limit') return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - stdout.bytes - stderr.bytes;
      if (remaining > 0) {
        const retained = buffer.subarray(0, remaining);
        target.text += retained.toString('utf8');
        target.bytes += retained.byteLength;
      }
      if (buffer.byteLength > remaining) terminate('output-limit');
    };

    child.stdout.on('data', (chunk: Buffer | string) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer | string) => capture(stderr, chunk));
    child.on('error', (error: Error) => {
      settle(
        failure(
          'spawn-failed',
          error.message,
          stdout,
          stderr,
          null,
          startedAt,
        ),
      );
    });
    child.on('close', (exitCode) => {
      if (terminalKind !== undefined) {
        settle(
          failure(
            terminalKind,
            terminalMessage(terminalKind),
            stdout,
            stderr,
            exitCode,
            startedAt,
          ),
        );
        return;
      }
      if (exitCode !== 0) {
        settle(
          failure(
            'command-failed',
            `Git command exited with code ${String(exitCode)}.`,
            stdout,
            stderr,
            exitCode,
            startedAt,
          ),
        );
        return;
      }
      settle({
        ok: true,
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      });
    });

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        terminate('aborted');
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    timer.unref();
  });
}
