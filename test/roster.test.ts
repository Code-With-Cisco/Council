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
import type { RosterConfig, SessionBindingRef } from '../src/integration/types.js';

const emptyJobs: JobsSnapshot = { states: new Map(), pinned: new Set(), problems: [] };

const config: RosterConfig = {
  version: 1,
  members: [
    { key: 'arden', label: 'Arden', agent: 'arden', cwd: '/work/meridian' },
    { key: 'bram', label: 'Bram', agent: 'bram', cwd: '/work/meridian' },
  ],
  pollIntervalMs: 10_000,
};

function binding(
  profileId: string,
  shortSessionId: string,
  fullSessionId?: string,
): SessionBindingRef {
  return {
    providerId: 'claude-code',
    workspaceId: 'workspace-test',
    profileId,
    shortSessionId,
    ...(fullSessionId === undefined ? {} : { fullSessionId }),
    uniqueLaunchName: `dc-${profileId}`,
    agentName: profileId,
    catalogId: `catalog-${profileId}`,
    definitionFingerprint: 'a'.repeat(64),
    requestedCanonicalCwd: '/work/meridian',
    createdAt: '2026-07-26T00:00:00.000Z',
    lastConfirmedAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('buildUnifiedRoster', () => {
  it('links a session only by its exact persisted short id', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'aaaaaaaa', kind: 'background', name: 'unrelated label', state: 'working', pid: 1 },
      ]),
      jobs: emptyJobs,
      teams: [],
      bindings: new Map([['arden', binding('arden', 'aaaaaaaa')]]),
    });

    expect(roster.squad[0]?.session?.id).toBe('aaaaaaaa');
    expect(roster.squad[0]?.missing).toBe(false);
    expect(roster.squad[0]?.bindingState).toBe('active');
    expect(roster.squad[1]?.missing).toBe(true);
  });

  it('never claims by a matching label or key', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'aaaaaaaa', kind: 'background', name: 'Arden', cwd: '/work/meridian', pid: 1 },
      ]),
      jobs: emptyJobs,
      teams: [],
    });
    expect(roster.squad.every((slot) => slot.session === undefined)).toBe(true);
    expect(roster.unassigned.map((session) => session.id)).toEqual(['aaaaaaaa']);
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

  it('uses a full id as the authoritative binding identity', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        {
          id: 'same0000',
          sessionId: 'same0000-correct',
          kind: 'background',
          state: 'working',
        },
      ]),
      jobs: emptyJobs,
      teams: [],
      bindings: new Map([
        ['arden', binding('arden', 'same0000', 'same0000-correct')],
      ]),
    });
    expect(roster.squad[0]?.session?.sessionId).toBe('same0000-correct');
  });

  it('does not fall back to a colliding short id when the full id differs', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        {
          id: 'same0000',
          sessionId: 'same0000-other',
          kind: 'background',
          state: 'working',
        },
      ]),
      jobs: emptyJobs,
      teams: [],
      bindings: new Map([
        ['arden', binding('arden', 'same0000', 'same0000-correct')],
      ]),
    });
    expect(roster.squad[0]?.session).toBeUndefined();
    expect(roster.squad[0]?.staleBinding).toBe(true);
    expect(roster.unassigned.map((session) => session.sessionId)).toEqual(['same0000-other']);
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

  it('two profiles with the same label and cwd never claim one another', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: parseRoster([
        { id: 'arden000', kind: 'background', name: 'Same', cwd: '/work/meridian', state: 'working' },
        { id: 'bram0000', kind: 'background', name: 'Same', cwd: '/work/meridian', state: 'working' },
      ]),
      jobs: emptyJobs,
      teams: [],
      bindings: new Map([
        ['arden', binding('arden', 'arden000')],
        ['bram', binding('bram', 'bram0000')],
      ]),
    });

    expect(roster.squad.map((slot) => slot.session?.id)).toEqual(['arden000', 'bram0000']);
  });

  it('ignores a binding from another workspace even when the profile id collides', () => {
    const workspaceConfig: RosterConfig = {
      ...config,
      members: [{ ...config.members[0]!, workspaceId: 'workspace-active' }],
    };
    const foreign = {
      ...binding('arden', 'foreign1'),
      workspaceId: 'workspace-foreign',
    };
    const roster = buildUnifiedRoster({
      config: workspaceConfig,
      rosterSessions: parseRoster([
        { id: 'foreign1', kind: 'background', state: 'working' },
      ]),
      jobs: emptyJobs,
      teams: [],
      bindings: new Map([['arden', foreign]]),
    });

    expect(roster.squad[0]?.binding).toBeUndefined();
    expect(roster.squad[0]?.bindingState).toBe('none');
    expect(roster.unassigned.map((session) => session.id)).toEqual(['foreign1']);
  });

  it('does not call an unverified offline binding stale', () => {
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: [],
      jobs: emptyJobs,
      teams: [],
      bindings: new Map([['arden', binding('arden', 'offline1')]]),
      rosterAvailable: false,
    });

    expect(roster.squad[0]?.bindingState).toBe('unavailable');
    expect(roster.squad[0]?.staleBinding).toBe(false);
  });

  it('treats a job-file-only exact id as a stale binding and keeps its history unassigned', () => {
    // `agents --json --all` is the authoritative action surface. A leftover
    // state file stays visible as read-only evidence but cannot make Resume or
    // Logs appear usable, and it must not hide the safe Clear-binding action.
    const jobs: JobsSnapshot = {
      states: new Map([
        ['ghost000', { state: 'done', name: 'Arden', detail: 'finished earlier', cwd: '/work/meridian' }],
      ]),
      pinned: new Set(),
      problems: [],
    };
    const roster = buildUnifiedRoster({
      config,
      rosterSessions: [],
      jobs,
      teams: [],
      bindings: new Map([['arden', binding('arden', 'ghost000')]]),
    });

    expect(roster.squad[0]?.session).toBeUndefined();
    expect(roster.squad[0]?.bindingState).toBe('stale');
    expect(roster.squad[0]?.staleBinding).toBe(true);
    expect(roster.unassigned).toEqual([
      expect.objectContaining({
        id: 'ghost000',
        source: 'jobfile',
        detail: 'finished earlier',
      }),
    ]);
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
      bindings: new Map([['arden', binding('arden', 'aaaaaaaa')]]),
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
    expect(loaded.config.members.map((m) => m.legacyKey)).toEqual(['bram']);
    expect(loaded.config.members[0]?.key).toMatch(/^profile-v1-/);
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
    expect(loaded.problems.join(' ')).toContain('duplicate profile id');
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
    expect(merged.config.members[0]?.key).toMatch(/^profile-virtual-/);
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
