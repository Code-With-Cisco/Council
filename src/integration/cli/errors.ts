/**
 * Failure classification for the Claude Code CLI.
 *
 * The CLI exits 0 on error. Verified against v2.1.220:
 *
 *   $ claude logs zzzzzzzz
 *   No job matching 'zzzzzzzz'. Run 'claude agents' to list running sessions.
 *   $ echo $?
 *   0
 *
 * So exit codes carry almost no signal and the only reliable discriminator is
 * the output text. Everything here is pattern matching, kept in one place so a
 * CLI wording change is a one-file fix rather than a hunt.
 */

import type { CliFailureKind } from '../types.js';

interface Pattern {
  readonly kind: CliFailureKind;
  readonly test: RegExp;
}

/**
 * Ordered most-specific first. `unknown-session` precedes `daemon-unreachable`
 * because a bad id reported while the daemon is also down should read as the
 * bad id — that is the actionable half.
 */
const FAILURE_PATTERNS: readonly Pattern[] = [
  { kind: 'unknown-session', test: /\bNo job matching\b/i },
  { kind: 'unknown-session', test: /\bunknown session\b/i },
  { kind: 'daemon-unreachable', test: /connect ENOENT .*control\.sock/i },
  { kind: 'daemon-unreachable', test: /control\.sock:\s*unreachable/i },
  { kind: 'daemon-unreachable', test: /\b(daemon|supervisor) (is )?not running\b/i },
  { kind: 'daemon-unreachable', test: /Couldn't (read|reach|connect)/i },
  { kind: 'not-authenticated', test: /\b(not logged in|please (run )?\/?login|authentication (failed|required))\b/i },
  { kind: 'not-authenticated', test: /\bInvalid API key\b/i },
  { kind: 'cli-error', test: /^error:/im },
  { kind: 'cli-error', test: /\bunknown option\b/i },
  { kind: 'cli-error', test: /\bunknown command\b/i },
];

/**
 * Returns the failure kind implied by CLI output, or null when the output does
 * not look like a failure.
 *
 * A non-zero exit is always a failure even when unrecognised; a zero exit is a
 * failure only when the text says so.
 */
export function classifyOutput(raw: string, exitCode: number | null): CliFailureKind | null {
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.test.test(raw)) return pattern.kind;
  }
  if (exitCode !== null && exitCode !== 0) return 'cli-error';
  return null;
}

/**
 * `--agent <name>` with an unknown name does not fail. v2.1.220 prints
 *
 *   warning: no agent named 'x' — spawning with default template
 *
 * and dispatches a generic session anyway, so a typo silently produces the
 * wrong agent. Callers surface this rather than letting it pass.
 */
const UNKNOWN_AGENT_WARNING = /warning:\s*no agent named '([^']+)'/i;

export function detectUnknownAgentWarning(raw: string): string | null {
  const match = UNKNOWN_AGENT_WARNING.exec(raw);
  return match?.[1] ?? null;
}

/**
 * Reduces CLI output to a single line for display.
 *
 * Prefers the first line that reads like a diagnostic; falls back to the first
 * non-empty line so an unrecognised failure still renders as something.
 */
export function summarizeOutput(raw: string, fallback: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return fallback;

  const diagnostic = lines.find((line) =>
    /^(error|warning|no job|couldn't|cannot|failed|unknown)/i.test(line),
  );
  return diagnostic ?? lines[0] ?? fallback;
}
