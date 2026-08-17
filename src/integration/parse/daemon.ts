/**
 * Parsing `claude daemon status`.
 *
 * There is no `--json` for this command; it prints prose and always exits 0.
 * Both real shapes from v2.1.220 are reproduced in test/fixtures/.
 *
 * Running:
 *   pid:     9806
 *   version: 2.1.220
 *   uptime:  4s
 *   origin:  transient — started on-demand by `claude --bg` (pid 9798) in /path
 *   config:  /Users/me/.claude/daemon.json
 *   log:     /Users/me/.claude/daemon.log
 *
 *   bg sessions:
 *     sock dir:     /tmp/cc-daemon-501/1d662268
 *     control.sock: reachable
 *     bg workers:   1 running (control.sock), 1 in roster.json
 *     roster.json:  updated 4s ago
 *
 * Not running:
 *   not running
 *
 *   bg sessions:
 *     sock dir:     /tmp/cc-daemon-501/1d662268
 *     control.sock: unreachable (connect ENOENT .../control.sock)
 *     bg workers:   0 in roster.json (control unreachable)
 *     roster.json:  absent
 *     daemon.log:   absent
 *
 * The same shape on Windows (2.1.233), where the transport is a named pipe
 * rather than a unix socket. The labels are unchanged, which is why one parser
 * covers both — only the values differ:
 *
 *   not running
 *
 *   bg sessions:
 *     sock dir:     \\.\pipe\cc-daemon-*
 *     control.sock: unreachable (connect ENOENT \\.\pipe\cc-daemon-*-control)
 *     bg workers:   0 in roster.json (control unreachable)
 *     roster.json:  absent
 *     daemon.log:   absent
 *
 * Note the `bg workers` line contains the substring "roster.json" too. Every
 * field read here is `^`-anchored so that line cannot be mistaken for the
 * `roster.json:` field below it.
 *
 * A stopped daemon is the ordinary resting state, not a fault: service install
 * is disabled in this version, so the supervisor starts on demand and exits
 * when the last client disconnects. The UI must not present it as broken.
 */

import type { DaemonStatus, DaemonStopOutcome } from '../types.js';

/**
 * Parses `claude daemon stop --any --keep-workers`.
 *
 * Two shapes observed on Windows with 2.1.233, both exiting 0:
 *
 *   stopped
 *   note: the next `claude agents` or `claude --bg` will start a new one
 *
 *   no daemon running
 *
 * The third case — a supervisor process whose control pipe does not answer —
 * was captured on Windows with `supervisor (pid=11596) is still running` and a
 * `taskkill /PID 11596` instruction. Any pid mentioned alongside taskkill/kill
 * wording is surfaced so the UI can offer it, and `raw` is always retained so
 * an unrecognised message is still readable.
 */
export function parseDaemonStop(raw: string): DaemonStopOutcome {
  const alreadyStopped = /^\s*no daemon running\s*$/im.test(raw);
  const stopped = /^\s*stopped\b/im.test(raw);

  let manualKillPid: number | undefined;
  if (/taskkill|kill the process|terminate it manually/i.test(raw)) {
    const match = /\b(?:pid|\/pid)\s*[:=]?\s*(\d{1,10})\b/i.exec(raw);
    const parsed = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
    if (!Number.isNaN(parsed)) manualKillPid = parsed;
  }

  return {
    stopped,
    alreadyStopped,
    // Neither recognised sentence and no pid to act on: the caller shows `raw`.
    recognized: stopped || alreadyStopped || manualKillPid !== undefined,
    manualKillPid,
    raw,
  };
}

/** Reads `key: value` from the flat header block. */
function field(raw: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'im');
  const value = pattern.exec(raw)?.[1];
  return value === undefined || value === '' ? undefined : value;
}

export function parseDaemonStatus(raw: string): DaemonStatus {
  const notRunning = /^\s*not running\s*$/im.test(raw);
  const pidText = field(raw, 'pid');
  const pid = pidText === undefined ? undefined : Number.parseInt(pidText, 10);
  const recognized = notRunning || (pid !== undefined && !Number.isNaN(pid));

  const controlLine = field(raw, 'control\\.sock');
  const reachable = controlLine !== undefined && /^reachable\b/i.test(controlLine);

  // "1 running (control.sock), 1 in roster.json" — prefer the live count;
  // fall back to the roster figure, which is all the down case reports.
  const workersLine = field(raw, 'bg workers');
  let workerCount: number | undefined;
  if (workersLine !== undefined) {
    const running = /(\d+)\s+running/i.exec(workersLine)?.[1];
    const inRoster = /(\d+)\s+in roster\.json/i.exec(workersLine)?.[1];
    const chosen = running ?? inRoster;
    if (chosen !== undefined) workerCount = Number.parseInt(chosen, 10);
  }

  const rosterLine = field(raw, 'roster\\.json');
  const rosterPresent = rosterLine !== undefined && !/^absent\b/i.test(rosterLine);

  return {
    recognized,
    running: !notRunning && pid !== undefined && !Number.isNaN(pid),
    pid: pid === undefined || Number.isNaN(pid) ? undefined : pid,
    version: field(raw, 'version'),
    uptime: field(raw, 'uptime'),
    origin: field(raw, 'origin'),
    socketDir: field(raw, 'sock dir'),
    controlSocketReachable: reachable,
    workerCount,
    rosterPresent,
    logPath: field(raw, 'log'),
    raw,
  };
}
