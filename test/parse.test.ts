/**
 * Parser tests, driven by fixtures recorded from a real Claude Code v2.1.220.
 *
 * The assertions that matter most are the ones about absence: interactive rows
 * with no `id` and no `state`, and a CLI that reports failure while exiting 0.
 * Those are the shapes that break naive integrations.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRoster, parseStartedSession, shortIdFor } from '../src/integration/parse/roster.js';
import { parseDaemonStatus } from '../src/integration/parse/daemon.js';
import {
  classifyOutput,
  detectUnknownAgentWarning,
  summarizeOutput,
} from '../src/integration/cli/errors.js';
import { compareVersions, parseVersion } from '../src/integration/cli/locate.js';
import { enrichSession } from '../src/integration/fs/jobs.js';
import type { JobStateFile } from '../src/integration/types.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string): string => readFileSync(path.join(fixtures, name), 'utf8');

describe('parseRoster', () => {
  const sessions = parseRoster(JSON.parse(readFixture('roster-mixed.json')));

  it('keeps interactive and background rows', () => {
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.kind === 'interactive')).toHaveLength(2);
    expect(sessions.filter((s) => s.kind === 'background')).toHaveLength(1);
  });

  it('leaves interactive rows without an id or state', () => {
    // Verified against v2.1.220: interactive entries carry only
    // {pid, cwd, kind, startedAt, sessionId, name}. Anything that assumes a
    // roster row is controllable breaks as soon as a terminal is open.
    const interactive = sessions.filter((s) => s.kind === 'interactive');
    for (const session of interactive) {
      expect(session.id).toBeUndefined();
      expect(session.state).toBeUndefined();
    }
  });

  it('reads state and id from background rows', () => {
    const background = sessions.find((s) => s.kind === 'background');
    expect(background?.id).toBe('e1f523d7');
    expect(background?.state).toBe('working');
    expect(background?.name).toBe('probe-job');
    expect(background?.startedAt?.getTime()).toBe(1785025576080);
  });

  it('derives cold from state, not from a missing pid', () => {
    // Verified against v2.1.220: a background session in state `working`
    // reports NO pid — the supervisor hosts the process, so there is no CLI pid
    // to report. Treating a missing pid as dormant rendered an actively-working
    // agent with the cold/dashed styling.
    const working = parseRoster([{ id: 'aaaaaaaa', kind: 'background', state: 'working' }]);
    expect(working[0]?.pid).toBeUndefined();
    expect(working[0]?.cold).toBe(false);

    // Waiting on a person is still a hosted process.
    expect(parseRoster([{ id: 'b', kind: 'background', state: 'blocked' }])[0]?.cold).toBe(false);

    // Terminal states have no live process; attach/peek/reply restarts them.
    for (const state of ['done', 'failed', 'stopped']) {
      expect(parseRoster([{ id: 'c', kind: 'background', state }])[0]?.cold).toBe(true);
    }
  });

  it('does not mark a session dormant when the state is unknown', () => {
    // Failing toward "looks normal" beats falsely showing an agent asleep.
    expect(parseRoster([{ id: 'd', kind: 'background' }])[0]?.cold).toBe(false);
  });

  it('never marks an interactive row cold', () => {
    expect(parseRoster([{ kind: 'interactive', pid: 5 }])[0]?.cold).toBe(false);
  });

  it('drops unrecognised states rather than passing them through', () => {
    // The UI switches on state, so an unknown value must not reach it.
    expect(parseRoster([{ id: 'x', kind: 'background', state: 'quantum' }])[0]?.state).toBeUndefined();
  });

  it('passes through an unrecognised waitingFor', () => {
    // Research-preview surface: a new reason should render as text, not vanish.
    const parsed = parseRoster([{ id: 'x', kind: 'background', waitingFor: 'something new' }]);
    expect(parsed[0]?.waitingFor).toBe('something new');
  });

  it('returns an empty roster for malformed input', () => {
    expect(parseRoster(null)).toEqual([]);
    expect(parseRoster('nope')).toEqual([]);
    expect(parseRoster([null, 3, 'x'])).toEqual([]);
  });
});

describe('shortIdFor', () => {
  it('matches the daemon short id', () => {
    // Verified invariant: state.json recorded daemonShort 'e1f523d7' for
    // sessionId 'e1f523d7-e83b-46b8-9eca-538f4e74e609'.
    expect(shortIdFor('e1f523d7-e83b-46b8-9eca-538f4e74e609')).toBe('e1f523d7');
  });
});

describe('parseStartedSession', () => {
  it('reads the id past the cold-start preamble and hint lines', () => {
    const output = [
      'Starting background service…',
      'backgrounded · e1f523d7 · probe-job',
      '  claude agents             list sessions',
      '  claude attach e1f523d7    open in this terminal',
    ].join('\n');
    expect(parseStartedSession(output)).toEqual({ id: 'e1f523d7', name: 'probe-job' });
  });

  it('handles a dispatch with no name', () => {
    expect(parseStartedSession('backgrounded · abc12345')).toEqual({ id: 'abc12345', name: undefined });
  });

  it('returns null when no id is present', () => {
    expect(parseStartedSession('something went wrong')).toBeNull();
  });
});

describe('parseDaemonStatus', () => {
  it('reads a running daemon', () => {
    const status = parseDaemonStatus(readFixture('daemon-status-running.txt'));
    expect(status.recognized).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(9806);
    expect(status.version).toBe('2.1.220');
    expect(status.controlSocketReachable).toBe(true);
    expect(status.workerCount).toBe(1);
    expect(status.rosterPresent).toBe(true);
    expect(status.socketDir).toBe('/tmp/cc-daemon-501/1d662268');
  });

  it('reads a stopped daemon without treating it as an error', () => {
    // Service install is disabled in v2.1.220: the supervisor starts on demand
    // and exits when the last client disconnects, so this is the resting state.
    const status = parseDaemonStatus(readFixture('daemon-status-stopped.txt'));
    expect(status.recognized).toBe(true);
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
    expect(status.controlSocketReachable).toBe(false);
    expect(status.workerCount).toBe(0);
    expect(status.rosterPresent).toBe(false);
  });

  it('retains raw output for an unrecognised format', () => {
    const status = parseDaemonStatus('something entirely new');
    expect(status.recognized).toBe(false);
    expect(status.running).toBe(false);
    expect(status.raw).toBe('something entirely new');
  });
});

describe('classifyOutput', () => {
  it('detects an unknown session despite exit code 0', () => {
    // The reason this whole classifier exists.
    const raw = "No job matching 'zzzzzzzz'. Run 'claude agents' to list running sessions.";
    expect(classifyOutput(raw, 0)).toBe('unknown-session');
  });

  it('detects an unreachable supervisor', () => {
    const raw = "Couldn't read logs for e1f523d7 — connect ENOENT /tmp/cc-daemon-501/1d662268/control.sock";
    expect(classifyOutput(raw, 0)).toBe('daemon-unreachable');
  });

  it('prefers the actionable half when both a bad id and a down daemon appear', () => {
    const raw = "No job matching 'zz'. connect ENOENT /tmp/x/control.sock";
    expect(classifyOutput(raw, 0)).toBe('unknown-session');
  });

  it('accepts successful output', () => {
    expect(classifyOutput('stopped e1f523d7', 0)).toBeNull();
    expect(classifyOutput('removed e1f523d7', 0)).toBeNull();
  });

  it('treats an unrecognised non-zero exit as a failure', () => {
    expect(classifyOutput('mystery', 3)).toBe('cli-error');
  });
});

describe('detectUnknownAgentWarning', () => {
  it('catches a silently-substituted default agent', () => {
    // v2.1.220 only warns here and dispatches anyway, so a roster typo would
    // otherwise produce a live session running the wrong agent.
    const raw = "warning: no agent named '__no_such_agent__' — spawning with default template";
    expect(detectUnknownAgentWarning(raw)).toBe('__no_such_agent__');
  });

  it('returns null for a clean dispatch', () => {
    expect(detectUnknownAgentWarning('backgrounded · abc12345 · Arden')).toBeNull();
  });
});

describe('summarizeOutput', () => {
  it('prefers the diagnostic line', () => {
    expect(summarizeOutput('Starting background service…\nNo job matching \'x\'.', 'fallback')).toBe(
      "No job matching 'x'.",
    );
  });

  it('falls back when output is empty', () => {
    expect(summarizeOutput('   \n  ', 'fallback')).toBe('fallback');
  });
});

describe('version handling', () => {
  it('parses the version banner', () => {
    expect(parseVersion('2.1.220 (Claude Code)')).toBe('2.1.220');
  });

  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('2.1.220', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2.1.220', '2.1.220')).toBe(0);
    expect(compareVersions('2.0.999', '2.1.0')).toBeLessThan(0);
  });
});

describe('enrichSession', () => {
  const job = JSON.parse(readFixture('job-state-exec-done.json')) as JobStateFile;
  const base = parseRoster([
    { id: 'e1f523d7', kind: 'background', state: 'working', pid: 123, startedAt: 1785025576080 },
  ])[0]!;

  it('adds detail and intent the roster does not carry', () => {
    const merged = enrichSession(base, job, false);
    expect(merged.detail).toBe('hello-from-probe');
    expect(merged.intent).toBe('echo hello-from-probe; sleep 20');
    expect(merged.source).toBe('roster+jobfile');
  });

  it('keeps the roster state, which is the live view', () => {
    // The job file says 'done' while the roster says 'working'. The roster wins:
    // state.json can lag a session that was just stopped.
    const merged = enrichSession(base, job, false);
    expect(merged.state).toBe('working');
  });

  it('fills a missing state from the job file', () => {
    const stateless = parseRoster([{ id: 'e1f523d7', kind: 'background' }])[0]!;
    expect(enrichSession(stateless, job, false).state).toBe('done');
  });

  it('recomputes cold once the job file supplies the state', () => {
    // The roster row had no state, so it was not marked dormant. The job file
    // says `done`, which is terminal — the merged session must become cold.
    const stateless = parseRoster([{ id: 'e1f523d7', kind: 'background' }])[0]!;
    expect(stateless.cold).toBe(false);
    expect(enrichSession(stateless, job, false).cold).toBe(true);
  });

  it('treats a pinned session as never cold', () => {
    // Pinned sessions are exempt from the ~1h idle stop.
    const cold = parseRoster([{ id: 'e1f523d7', kind: 'background', state: 'stopped' }])[0]!;
    expect(cold.cold).toBe(true);
    expect(enrichSession(cold, job, true).cold).toBe(false);
    expect(enrichSession(cold, job, true).pinned).toBe(true);
    // Also with no job file at all.
    expect(enrichSession(cold, undefined, true).cold).toBe(false);
  });
});
