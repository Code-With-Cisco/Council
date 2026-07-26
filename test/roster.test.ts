/**
 * Unified-roster tests.
 *
 * The merge is where three incomplete sources become the squad screen, so these
 * cover the cases that would otherwise show a specialist as missing while it is
 * plainly running, or show a stale completed run in place of the live one.
 */

import { describe, expect, it } from 'vitest';
import {
  buildUnifiedRoster,
  membersNeedingStart,
  membersNeedingWake,
} from '../src/integration/roster/unified.js';
import {
  defaultRosterConfig,
  mergeDiscoveredAgents,
  parseRosterConfig,
} from '../src/integration/roster/config.js';
import { parseRoster } from '../src/integration/parse/roster.js';
import type { JobsSnapshot } from '../src/integration/fs/jobs.js';
import type { AgentDefinition } from '../src/integration/fs/agentDefs.js';
import type { RosterConfig } from '../src/integration/types.js';

const emptyJobs: JobsSnapshot = { states: new Map(), pinned: new Set(), problems: [] };

const config: RosterConfig = {
  version: 1,
  members: [
    { key: 'arden', label: 'Arden', agent: 'arden', cwd: '/work/meridian' },
    { key: 'bram', label: 'Bram', agent: 'bram', cwd: '/work/meridian' },
  ],
  pollIntervalMs: 10_000,
};

describe('buildUnifiedRoster', () => {
  it('links a session to a specialist by name', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'aaaaaaaa', kind: 'background', name: 'Arden', state: 'working', pid: 1 },
      ]),
      jobs: emptyJobs,
      teams: [],
    });

    expect(roster.squad[0]?.session?.id).toBe('aaaaaaaa');
    expect(roster.squad[0]?.missing).toBe(false);
    expect(roster.squad[1]?.missing).toBe(true);
  });

  it('matches case-insensitively and by key', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([{ id: 'aaaaaaaa', kind: 'background', name: 'bram', pid: 1 }]),
      jobs: emptyJobs,
      teams: [],
    });
    expect(roster.squad[1]?.session?.id).toBe('aaaaaaaa');
  });

  it('never claims an interactive row', () => {
    // Interactive rows have no id, so acting on one is impossible — and a
    // terminal the user opened in the project directory is not a specialist.
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { kind: 'interactive', cwd: '/work/meridian', pid: 9, name: 'Arden' },
      ]),
      jobs: emptyJobs,
      teams: [],
    });
    expect(roster.squad[0]?.missing).toBe(true);
    expect(roster.unassigned).toHaveLength(0);
  });

  it('prefers the most recently started matching background session', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'old00000', kind: 'background', name: 'Arden', state: 'done', startedAt: 2_000 },
        { id: 'live0000', kind: 'background', name: 'Arden', state: 'working', pid: 7, startedAt: 1_000 },
      ]),
      jobs: emptyJobs,
      teams: [],
    });
    expect(roster.squad[0]?.session?.id).toBe('old00000');
  });

  it('prefers the most recent when neither has a live process', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'older000', kind: 'background', name: 'Arden', state: 'done', startedAt: 1_000 },
        { id: 'newer000', kind: 'background', name: 'Arden', state: 'stopped', startedAt: 5_000 },
      ]),
      jobs: emptyJobs,
      teams: [],
    });
    expect(roster.squad[0]?.session?.id).toBe('newer000');
  });

  it('reports unclaimed background sessions instead of hiding them', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'zzzzzzzz', kind: 'background', name: 'some-other-task', pid: 3 },
      ]),
      jobs: emptyJobs,
      teams: [],
    });
    expect(roster.unassigned.map((s) => s.id)).toEqual(['zzzzzzzz']);
  });

  it('never assigns one unnamed cwd-matched session to multiple agents', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'onejob00', kind: 'background', cwd: '/work/meridian', state: 'working' },
      ]),
      jobs: emptyJobs,
      teams: [],
    });

    expect(roster.squad[0]?.session?.id).toBe('onejob00');
    expect(roster.squad[1]?.missing).toBe(true);
  });

  it('surfaces a session that has a job file but no roster row', () => {
    // `agents --json` can drop a session whose process is gone. Keeping it
    // visible means a specialist card goes dormant rather than disappearing.
    const jobs: JobsSnapshot = {
      states: new Map([
        ['ghost000', { state: 'done', name: 'Arden', detail: 'finished earlier', cwd: '/work/meridian' }],
      ]),
      pinned: new Set(),
      problems: [],
    };
    const roster = buildUnifiedRoster({ config, rosterSessions: [], jobs, teams: [] });

    expect(roster.squad[0]?.session?.id).toBe('ghost000');
    expect(roster.squad[0]?.session?.source).toBe('jobfile');
    expect(roster.squad[0]?.session?.detail).toBe('finished earlier');
  });

  it('propagates parse problems for the needs-attention state', () => {
    const jobs: JobsSnapshot = {
      states: new Map(),
      pinned: new Set(),
      problems: [{ path: '/x/state.json', message: 'Unexpected end of JSON input' }],
    };
    const roster = buildUnifiedRoster({ config, rosterSessions: [], jobs, teams: [] });
    expect(roster.problems).toHaveLength(1);
  });
});

describe('membersNeedingStart / membersNeedingWake', () => {
  it('lists specialists with no session', () => {
    const roster = buildUnifiedRoster({ config, rosterSessions: [], jobs: emptyJobs, teams: [] });
    expect(membersNeedingStart(roster).map((m) => m.key)).toEqual(['arden', 'bram']);
  });

  it('separates the machine-restart case from the missing case', () => {
    // After a shutdown every session reads `failed`. Those need a visible
    // "wake the squad" action, not an automatic start.
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'aaaaaaaa', kind: 'background', name: 'Arden', state: 'failed' },
      ]),
      jobs: emptyJobs,
      teams: [],
    });

    expect(membersNeedingStart(roster).map((m) => m.key)).toEqual(['bram']);
    expect(membersNeedingWake(roster).map((s) => s.member.key)).toEqual(['arden']);
  });
});

describe('parseRosterConfig', () => {
  const fallback = defaultRosterConfig('/home/project');

  it('accepts a valid config', () => {
    const loaded = parseRosterConfig(
      { version: 1, members: [{ key: 'arden', agent: 'arden', cwd: '/work' }] },
      fallback,
    );
    expect(loaded.problems).toEqual([]);
    expect(loaded.config.members[0]?.label).toBe('arden');
  });

  it('reports missing fields and skips the member', () => {
    const loaded = parseRosterConfig(
      { members: [{ key: 'arden' }, { key: 'bram', agent: 'bram', cwd: '/work' }] },
      fallback,
    );
    expect(loaded.problems.join(' ')).toContain('missing "agent"');
    expect(loaded.config.members.map((m) => m.key)).toEqual(['bram']);
  });

  it('rejects duplicate keys, which would collide on one identity slot', () => {
    const loaded = parseRosterConfig(
      {
        members: [
          { key: 'arden', agent: 'a', cwd: '/w' },
          { key: 'arden', agent: 'b', cwd: '/w' },
        ],
      },
      fallback,
    );
    expect(loaded.problems.join(' ')).toContain('duplicate member key');
    expect(loaded.config.members).toHaveLength(1);
  });

  it('floors a dangerously small poll interval', () => {
    // A typo of 10 would spawn a CLI process every 10ms and read as a hang.
    const loaded = parseRosterConfig(
      { members: [{ key: 'a', agent: 'a', cwd: '/w' }], pollIntervalMs: 10 },
      fallback,
    );
    expect(loaded.config.pollIntervalMs).toBe(10_000);
    expect(loaded.problems.join(' ')).toContain('pollIntervalMs');
  });

  it('falls back rather than throwing on unusable input and accepts empty preferences', () => {
    expect(parseRosterConfig('nope', fallback).config).toBe(fallback);
    expect(parseRosterConfig({ members: [] }, fallback).config.members).toEqual([]);
  });
});

describe('mergeDiscoveredAgents', () => {
  const definition = (
    name: string,
    scope: AgentDefinition['scope'] = 'project',
  ): AgentDefinition => ({
    name,
    description: `${name} role`,
    model: name === 'builder' ? 'sonnet' : undefined,
    file: `/work/.claude/agents/${name}.md`,
    scope,
  });

  it('starts with no fictional roster members', () => {
    expect(defaultRosterConfig('/work').members).toEqual([]);
  });

  it('adds effective discovered definitions as deterministic on-demand profiles', () => {
    const merged = mergeDiscoveredAgents(
      defaultRosterConfig('/work'),
      [definition('prd-lead'), definition('builder'), definition('builder', 'user')],
      '/work',
    );

    expect(merged.config.members.map((member) => member.agent)).toEqual(['builder', 'prd-lead']);
    expect(merged.config.members.map((member) => member.label)).toEqual(['Builder', 'PRD Lead']);
    expect(merged.config.members[0]?.key).toBe('agent:builder');
    expect(merged.config.members[0]?.model).toBe('sonnet');
    expect(merged.discoveredAgents).toEqual(['builder', 'prd-lead']);
  });

  it('preserves configured overrides and adds only new definitions', () => {
    const saved: RosterConfig = {
      version: 1,
      members: [
        {
          key: 'build-main',
          label: 'Forge',
          agent: 'builder',
          cwd: '/other',
          bootPrompt: 'Wait for work.',
        },
      ],
      pollIntervalMs: 5_000,
    };
    const merged = mergeDiscoveredAgents(
      saved,
      [definition('builder'), definition('reviewer')],
      '/work',
    );

    expect(merged.config.members[0]).toEqual(saved.members[0]);
    expect(merged.config.members.map((member) => member.agent)).toEqual(['builder', 'reviewer']);
    expect(merged.config.pollIntervalMs).toBe(5_000);
  });

  it('ignores the obsolete generated placeholder roster when definitions do not support it', () => {
    const legacy: RosterConfig = {
      version: 1,
      members: ['arden', 'bram', 'rook', 'tess', 'sage'].map((agent) => ({
        key: agent,
        label: `${agent[0]?.toUpperCase() ?? ''}${agent.slice(1)}`,
        agent,
        cwd: '/work',
      })),
      pollIntervalMs: 10_000,
    };
    const merged = mergeDiscoveredAgents(legacy, [definition('builder')], '/work');

    expect(merged.ignoredLegacyPlaceholders).toBe(true);
    expect(merged.config.members.map((member) => member.agent)).toEqual(['builder']);
  });
});
