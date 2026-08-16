/**
 * PTY-backed interaction with a background session.
 *
 * WHY THIS EXISTS: the original spec assumed a lightweight `claude reply <id>`
 * command. There isn't one. Re-verified against v2.1.233 — the complete set of
 * session subcommands is attach / logs / stop / kill / respawn / rm / daemon,
 * and `claude reply <id> "text"` falls through to the default command, which
 * would start a brand new interactive session whose first prompt is the literal
 * word "reply". Dangerous to guess at, so both talking paths go through the PTY:
 *
 *  - `AttachSession` drives the xterm.js drawer, where permission prompts and
 *    dialogs are answered.
 *  - `sendReply` is the same mechanism run headlessly and torn down, which is
 *    what backs the lightweight reply path for plain questions.
 *
 * Attaching a stopped session restarts it from its saved transcript, so a reply
 * to a cold specialist wakes it — the behaviour the spec wanted, reached a
 * different way.
 */

import type { CliFailure, CliResult } from '../types.js';

/** Ctrl+Z — documented detach key: "returns to agent view, Ctrl+Z drops back to your shell". */
const DETACH = '\x1a';
const ENTER = '\r';

/** Minimal slice of node-pty's surface, so the type does not require the native module at build time. */
interface PtyProcess {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  readonly pid: number;
}

interface PtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd?: string | undefined;
      env?: NodeJS.ProcessEnv | undefined;
    },
  ): PtyProcess;
}

let ptyModule: PtyModule | null | undefined;

/**
 * Loads node-pty lazily.
 *
 * It is a native module and an optional dependency: a machine without a
 * matching prebuild should lose the attach drawer, not fail to launch the app.
 * Returns null when unavailable so callers can degrade to the logs-only view.
 */
export async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    const mod = (await import('node-pty')) as unknown as PtyModule & { default?: PtyModule };
    ptyModule = mod.default ?? mod;
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

export interface AttachOptions {
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * A live `claude attach <id>` PTY.
 *
 * Raw terminal bytes pass through untouched — this is a transport, and the
 * renderer's xterm.js instance does the interpreting.
 */
export class AttachSession {
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  private disposed = false;

  private constructor(private readonly pty: PtyProcess) {
    pty.onData((chunk) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    pty.onExit(({ exitCode }) => {
      this.disposed = true;
      for (const listener of this.exitListeners) listener(exitCode);
    });
  }

  static async open(
    bin: string,
    id: string,
    options: AttachOptions = {},
  ): Promise<CliResult<AttachSession>> {
    const pty = await loadPty();
    const argv = ['attach', id];
    if (pty === null) {
      return ptyUnavailable(argv);
    }

    try {
      const proc = pty.spawn(bin, argv, {
        name: 'xterm-256color',
        cols: options.cols ?? 120,
        rows: options.rows ?? 32,
        cwd: options.cwd,
        env: options.env ?? process.env,
      });
      const session = new AttachSession(proc);
      return { ok: true, value: session, raw: '', argv, durationMs: 0 };
    } catch (err) {
      return {
        ok: false,
        kind: 'spawn-failed',
        message: err instanceof Error ? err.message : String(err),
        raw: '',
        argv,
        exitCode: null,
        durationMs: 0,
      };
    }
  }

  get pid(): number {
    return this.pty.pid;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Forwards keystrokes from the renderer verbatim. */
  write(data: string): void {
    if (!this.disposed) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) this.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
  }

  /**
   * Detaches without stopping the session.
   *
   * Ctrl+Z first so the CLI unwinds its own terminal state; the kill is a
   * backstop if it does not exit promptly. The session keeps running either way.
   */
  detach(): void {
    if (this.disposed) return;
    this.pty.write(DETACH);
    setTimeout(() => {
      if (!this.disposed) this.pty.kill();
    }, 500).unref();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.pty.kill();
    } catch {
      // Already gone — nothing to clean up.
    }
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

function ptyUnavailable(argv: readonly string[]): CliFailure {
  return {
    ok: false,
    kind: 'spawn-failed',
    message: 'node-pty is unavailable, so interactive attach is disabled on this machine',
    raw: '',
    argv,
    exitCode: null,
    durationMs: 0,
  };
}

export interface ReplyOptions extends AttachOptions {
  /** How long to wait for the session's UI to settle before typing. */
  readonly readyTimeoutMs?: number | undefined;
  /** How long to keep the PTY open after sending, to capture the acknowledgement. */
  readonly settleMs?: number | undefined;
}

export interface ReplyOutcome {
  /** Terminal output captured while the reply was delivered. */
  readonly transcript: string;
  /** True when the session produced output after the message was sent. */
  readonly acknowledged: boolean;
}

/**
 * Delivers a plain-text message to a session and detaches.
 *
 * This is the lightweight talking path: attach, wait for the UI to quiesce,
 * type, detach. It handles plain questions only — anything that opens a
 * permission prompt or a dialog belongs in the attach drawer, where the user
 * can see what they are approving.
 */
export async function sendReply(
  bin: string,
  id: string,
  message: string,
  options: ReplyOptions = {},
): Promise<CliResult<ReplyOutcome>> {
  if (message.trim() === '') {
    throw new Error('sendReply requires a non-empty message');
  }

  const opened = await AttachSession.open(bin, id, options);
  if (!opened.ok) return opened;

  const session = opened.value;
  const argv = ['attach', id];
  const startedAt = Date.now();
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const settleMs = options.settleMs ?? 1_500;

  let transcript = '';
  let lastChunkAt = Date.now();
  const stopCapture = session.onData((chunk) => {
    transcript += chunk;
    lastChunkAt = Date.now();
  });

  try {
    // Readiness is inferred from output going quiet rather than from matching a
    // prompt string: the TUI's prompt is decorated and version-dependent, and
    // pattern-matching it would break on the next release. Quiet means the
    // session has finished drawing and is waiting on input.
    const quietFor = 400;
    const deadline = startedAt + readyTimeoutMs;
    while (Date.now() < deadline && Date.now() - lastChunkAt < quietFor) {
      await delay(100);
    }

    const beforeSend = transcript.length;
    session.write(message);
    // The composer can debounce input; a beat before Enter avoids submitting
    // a partially-delivered line.
    await delay(120);
    session.write(ENTER);

    await delay(settleMs);
    const acknowledged = transcript.length > beforeSend + message.length;

    session.detach();
    return {
      ok: true,
      value: { transcript, acknowledged },
      raw: transcript,
      argv,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    stopCapture();
    setTimeout(() => session.dispose(), 1_000).unref();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
