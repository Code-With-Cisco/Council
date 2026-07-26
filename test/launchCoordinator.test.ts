import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  StartSessionOutcome,
  StartSessionRequest,
} from '../src/integration/client.js';
import type { CliFailure, CliResult, RosterMember, Session } from '../src/integration/types.js';
import {
  SafeLaunchCoordinator,
  type LaunchClient,
} from '../src/supervisor/launchCoordinator.js';
import {
  SessionBindingStore,
  type SessionBindingRecord,
} from '../src/supervisor/sessionBindings.js';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'council-launch-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cliFailure(kind: CliFailure['kind'], message: string): CliFailure {
  return {
    ok: false,
    kind,
    message,
    raw: message,
    argv: ['--bg'],
    exitCode: null,
    durationMs: 1,
  };
}

function session(
  id: string,
  name: string,
  cwd: string,
  state: Session['state'] = 'working',
): Session {
  return {
    id,
    sessionId: `${id}-full-session`,
    name,
    kind: 'background',
    state,
    waitingFor: undefined,
    status: undefined,
    detail: undefined,
    cwd,
    startedAt: new Date(),
    updatedAt: new Date(),
    pid: undefined,
    cold: state === 'done' || state === 'failed' || state === 'stopped',
    pinned: false,
    intent: undefined,
    source: 'roster',
  };
}

interface Fixture {
  readonly coordinator: SafeLaunchCoordinator;
  readonly store: SessionBindingStore;
  readonly client: LaunchClient;
  readonly starts: ReturnType<typeof vi.fn<(request: StartSessionRequest) => Promise<CliResult<StartSessionOutcome>>>>;
  readonly stops: ReturnType<typeof vi.fn<(id: string) => Promise<CliResult<string>>>>;
  readonly respawns: ReturnType<typeof vi.fn<(id: string) => Promise<CliResult<string>>>>;
  readonly verifyCapability: ReturnType<
    typeof vi.fn<() => Promise<CliResult<unknown>>>
  >;
  readonly refresh: ReturnType<
    typeof vi.fn<() => Promise<readonly Session[]>>
  >;
  readonly sessions: Session[];
  readonly profile: RosterMember;
}

async function fixture(
  overrides: {
    readonly start?: ((request: StartSessionRequest, sessions: Session[]) => Promise<CliResult<StartSessionOutcome>>) | undefined;
    readonly profile?: Partial<RosterMember> | undefined;
    readonly atomicWrite?: ((file: string, text: string) => Promise<void>) | undefined;
    readonly verifyCapability?: (() => Promise<CliResult<unknown>>) | undefined;
    readonly resolveProfile?: ((
      id: string,
      profile: RosterMember,
    ) => RosterMember | undefined) | undefined;
  } = {},
): Promise<Fixture> {
  const workspace = await tempWorkspace();
  const canonicalWorkspace = await realpath(workspace);
  const profile: RosterMember = {
    key: 'profile-12345678',
    label: 'Builder',
    agent: 'builder',
    cwd: workspace,
    workspaceId: 'ws_11111111-1111-4111-8111-111111111111',
    catalogId: 'catalog-12345678',
    definitionFingerprint: fingerprint,
    configured: true,
    ...overrides.profile,
  };
  const sessions: Session[] = [];
  let nextId = 1;
  const startImplementation =
    overrides.start ??
    (async (request: StartSessionRequest): Promise<CliResult<StartSessionOutcome>> => {
      const id = `start${String(nextId++).padStart(3, '0')}`;
      sessions.push(session(id, request.name ?? '', request.cwd));
      return {
        ok: true,
        value: { id, name: request.name, unknownAgent: undefined },
        raw: `backgrounded · ${id} · ${request.name ?? ''}`,
        argv: ['--bg'],
        durationMs: 1,
      };
    });
  const starts = vi.fn((request: StartSessionRequest) => startImplementation(request, sessions));
  const stops = vi.fn(async (id: string): Promise<CliResult<string>> => ({
    ok: true,
    value: `stopped ${id}`,
    raw: '',
    argv: ['stop', id],
    durationMs: 1,
  }));
  const respawns = vi.fn(async (id: string): Promise<CliResult<string>> => ({
    ok: true,
    value: `respawned ${id}`,
    raw: '',
    argv: ['respawn', id],
    durationMs: 1,
  }));
  const client: LaunchClient = {
    start: starts,
    listSessions: async () => ({
      ok: true,
      value: [...sessions],
      raw: '',
      argv: ['agents', '--json', '--all'],
      durationMs: 1,
    }),
    stop: stops,
    respawn: respawns,
  };
  const verifyCapability = vi.fn(
    overrides.verifyCapability ??
      (async (): Promise<CliResult<unknown>> => ({
        ok: true,
        value: 'ready',
        raw: '',
        argv: ['--version'],
        durationMs: 1,
      })),
  );
  const store = new SessionBindingStore(path.join(workspace, 'userData', 'session-bindings.json'), {
    ...(overrides.atomicWrite === undefined ? {} : { atomicWrite: overrides.atomicWrite }),
  });
  await store.load();
  const refresh = vi.fn(async (): Promise<readonly Session[]> => [...sessions]);
  const coordinator = new SafeLaunchCoordinator({
    client,
    bindings: store,
    workspace: {
      id: profile.workspaceId!,
      canonicalPath: canonicalWorkspace,
      trusted: true,
    },
    resolveProfile: (id) =>
      overrides.resolveProfile === undefined
        ? id === profile.key
          ? profile
          : undefined
        : overrides.resolveProfile(id, profile),
    resolveDefinition: async () => ({
      catalogId: profile.catalogId!,
      agentName: profile.agent,
      fingerprint,
      launchable: true,
      definitionPath: path.join(workspace, '.claude', 'agents', 'builder.md'),
    }),
    verifyCapability,
    refresh,
    uniqueId: () => 'unique-transaction',
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });
  return {
    coordinator,
    store,
    client,
    starts,
    stops,
    respawns,
    verifyCapability,
    refresh,
    sessions,
    profile,
  };
}

function boundRecord(profile: RosterMember, id: string, cwd: string): SessionBindingRecord {
  return {
    providerId: 'claude-code',
    workspaceId: profile.workspaceId!,
    profileId: profile.key,
    shortSessionId: id,
    fullSessionId: `${id}-full-session`,
    uniqueLaunchName: `dc-old-${id}`,
    agentName: profile.agent,
    catalogId: profile.catalogId!,
    definitionFingerprint: fingerprint,
    requestedCanonicalCwd: cwd,
    actualCanonicalCwd: cwd,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastConfirmedAt: '2026-07-26T10:00:00.000Z',
  };
}

describe('SafeLaunchCoordinator', () => {
  it('coalesces simultaneous card/pixel Starts into one provider launch', async () => {
    const f = await fixture();
    const [card, pixel] = await Promise.all([
      f.coordinator.startProfile(f.profile.key),
      f.coordinator.startProfile(f.profile.key),
    ]);

    expect(card.ok).toBe(true);
    expect(pixel).toEqual(card);
    expect(f.starts).toHaveBeenCalledOnce();
    expect(f.store.getBinding(f.profile.key)?.shortSessionId).toBe('start001');
  });

  it('returns an already-active exact binding without launching again', async () => {
    const f = await fixture();
    const existing = session('existing', 'not-the-profile-label', f.profile.cwd);
    f.sessions.push(existing);
    await f.store.setBinding(boundRecord(f.profile, 'existing', f.profile.cwd));

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok && result.value.id).toBe('existing');
    expect(f.starts).not.toHaveBeenCalled();
  });

  it('blocks an unknown profile and a fingerprint change before spawn', async () => {
    const f = await fixture({ profile: { definitionFingerprint: 'b'.repeat(64) } });
    expect((await f.coordinator.startProfile('profile-unknown')).ok).toBe(false);
    const changed = await f.coordinator.startProfile(f.profile.key);
    expect(changed.ok).toBe(false);
    expect(!changed.ok && changed.message).toContain('changed after it was displayed');
    expect(f.starts).not.toHaveBeenCalled();
  });

  it('rejects a stale renderer fingerprint inside the launch transaction', async () => {
    const f = await fixture();

    const result = await f.coordinator.startProfile(f.profile.key, {
      expectedDefinitionFingerprint: 'b'.repeat(64),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(
      'changed after this action was displayed',
    );
    expect(f.verifyCapability).not.toHaveBeenCalled();
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
  });

  it('rechecks provider capability after definition validation and before spawn', async () => {
    const f = await fixture({
      verifyCapability: async () => cliFailure('not-authenticated', 'login required'),
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('not-authenticated');
    expect(f.verifyCapability).toHaveBeenCalledOnce();
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
  });

  it('keeps prompt injection text in one typed request field', async () => {
    const f = await fixture();
    const prompt = 'Review "C:\\Program Files"; Remove-Item remains text.';
    await f.coordinator.startProfile(f.profile.key, { promptOverride: prompt });
    expect(f.starts.mock.calls[0]?.[0].prompt).toBe(prompt);
    expect(f.starts.mock.calls[0]?.[0].name).toMatch(/^dc-/);
  });

  it('retains the launch journal and stops nothing when the acknowledged short id is ambiguous', async () => {
    const f = await fixture({
      start: async (request, sessions) => {
        const first = session(
          'duplicate-ack',
          request.name ?? '',
          request.cwd,
        );
        sessions.push(
          first,
          {
            ...first,
            sessionId: 'duplicate-ack-other-full-session',
          },
        );
        return {
          ok: true,
          value: {
            id: 'duplicate-ack',
            name: request.name,
            unknownAgent: undefined,
          },
          raw: 'backgrounded · duplicate-ack',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('malformed-output');
    expect(!result.ok && result.message).toContain(
      'No session was stopped or bound',
    );
    expect(f.stops).not.toHaveBeenCalled();
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    const retained = f.store.getPendingLaunch(f.profile.key);
    expect(retained).toMatchObject({
      profileId: f.profile.key,
      uniqueLaunchName: expect.stringMatching(/^dc-/),
    });
    expect(retained?.disposition).toBeUndefined();
  });

  it('stops only a newly substituted default-agent session and never binds it', async () => {
    const f = await fixture({
      start: async (request, sessions) => {
        sessions.push(session('wrong001', request.name ?? '', request.cwd));
        return {
          ok: true,
          value: { id: 'wrong001', name: request.name, unknownAgent: 'builder' },
          raw: 'warning: no agent named builder',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(f.stops).toHaveBeenCalledExactlyOnceWith('wrong001');
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
  });

  it('stops nothing and retains rejection evidence when a substituted launch target is ambiguous', async () => {
    const f = await fixture({
      start: async (request, sessions) => {
        const first = session(
          'duplicate-substitution',
          request.name ?? '',
          request.cwd,
        );
        sessions.push(
          first,
          {
            ...first,
            sessionId: 'duplicate-substitution-other-full-session',
          },
        );
        return {
          ok: true,
          value: {
            id: 'duplicate-substitution',
            name: request.name,
            unknownAgent: 'builder',
          },
          raw: 'warning: no agent named builder',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(f.stops).not.toHaveBeenCalled();
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(
      f.store.getPendingLaunch(f.profile.key)?.disposition,
    ).toBe('rejected-substitution');
    expect(!result.ok && result.message).toContain(
      'cleanup target is ambiguous',
    );
  });

  it('never reconciles a substituted agent after a malformed acknowledgement', async () => {
    const f = await fixture({
      start: async (request, sessions) => {
        sessions.push(session('wrong002', request.name ?? '', request.cwd));
        return {
          ...cliFailure('malformed-output', 'Could not parse acknowledgement'),
          raw: "Warning: no agent named 'builder' — using default agent",
        };
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(f.stops).toHaveBeenCalledExactlyOnceWith('wrong002');
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
  });

  it('retains a rejected-substitution journal when its roster cannot be read', async () => {
    const f = await fixture({
      start: async () => ({
        ...cliFailure('malformed-output', 'Could not parse acknowledgement'),
        raw: "Warning: no agent named 'builder' — using default agent",
      }),
    });
    vi.spyOn(f.client, 'listSessions')
      .mockResolvedValueOnce({
        ok: true,
        value: [],
        raw: '',
        argv: ['agents', '--json', '--all'],
        durationMs: 1,
      })
      .mockResolvedValueOnce(cliFailure('timeout', 'roster timed out'));

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(f.stops).not.toHaveBeenCalled();
    expect(f.store.getPendingLaunch(f.profile.key)?.disposition).toBe(
      'rejected-substitution',
    );
  });

  it('clears rejected-substitution evidence after an authoritative zero-match roster', async () => {
    let attempts = 0;
    const zero = await fixture({
      start: async (request, sessions) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ...cliFailure('malformed-output', 'Could not parse acknowledgement'),
            raw: "Warning: no agent named 'builder' — using default agent",
          };
        }
        sessions.push(session('retry-safe', request.name ?? '', request.cwd));
        return {
          ok: true,
          value: {
            id: 'retry-safe',
            name: request.name,
            unknownAgent: undefined,
          },
          raw: '',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });
    const first = await zero.coordinator.startProfile(zero.profile.key);
    expect(first.ok).toBe(false);
    expect(zero.store.getPendingLaunch(zero.profile.key)).toBeUndefined();
    expect(zero.stops).not.toHaveBeenCalled();

    const retry = await zero.coordinator.startProfile(zero.profile.key);
    expect(retry.ok).toBe(true);
    expect(zero.starts).toHaveBeenCalledTimes(2);
    expect(zero.store.getBinding(zero.profile.key)?.shortSessionId).toBe(
      'retry-safe',
    );
  });

  it('retains rejected-substitution evidence for ambiguous cleanup targets', async () => {
    const ambiguous = await fixture({
      start: async (request, sessions) => {
        sessions.push(
          session('wrong-a', request.name ?? '', request.cwd),
          session('wrong-b', request.name ?? '', request.cwd),
        );
        return {
          ...cliFailure('malformed-output', 'Could not parse acknowledgement'),
          raw: "Warning: no agent named 'builder' — using default agent",
        };
      },
    });
    await ambiguous.coordinator.startProfile(ambiguous.profile.key);
    expect(
      ambiguous.store.getPendingLaunch(ambiguous.profile.key)?.disposition,
    ).toBe('rejected-substitution');
    expect(ambiguous.stops).not.toHaveBeenCalled();
  });

  it('retains rejected substitution after stop failure and blocks duplicate retry', async () => {
    const f = await fixture({
      start: async (request, sessions) => {
        sessions.push(session('wrong-stop', request.name ?? '', request.cwd));
        return {
          ...cliFailure('malformed-output', 'Could not parse acknowledgement'),
          raw: "Warning: no agent named 'builder' — using default agent",
        };
      },
    });
    f.stops.mockResolvedValue(
      cliFailure('cli-error', 'provider refused cleanup'),
    );

    const first = await f.coordinator.startProfile(f.profile.key);
    const retry = await f.coordinator.startProfile(f.profile.key);

    expect(first.ok).toBe(false);
    expect(retry.ok).toBe(false);
    expect(f.starts).toHaveBeenCalledOnce();
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(f.store.getPendingLaunch(f.profile.key)?.disposition).toBe(
      'rejected-substitution',
    );
  });

  it('retries a transient disposition write failure before cleanup and restart', async () => {
    let writes = 0;
    const f = await fixture({
      atomicWrite: async (file, text) => {
        writes += 1;
        if (writes === 2) {
          throw new Error('transient rejection write failure');
        }
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text, 'utf8');
      },
      start: async (request, sessions) => {
        sessions.push(
          session('wrong-transient', request.name ?? '', request.cwd),
        );
        return {
          ...cliFailure('malformed-output', 'Could not parse acknowledgement'),
          raw: "Warning: no agent named 'builder' — using default agent",
        };
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);
    const restarted = new SessionBindingStore(f.store.file);
    await restarted.load();

    expect(result.ok).toBe(false);
    expect(writes).toBe(4);
    expect(f.stops).toHaveBeenCalledExactlyOnceWith('wrong-transient');
    expect(restarted.getBinding(f.profile.key)).toBeUndefined();
    expect(restarted.getPendingLaunch(f.profile.key)).toBeUndefined();
  });

  it('boot cleanup stops but never binds a durable rejected substitution', async () => {
    const f = await fixture();
    const canonicalCwd = await realpath(f.profile.cwd);
    const rejected = {
      providerId: 'claude-code' as const,
      workspaceId: f.profile.workspaceId!,
      profileId: f.profile.key,
      uniqueLaunchName: 'dc-rejected-substitution',
      agentName: f.profile.agent,
      catalogId: f.profile.catalogId!,
      definitionFingerprint: fingerprint,
      requestedCanonicalCwd: canonicalCwd,
      createdAt: '2026-07-26T11:00:00.000Z',
      disposition: 'rejected-substitution' as const,
    };
    await f.store.setPendingLaunch(rejected);
    f.sessions.push(
      session('rejected-cleanup', rejected.uniqueLaunchName, f.profile.cwd),
    );

    await f.coordinator.reconcilePendingLaunches();

    expect(f.stops).toHaveBeenCalledExactlyOnceWith('rejected-cleanup');
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
    expect(f.starts).not.toHaveBeenCalled();
  });

  it('does not stop or bind when an acknowledgement reuses a preexisting id', async () => {
    const f = await fixture({
      start: async (request) => ({
        ok: true,
        value: {
          id: 'existing',
          name: request.name,
          unknownAgent: 'builder',
        },
        raw: 'warning: no agent named builder',
        argv: ['--bg'],
        durationMs: 1,
      }),
    });
    f.sessions.push(session('existing', 'unrelated', f.profile.cwd));

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(f.stops).not.toHaveBeenCalled();
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
  });

  it('reconciles a timed-out acknowledgement by unique launch name and cwd', async () => {
    const f = await fixture({
      start: async (request, sessions) => {
        sessions.push(session('late0001', request.name ?? '', request.cwd));
        return cliFailure('timeout', 'launch timed out');
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok && result.value.id).toBe('late0001');
    expect(f.store.getBinding(f.profile.key)?.shortSessionId).toBe('late0001');
    expect(f.starts).toHaveBeenCalledOnce();
  });

  it('reconciles a crash journal on restart without launching again', async () => {
    const f = await fixture();
    const canonicalCwd = await realpath(f.profile.cwd);
    const pending = {
      providerId: 'claude-code' as const,
      workspaceId: f.profile.workspaceId!,
      profileId: f.profile.key,
      uniqueLaunchName: 'dc-crash-journal',
      agentName: f.profile.agent,
      catalogId: f.profile.catalogId!,
      definitionFingerprint: fingerprint,
      requestedCanonicalCwd: canonicalCwd,
      createdAt: '2026-07-26T11:00:00.000Z',
    };
    await f.store.setPendingLaunch(pending);
    f.sessions.push(session('crash001', pending.uniqueLaunchName, f.profile.cwd));

    await f.coordinator.reconcilePendingLaunches();

    expect(f.store.getBinding(f.profile.key)?.shortSessionId).toBe('crash001');
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
    expect(f.starts).not.toHaveBeenCalled();
  });

  it('does not adopt or launch when crash-journal evidence is ambiguous', async () => {
    const f = await fixture();
    const canonicalCwd = await realpath(f.profile.cwd);
    const pending = {
      providerId: 'claude-code' as const,
      workspaceId: f.profile.workspaceId!,
      profileId: f.profile.key,
      uniqueLaunchName: 'dc-ambiguous-journal',
      agentName: f.profile.agent,
      catalogId: f.profile.catalogId!,
      definitionFingerprint: fingerprint,
      requestedCanonicalCwd: canonicalCwd,
      createdAt: '2026-07-26T11:00:00.000Z',
    };
    await f.store.setPendingLaunch(pending);
    f.sessions.push(
      session('ambig001', pending.uniqueLaunchName, f.profile.cwd),
      session('ambig002', pending.uniqueLaunchName, f.profile.cwd),
    );

    await f.coordinator.reconcilePendingLaunches();

    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(f.store.getPendingLaunch(f.profile.key)).toEqual(pending);
    expect(f.starts).not.toHaveBeenCalled();
  });

  it('does not recover a stopped cleanup target from a leftover journal', async () => {
    const f = await fixture();
    const canonicalCwd = await realpath(f.profile.cwd);
    const pending = {
      providerId: 'claude-code' as const,
      workspaceId: f.profile.workspaceId!,
      profileId: f.profile.key,
      uniqueLaunchName: 'dc-rejected-journal',
      agentName: f.profile.agent,
      catalogId: f.profile.catalogId!,
      definitionFingerprint: fingerprint,
      requestedCanonicalCwd: canonicalCwd,
      createdAt: '2026-07-26T11:00:00.000Z',
    };
    await f.store.setPendingLaunch(pending);
    f.sessions.push(
      session('rejected1', pending.uniqueLaunchName, f.profile.cwd, 'stopped'),
    );

    await f.coordinator.reconcilePendingLaunches();

    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(f.store.getPendingLaunch(f.profile.key)).toEqual(pending);
  });

  it('attempts scoped cleanup when durable binding persistence fails', async () => {
    let writes = 0;
    const f = await fixture({
      atomicWrite: async (file, text) => {
        writes += 1;
        if (writes === 2) throw new Error('disk full');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text, 'utf8');
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('could not be persisted');
    expect(f.stops).toHaveBeenCalledExactlyOnceWith('start001');
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
  });

  it('Start new preserves the old conversation and replaces only the binding', async () => {
    const f = await fixture();
    f.sessions.push(session('old00001', 'old launch', f.profile.cwd, 'stopped'));
    await f.store.setBinding(boundRecord(f.profile, 'old00001', f.profile.cwd));

    const result = await f.coordinator.startProfile(f.profile.key, {
      replaceExisting: true,
    });

    expect(result.ok).toBe(true);
    expect(f.store.getBinding(f.profile.key)?.shortSessionId).toBe('start001');
    expect(f.stops).not.toHaveBeenCalled();
    expect(f.sessions.some((item) => item.id === 'old00001')).toBe(true);
  });

  it('serializes Clear behind an in-flight Start new and preserves its live binding', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const f = await fixture({
      start: async (request, sessions) => {
        startEntered();
        await startGate;
        sessions.push(session('queued01', request.name ?? '', request.cwd));
        return {
          ok: true,
          value: { id: 'queued01', name: request.name, unknownAgent: undefined },
          raw: '',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });
    await f.store.setBinding(boundRecord(f.profile, 'oldqueue', f.profile.cwd));

    const starting = f.coordinator.startProfile(f.profile.key, {
      replaceExisting: true,
    });
    await entered;
    const clearing = f.coordinator.clearBinding(f.profile.key);
    releaseStart();

    expect((await starting).ok).toBe(true);
    const clearResult = await clearing;
    expect(clearResult.ok).toBe(false);
    expect(!clearResult.ok && clearResult.message).toContain(
      'exact bound session still exists',
    );
    expect(f.store.getBinding(f.profile.key)?.shortSessionId).toBe('queued01');
  });

  it('uses compare-and-swap so an external binding edit is never clobbered', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const f = await fixture({
      start: async (request, sessions) => {
        startEntered();
        await startGate;
        sessions.push(session('casnew01', request.name ?? '', request.cwd));
        return {
          ok: true,
          value: { id: 'casnew01', name: request.name, unknownAgent: undefined },
          raw: '',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });
    await f.store.setBinding(boundRecord(f.profile, 'cas-old', f.profile.cwd));

    const starting = f.coordinator.startProfile(f.profile.key, {
      replaceExisting: true,
    });
    await entered;
    const external = boundRecord(f.profile, 'external', f.profile.cwd);
    await f.store.replaceBinding(external);
    releaseStart();
    const result = await starting;

    expect(result.ok).toBe(false);
    expect(f.store.getBinding(f.profile.key)).toEqual(external);
    expect(f.stops).toHaveBeenCalledExactlyOnceWith('casnew01');
  });

  it('aborts an exact-session action when the binding is replaced during roster read', async () => {
    const f = await fixture();
    f.sessions.push(session('action-old', 'old action target', f.profile.cwd));
    await f.store.setBinding(
      boundRecord(f.profile, 'action-old', f.profile.cwd),
    );
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    vi.spyOn(f.client, 'listSessions').mockImplementation(async () => {
      listEntered();
      await listGate;
      return {
        ok: true,
        value: [...f.sessions],
        raw: '',
        argv: ['agents', '--json', '--all'],
        durationMs: 1,
      };
    });
    const privilegedAction = vi.fn(async () => ({
      ok: true as const,
      value: 'acted',
      raw: '',
      argv: [],
      durationMs: 1,
    }));

    const resultPromise = f.coordinator.exactBoundSessionAction(
      f.profile.key,
      {
        actionName: 'Stop',
        missingMessage: 'missing exact binding',
        action: privilegedAction,
      },
    );
    await entered;
    const replacement = boundRecord(
      f.profile,
      'action-new',
      f.profile.cwd,
    );
    await f.store.replaceBinding(replacement);
    releaseList();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('binding changed');
    expect(privilegedAction).not.toHaveBeenCalled();
    expect(f.store.getBinding(f.profile.key)).toEqual(replacement);
  });

  it('aborts an exact-session action when the binding is cleared during roster read', async () => {
    const f = await fixture();
    const original = boundRecord(f.profile, 'action-clear', f.profile.cwd);
    f.sessions.push(
      session('action-clear', 'clear race target', f.profile.cwd),
    );
    await f.store.setBinding(original);
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    vi.spyOn(f.client, 'listSessions').mockImplementation(async () => {
      listEntered();
      await listGate;
      return {
        ok: true,
        value: [...f.sessions],
        raw: '',
        argv: ['agents', '--json', '--all'],
        durationMs: 1,
      };
    });
    const privilegedAction = vi.fn(async () => ({
      ok: true as const,
      value: 'acted',
      raw: '',
      argv: [],
      durationMs: 1,
    }));

    const resultPromise = f.coordinator.exactBoundSessionAction(
      f.profile.key,
      {
        actionName: 'Logs',
        missingMessage: 'missing exact binding',
        action: privilegedAction,
      },
    );
    await entered;
    await f.store.clearBinding(f.profile.key, original);
    releaseList();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('binding changed');
    expect(privilegedAction).not.toHaveBeenCalled();
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
  });

  it('rechecks profile authorization at exact-action and Resume CAS boundaries', async () => {
    let actionAuthorized = true;
    const actionFixture = await fixture({
      resolveProfile: (id, profile) =>
        actionAuthorized && id === profile.key ? profile : undefined,
    });
    actionFixture.sessions.push(
      session(
        'authorization-action',
        'authorization action',
        actionFixture.profile.cwd,
      ),
    );
    await actionFixture.store.setBinding(
      boundRecord(
        actionFixture.profile,
        'authorization-action',
        actionFixture.profile.cwd,
      ),
    );
    let releaseActionList!: () => void;
    const actionListGate = new Promise<void>((resolve) => {
      releaseActionList = resolve;
    });
    let actionListEntered!: () => void;
    const actionEntered = new Promise<void>((resolve) => {
      actionListEntered = resolve;
    });
    vi.spyOn(actionFixture.client, 'listSessions').mockImplementation(
      async () => {
        actionListEntered();
        await actionListGate;
        return {
          ok: true,
          value: [...actionFixture.sessions],
          raw: '',
          argv: [],
          durationMs: 1,
        };
      },
    );
    const action = vi.fn(async () => ({
      ok: true as const,
      value: 'acted',
      raw: '',
      argv: [],
      durationMs: 1,
    }));
    const actionResultPromise =
      actionFixture.coordinator.exactBoundSessionAction(
        actionFixture.profile.key,
        {
          actionName: 'Stop',
          missingMessage: 'missing',
          action,
        },
      );
    await actionEntered;
    actionAuthorized = false;
    releaseActionList();
    const actionResult = await actionResultPromise;
    expect(actionResult.ok).toBe(false);
    expect(!actionResult.ok && actionResult.message).toContain(
      'profile authorization changed',
    );
    expect(action).not.toHaveBeenCalled();

    let resumeAuthorized = true;
    const resumeFixture = await fixture({
      resolveProfile: (id, profile) =>
        resumeAuthorized && id === profile.key ? profile : undefined,
    });
    resumeFixture.sessions.push(
      session(
        'authorization-resume',
        'authorization resume',
        resumeFixture.profile.cwd,
        'failed',
      ),
    );
    await resumeFixture.store.setBinding(
      boundRecord(
        resumeFixture.profile,
        'authorization-resume',
        resumeFixture.profile.cwd,
      ),
    );
    let releaseResumeList!: () => void;
    const resumeListGate = new Promise<void>((resolve) => {
      releaseResumeList = resolve;
    });
    let resumeListEntered!: () => void;
    const resumeEntered = new Promise<void>((resolve) => {
      resumeListEntered = resolve;
    });
    vi.spyOn(resumeFixture.client, 'listSessions').mockImplementation(
      async () => {
        resumeListEntered();
        await resumeListGate;
        return {
          ok: true,
          value: [...resumeFixture.sessions],
          raw: '',
          argv: [],
          durationMs: 1,
        };
      },
    );
    const resumeResultPromise = resumeFixture.coordinator.resumeProfile(
      resumeFixture.profile.key,
    );
    await resumeEntered;
    resumeAuthorized = false;
    releaseResumeList();
    const resumeResult = await resumeResultPromise;
    expect(resumeResult.ok).toBe(false);
    expect(!resumeResult.ok && resumeResult.message).toContain(
      'profile authorization changed',
    );
    expect(resumeFixture.respawns).not.toHaveBeenCalled();
  });

  it('rechecks profile authorization after capability discovery before spawn', async () => {
    let authorized = true;
    let releaseCapability!: () => void;
    const capabilityGate = new Promise<void>((resolve) => {
      releaseCapability = resolve;
    });
    let capabilityEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      capabilityEntered = resolve;
    });
    const f = await fixture({
      resolveProfile: (id, profile) =>
        authorized && id === profile.key ? profile : undefined,
      verifyCapability: async () => {
        capabilityEntered();
        await capabilityGate;
        return {
          ok: true,
          value: 'ready',
          raw: '',
          argv: [],
          durationMs: 1,
        };
      },
    });

    const resultPromise = f.coordinator.startProfile(f.profile.key);
    await entered;
    authorized = false;
    releaseCapability();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(
      'profile authorization changed',
    );
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.store.getPendingLaunch(f.profile.key)).toBeUndefined();
  });

  it('Resume targets only the exact terminal binding', async () => {
    const f = await fixture();
    f.sessions.push(session('resume01', 'anything', f.profile.cwd, 'failed'));
    await f.store.setBinding(boundRecord(f.profile, 'resume01', f.profile.cwd));

    const result = await f.coordinator.resumeProfile(f.profile.key);

    expect(result.ok).toBe(true);
    expect(f.respawns).toHaveBeenCalledExactlyOnceWith('resume01');
  });

  it('blocks Resume when the binding document becomes malformed at the action boundary', async () => {
    const f = await fixture();
    f.sessions.push(session('resume02', 'anything', f.profile.cwd, 'failed'));
    await f.store.setBinding(boundRecord(f.profile, 'resume02', f.profile.cwd));

    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    vi.spyOn(f.client, 'listSessions').mockImplementation(async () => {
      listEntered();
      await listGate;
      return {
        ok: true,
        value: [...f.sessions],
        raw: '',
        argv: [],
        durationMs: 1,
      };
    });

    const resultPromise = f.coordinator.resumeProfile(f.profile.key);
    await entered;
    await writeFile(f.store.file, '{"version":1,"bindings":', 'utf8');
    releaseList();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('became unreadable');
    expect(f.respawns).not.toHaveBeenCalled();
  });

  it('clears a proven missing-session binding without a provider stop or deletion action', async () => {
    const f = await fixture();
    await f.store.setBinding(boundRecord(f.profile, 'clear001', f.profile.cwd));

    const result = await f.coordinator.clearBinding(f.profile.key);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toContain('not stopped or deleted');
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
    expect(f.stops).not.toHaveBeenCalled();
  });

  it.each([
    ['active', 'working'],
    ['terminal', 'done'],
  ] as const)(
    'refuses to clear an exact %s session binding',
    async (_label, state) => {
      const f = await fixture();
      f.sessions.push(
        session('clear-exact', 'exact clear target', f.profile.cwd, state),
      );
      const binding = boundRecord(
        f.profile,
        'clear-exact',
        f.profile.cwd,
      );
      await f.store.setBinding(binding);

      const result = await f.coordinator.clearBinding(f.profile.key);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain(
        'exact bound session still exists',
      );
      expect(f.store.getBinding(f.profile.key)).toEqual(binding);
      expect(f.stops).not.toHaveBeenCalled();
      expect(f.refresh).toHaveBeenCalledOnce();
    },
  );

  it('fails closed when duplicate or conflicting provider identities make staleness ambiguous', async () => {
    const f = await fixture();
    const binding = boundRecord(
      f.profile,
      'clear-ambiguous',
      f.profile.cwd,
    );
    const duplicate = session(
      'clear-ambiguous',
      'duplicate identity one',
      f.profile.cwd,
    );
    f.sessions.push(
      duplicate,
      {
        ...duplicate,
        name: 'duplicate identity two',
      },
    );
    await f.store.setBinding(binding);

    const result = await f.coordinator.clearBinding(f.profile.key);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('ambiguous candidates');
    expect(f.store.getBinding(f.profile.key)).toEqual(binding);
    expect(f.stops).not.toHaveBeenCalled();
  });

  it('fails closed on a provider roster outage', async () => {
    const f = await fixture();
    const binding = boundRecord(
      f.profile,
      'clear-outage',
      f.profile.cwd,
    );
    await f.store.setBinding(binding);
    vi.spyOn(f.client, 'listSessions').mockResolvedValue(
      cliFailure('daemon-unreachable', 'provider roster unavailable'),
    );

    const result = await f.coordinator.clearBinding(f.profile.key);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('daemon-unreachable');
    expect(f.store.getBinding(f.profile.key)).toEqual(binding);
    expect(f.stops).not.toHaveBeenCalled();
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  it('does not clear an external replacement made during the provider roster read', async () => {
    const f = await fixture();
    const original = boundRecord(
      f.profile,
      'clear-race-old',
      f.profile.cwd,
    );
    await f.store.setBinding(original);
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    vi.spyOn(f.client, 'listSessions').mockImplementation(async () => {
      listEntered();
      await listGate;
      return {
        ok: true,
        value: [],
        raw: '',
        argv: ['agents', '--json', '--all'],
        durationMs: 1,
      };
    });

    const clearing = f.coordinator.clearBinding(f.profile.key);
    await entered;
    const replacement = boundRecord(
      f.profile,
      'clear-race-new',
      f.profile.cwd,
    );
    await f.store.replaceBinding(replacement);
    releaseList();
    const result = await clearing;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('exact binding changed');
    expect(f.store.getBinding(f.profile.key)).toEqual(replacement);
    expect(f.stops).not.toHaveBeenCalled();
  });

  it('rechecks profile authorization immediately before clearing a proven stale binding', async () => {
    let authorized = true;
    const f = await fixture({
      resolveProfile: (id, profile) =>
        authorized && id === profile.key ? profile : undefined,
    });
    const binding = boundRecord(
      f.profile,
      'clear-profile-race',
      f.profile.cwd,
    );
    await f.store.setBinding(binding);
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    vi.spyOn(f.client, 'listSessions').mockImplementation(async () => {
      listEntered();
      await listGate;
      return {
        ok: true,
        value: [],
        raw: '',
        argv: ['agents', '--json', '--all'],
        durationMs: 1,
      };
    });

    const clearing = f.coordinator.clearBinding(f.profile.key);
    await entered;
    authorized = false;
    releaseList();
    const result = await clearing;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(
      'profile authorization changed',
    );
    expect(f.store.getBinding(f.profile.key)).toEqual(binding);
    expect(f.stops).not.toHaveBeenCalled();
  });

  it('rejects a syntactically valid binding owned by another workspace', async () => {
    const f = await fixture();
    const foreign = {
      ...boundRecord(f.profile, 'foreign01', f.profile.cwd),
      workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
    };
    await f.store.setBinding(foreign);

    const resumed = await f.coordinator.resumeProfile(f.profile.key);
    const cleared = await f.coordinator.clearBinding(f.profile.key);

    expect(resumed.ok).toBe(false);
    expect(cleared.ok).toBe(false);
    expect(f.respawns).not.toHaveBeenCalled();
    expect(f.store.getBinding(f.profile.key)).toEqual(foreign);
  });

  it('rejects a missing or non-directory launch cwd', async () => {
    const holder = await tempWorkspace();
    const missing = await fixture({
      profile: { cwd: path.join(holder, 'missing-council-cwd') },
    });
    const missingResult = await missing.coordinator.startProfile(
      missing.profile.key,
    );
    expect(missingResult.ok).toBe(false);
    expect(!missingResult.ok && missingResult.message).toContain(
      'does not exist',
    );
    expect(missing.starts).not.toHaveBeenCalled();

    const file = path.join(holder, 'not-a-directory');
    await writeFile(file, 'ordinary file', 'utf8');
    const nonDirectory = await fixture({ profile: { cwd: file } });
    const fileResult = await nonDirectory.coordinator.startProfile(
      nonDirectory.profile.key,
    );
    expect(fileResult.ok).toBe(false);
    expect(!fileResult.ok && fileResult.message).toContain('not a directory');
    expect(nonDirectory.starts).not.toHaveBeenCalled();
  });

  it('rejects and cleans up a launch reported in a different canonical cwd', async () => {
    const foreignCwd = await tempWorkspace();
    const f = await fixture({
      start: async (request, sessions) => {
        sessions.push(session('wrongcwd', request.name ?? '', foreignCwd));
        return {
          ok: true,
          value: {
            id: 'wrongcwd',
            name: request.name,
            unknownAgent: undefined,
          },
          raw: '',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });

    const result = await f.coordinator.startProfile(f.profile.key);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('different canonical workspace');
    expect(f.stops).toHaveBeenCalledExactlyOnceWith('wrongcwd');
    expect(f.store.getBinding(f.profile.key)).toBeUndefined();
  });

  it('drains an in-flight launch during shutdown and rejects later starts', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const f = await fixture({
      start: async (request, sessions) => {
        startEntered();
        await startGate;
        sessions.push(session('shutdown1', request.name ?? '', request.cwd));
        return {
          ok: true,
          value: { id: 'shutdown1', name: request.name, unknownAgent: undefined },
          raw: '',
          argv: ['--bg'],
          durationMs: 1,
        };
      },
    });

    const starting = f.coordinator.startProfile(f.profile.key);
    await entered;
    let shutdownFinished = false;
    const shuttingDown = f.coordinator.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    releaseStart();
    expect((await starting).ok).toBe(true);
    await shuttingDown;
    expect((await f.coordinator.startProfile(f.profile.key)).ok).toBe(false);
  });
});
