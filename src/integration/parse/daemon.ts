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
 * A stopped daemon is the ordinary resting state, not a fault: service install
 * is disabled in this version, so the supervisor starts on demand and exits
 * when the last client disconnects. The UI must not present it as broken.
 */

import type { DaemonStatus } from '../types.js';

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
