import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  StartSessionOutcome,
  StartSessionRequest,
} from '../src/integration/client.js';
import { ClaudeProviderAdapter } from '../src/integration/claudeProviderAdapter.js';
import type { ClaudeClient } from '../src/integration/client.js';
import { ClaudePaths } from '../src/integration/paths.js';
import type {
  CliResult,
  RosterConfig,
  RosterMember,
  Session,
} from '../src/integration/types.js';
import { ClaudeCodeAgentSupervisor } from '../src/supervisor/agentSupervisor.js';
import type {
  ResolvedAgentCatalog,
  ResolvedCatalogEntry,
} from '../src/supervisor/catalog.js';
import { resolveProfiles } from '../src/supervisor/profiles.js';
import {
  SessionBindingStore,
  type SessionBindingRecord,
} from '../src/supervisor/sessionBindings.js';

const temporaryRoots: string[] = [];
const workspaceId = 'ws_11111111-1111-4111-8111-111111111111';
const fingerprint = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'council-supervisor-lifecycle-'));
  temporaryRoots.push(root);
  return realpath(root);
}

function success<T>(
  value: T,
  argv: readonly string[] = [],
): CliResult<T> {
  return {
    ok: true,
    value,
    raw: '',
    argv,
    durationMs: 1,
  };
}

function providerSession(
  id: string,
  name: string,
  cwd: string,
  state: Session['state'],
): Session {
  return {
    id,
    sessionId: `${id}-full`,
    name,
    kind: 'background',
    state,
    waitingFor: undefined,
    status: undefined,
    detail: undefined,
    cwd,
    startedAt: new Date('2026-07-26T12:00:00.000Z'),
    updatedAt: new Date('2026-07-26T12:00:00.000Z'),
    pid: undefined,
    cold: state === 'done' || state === 'failed' || state === 'stopped',
    pinned: false,
    intent: undefined,
    source: 'roster',
  };
}

interface LifecycleClient {
  readonly client: ClaudeClient;
  readonly sessions: Session[];
  readonly starts: ReturnType<
    typeof vi.fn<
      (request: StartSessionRequest) => Promise<CliResult<StartSessionOutcome>>
    >
  >;
  readonly stops: ReturnType<
    typeof vi.fn<(id: string) => Promise<CliResult<string>>>
  >;
  readonly respawns: ReturnType<
    typeof vi.fn<(id: string) => Promise<CliResult<string>>>
  >;
  readonly logs: ReturnType<
    typeof vi.fn<(id: string) => Promise<CliResult<string>>>
  >;
  readonly listSessions: ReturnType<
    typeof vi.fn<() => Promise<CliResult<Session[]>>>
  >;
  readonly verifyLaunchCapability: ReturnType<
    typeof vi.fn<() => Promise<CliResult<string>>>
  >;
}

function lifecycleClient(initialSessions: readonly Session[] = []): LifecycleClient {
  const sessions = [...initialSessions];
  const starts = vi.fn(
    async (
      request: StartSessionRequest,
    ): Promise<CliResult<StartSessionOutcome>> => {
      const id = `started-${starts.mock.calls.length}`;
      sessions.push(
        providerSession(id, request.name ?? '', request.cwd, 'working'),
      );
      return success(
        {
          id,
          name: request.name,
          unknownAgent: undefined,
        },
        ['--bg'],
      );
    },
  );
  const stops = vi.fn(async (id: string) => success(`stopped ${id}`, ['stop', id]));
  const respawns = vi.fn(async (id: string) => {
    const index = sessions.findIndex((session) => session.id === id);
    const current = sessions[index];
    if (current !== undefined) {
      sessions[index] = {
        ...current,
        state: 'working',
        cold: false,
      };
    }
    return success(`respawned ${id}`, ['respawn', id]);
  });
  const verifyLaunchCapability = vi.fn(async () =>
    success('ready', ['--version']),
  );
  const listSessions = vi.fn(async () =>
    success([...sessions], ['agents', '--json', '--all']),
  );
  const logs = vi.fn(async (id: string) =>
    success(`logs ${id}`, ['logs', id]),
  );

  const client = {
    cli: {
      bin: 'claude.exe',
      version: '2.1.220',
      meetsMinimum: true,
      discoveredVia: 'override',
    },
    listSessions,
    start: starts,
    stop: stops,
    respawn: respawns,
    logs,
    verifyLaunchCapability,
  } as unknown as ClaudeClient;

  return {
    client,
    sessions,
    starts,
    stops,
    respawns,
    logs,
    listSessions,
    verifyLaunchCapability,
  };
}

function catalogEntry(
  workspaceRoot: string,
  overrides: Partial<ResolvedCatalogEntry> = {},
): ResolvedCatalogEntry {
  return {
    catalogId: 'catalog_council_lead',
    workspaceId,
    workspaceRoot,
    launchCwd: workspaceRoot,
    agentName: 'council-lead',
    label: 'Council Lead',
    description: 'Runs a focused Council review.',
    definitionPath: path.join(
      workspaceRoot,
      '.claude',
      'agents',
      'council-lead.md',
    ),
    canonicalDefinitionPath: path.join(
      workspaceRoot,
      '.claude',
      'agents',
      'council-lead.md',
    ),
    scope: 'project',
    precedenceTier: 0,
    fingerprint,
    metadata: {
      model: undefined,
      tools: undefined,
      disallowedTools: undefined,
      permissionMode: 'default',
      maxTurns: undefined,
      memory: undefined,
      effort: undefined,
      skills: undefined,
    },
    hidden: true,
    mode: 'internal',
    launchability: {
      launchable: true,
      state: 'launchable',
      message: undefined,
    },
    ambiguousDefinitions: [],
    shadowedDefinitions: [],
    diagnostics: [],
    ...overrides,
  };
}

function catalog(
  workspaceRoot: string,
  entries: readonly ResolvedCatalogEntry[],
): ResolvedAgentCatalog {
  return {
    workspaceId,
    workspaceRoot,
    includeUser: false,
    roots: [],
    entries,
    diagnostics: [],
    revision: `revision-${entries.length}`,
  };
}

async function bindingStore(workspaceRoot: string): Promise<SessionBindingStore> {
  const store = new SessionBindingStore(
    path.join(workspaceRoot, 'userData', 'session-bindings.json'),
  );
  await store.load();
  return store;
}

function supervisor(
  workspaceRoot: string,
  client: ClaudeClient,
  store: SessionBindingStore,
  resolvedCatalog: ResolvedAgentCatalog,
  config: RosterConfig,
  validations: ReturnType<typeof resolveProfiles>['validations'],
  councilProfileId?: string,
  ptyAvailable = false,
): ClaudeCodeAgentSupervisor {
  return new ClaudeCodeAgentSupervisor({
    provider: new ClaudeProviderAdapter(client, { ptyAvailable }),
    paths: new ClaudePaths({
      configDir: path.join(workspaceRoot, 'claude-config'),
    }),
    config,
    bindings: store,
    workspace: {
      id: workspaceId,
      canonicalPath: workspaceRoot,
      trusted: true,
    },
    catalog: resolvedCatalog,
    resolveCatalog: async () => resolvedCatalog,
    validations,
    ...(councilProfileId === undefined ? {} : { councilProfileId }),
    onSnapshot: vi.fn(),
  });
}

function boundRecord(
  profile: RosterMember,
  session: Session,
  workspaceRoot: string,
): SessionBindingRecord {
  return {
    providerId: 'claude-code',
    workspaceId,
    profileId: profile.key,
    shortSessionId: session.id!,
    fullSessionId: session.sessionId,
    uniqueLaunchName: `dc-bound-${session.id!}`,
    agentName: profile.agent,
    catalogId: profile.catalogId!,
    definitionFingerprint: profile.definitionFingerprint!,
    requestedCanonicalCwd: workspaceRoot,
    actualCanonicalCwd: workspaceRoot,
    createdAt: '2026-07-26T12:00:00.000Z',
    lastConfirmedAt: '2026-07-26T12:00:00.000Z',
  };
}

describe('ClaudeCodeAgentSupervisor lifecycle actions', () => {
  it('refreshes a catalog projection without starting, stopping, or respawning provider work', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const resolvedCatalog = catalog(workspaceRoot, [
      catalogEntry(workspaceRoot),
    ]);
    const profiles = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      resolvedCatalog,
    );
    const store = await bindingStore(workspaceRoot);
    const fake = lifecycleClient();
    const subject = supervisor(
      workspaceRoot,
      fake.client,
      store,
      resolvedCatalog,
      profiles.config,
      profiles.validations,
      profiles.councilProfileId,
    );

    await subject.updateCatalog(
      profiles.config,
      resolvedCatalog,
      profiles.validations,
      profiles.catalogProblems,
      profiles.councilProfileId,
    );

    expect(fake.starts).not.toHaveBeenCalled();
    expect(fake.stops).not.toHaveBeenCalled();
    expect(fake.respawns).not.toHaveBeenCalled();
  });

  it('launches Council Review through the validated coordinator path and binds the exact result', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const resolvedCatalog = catalog(workspaceRoot, [
      catalogEntry(workspaceRoot),
    ]);
    const profiles = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      resolvedCatalog,
    );
    const councilProfileId = profiles.councilProfileId;
    expect(councilProfileId).toMatch(/^profile-internal-/);

    const store = await bindingStore(workspaceRoot);
    const fake = lifecycleClient();
    const subject = supervisor(
      workspaceRoot,
      fake.client,
      store,
      resolvedCatalog,
      profiles.config,
      profiles.validations,
      councilProfileId,
    );

    const question = 'Which release risk should the Council address first?';
    const result = await subject.startCouncilReview(question, fingerprint, false);

    expect(result.ok).toBe(true);
    expect(fake.verifyLaunchCapability).toHaveBeenCalledOnce();
    expect(fake.starts).toHaveBeenCalledOnce();
    expect(fake.starts.mock.calls[0]?.[0]).toMatchObject({
      agent: 'council-lead',
      cwd: workspaceRoot,
      prompt: question,
      permissionMode: 'default',
    });
    expect(fake.starts.mock.calls[0]?.[0].name).toMatch(/^dc-/);
    expect(store.getBinding(councilProfileId!)).toMatchObject({
      profileId: councilProfileId,
      shortSessionId: result.ok ? result.value.id : undefined,
      agentName: 'council-lead',
      definitionFingerprint: fingerprint,
    });
    expect(store.getPendingLaunch(councilProfileId!)).toBeUndefined();
    expect(subject.councilReviewNeedsReplacement()).toBe(true);

    const unconfirmedReplacement = await subject.startCouncilReview(
      'A second review.',
      fingerprint,
      false,
    );
    expect(unconfirmedReplacement.ok).toBe(false);
    expect(fake.starts).toHaveBeenCalledOnce();

    const staleDisplay = await subject.startCouncilReview(
      'A second review.',
      'd'.repeat(64),
      true,
    );
    expect(staleDisplay.ok).toBe(false);
    expect(!staleDisplay.ok && staleDisplay.message).toContain(
      'changed after this action was displayed',
    );
    expect(fake.starts).toHaveBeenCalledOnce();

    const confirmedReplacement = await subject.startCouncilReview(
      'A second review.',
      fingerprint,
      true,
    );
    expect(confirmedReplacement.ok).toBe(true);
    expect(fake.starts).toHaveBeenCalledTimes(2);
    expect(fake.stops).not.toHaveBeenCalled();
    expect(store.getBinding(councilProfileId!)).toMatchObject({
      shortSessionId: confirmedReplacement.ok
        ? confirmedReplacement.value.id
        : undefined,
    });
  });

  it('rejects a normal council-lead definition without entering the launch path', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const resolvedCatalog = catalog(workspaceRoot, [
      catalogEntry(workspaceRoot, {
        hidden: false,
        mode: 'normal',
      }),
    ]);
    const profiles = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      resolvedCatalog,
    );
    expect(profiles.councilProfileId).toBeUndefined();

    const store = await bindingStore(workspaceRoot);
    const fake = lifecycleClient();
    const subject = supervisor(
      workspaceRoot,
      fake.client,
      store,
      resolvedCatalog,
      profiles.config,
      profiles.validations,
    );

    const result = await subject.startCouncilReview(
      'Review this.',
      fingerprint,
      false,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(
      'explicitly internal "council-lead"',
    );
    expect(fake.verifyLaunchCapability).not.toHaveBeenCalled();
    expect(fake.starts).not.toHaveBeenCalled();
  });

  it('revalidates a nonlaunchable internal council-lead definition and refuses to spawn', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const councilProfileId = 'profile-internal-nonlaunchable';
    const entry = catalogEntry(workspaceRoot, {
      launchability: {
        launchable: false,
        state: 'ambiguous',
        message: 'Council lead is ambiguous at project scope.',
      },
    });
    const resolvedCatalog = catalog(workspaceRoot, [entry]);
    const config: RosterConfig = {
      version: 2,
      members: [
        {
          key: councilProfileId,
          label: entry.label,
          agent: entry.agentName,
          cwd: workspaceRoot,
          workspaceId,
          catalogId: entry.catalogId,
          definitionFingerprint: fingerprint,
          configured: false,
          mode: 'internal',
          visible: false,
        },
      ],
      pollIntervalMs: 10_000,
    };
    const profiles = resolveProfiles(config, resolvedCatalog);
    const store = await bindingStore(workspaceRoot);
    const fake = lifecycleClient();
    const subject = supervisor(
      workspaceRoot,
      fake.client,
      store,
      resolvedCatalog,
      config,
      profiles.validations,
      councilProfileId,
    );

    const result = await subject.startCouncilReview(
      'Review this.',
      fingerprint,
      false,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(
      'Council lead is ambiguous at project scope.',
    );
    expect(fake.verifyLaunchCapability).not.toHaveBeenCalled();
    expect(fake.starts).not.toHaveBeenCalled();
    expect(store.getBinding(councilProfileId)).toBeUndefined();
  });

  it.each(['stop', 'logs', 'reply'] as const)(
    'blocks obsolete %s when the exact binding changes during roster resolution',
    async (action) => {
      const workspaceRoot = await temporaryWorkspace();
      const entry = catalogEntry(workspaceRoot, {
        catalogId: 'catalog_builder',
        agentName: 'builder',
        label: 'Builder',
        hidden: false,
        mode: 'normal',
      });
      const resolvedCatalog = catalog(workspaceRoot, [entry]);
      const profiles = resolveProfiles(
        { version: 2, members: [], pollIntervalMs: 10_000 },
        resolvedCatalog,
      );
      const profile = profiles.config.members[0]!;
      const exact = {
        ...providerSession(
          `bound-${action}`,
          'Builder',
          workspaceRoot,
          action === 'reply' ? 'blocked' : 'working',
        ),
        ...(action === 'reply' ? { waitingFor: 'input needed' as const } : {}),
      };
      const fake = lifecycleClient([exact]);
      const store = await bindingStore(workspaceRoot);
      const original = boundRecord(profile, exact, workspaceRoot);
      await store.setBinding(original);
      const subject = supervisor(
        workspaceRoot,
        fake.client,
        store,
        resolvedCatalog,
        profiles.config,
        profiles.validations,
        undefined,
        action === 'reply',
      );
      let releaseList!: () => void;
      const listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      let listEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        listEntered = resolve;
      });
      fake.listSessions.mockImplementationOnce(async () => {
        listEntered();
        await listGate;
        return success(
          [...fake.sessions],
          ['agents', '--json', '--all'],
        );
      });

      const resultPromise =
        action === 'stop'
          ? subject.stopSession(profile.key)
          : action === 'logs'
            ? subject.logs(profile.key)
            : subject.reply(profile.key, 'ordinary text');
      await entered;
      if (action === 'stop') {
        const replacementSession = providerSession(
          'replacement-session',
          'Builder',
          workspaceRoot,
          'working',
        );
        await store.replaceBinding(
          boundRecord(profile, replacementSession, workspaceRoot),
          original,
        );
      } else {
        await store.clearBinding(profile.key, original);
      }
      releaseList();
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain('binding changed');
      expect(fake.stops).not.toHaveBeenCalled();
      expect(fake.logs).not.toHaveBeenCalled();
    },
  );

  it('wakes only the exact failed bound profile and leaves unrelated failed sessions untouched', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const entry = catalogEntry(workspaceRoot, {
      catalogId: 'catalog_builder',
      agentName: 'builder',
      label: 'Builder',
      hidden: false,
      mode: 'normal',
    });
    const resolvedCatalog = catalog(workspaceRoot, [entry]);
    const profiles = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      resolvedCatalog,
    );
    const profile = profiles.config.members[0]!;
    const exactFailed = providerSession(
      'bound-failed',
      'Builder',
      workspaceRoot,
      'failed',
    );
    const unrelatedFailed = providerSession(
      'unrelated-failed',
      'Builder',
      workspaceRoot,
      'failed',
    );
    const fake = lifecycleClient([exactFailed, unrelatedFailed]);
    const store = await bindingStore(workspaceRoot);
    await store.setBinding(boundRecord(profile, exactFailed, workspaceRoot));
    const subject = supervisor(
      workspaceRoot,
      fake.client,
      store,
      resolvedCatalog,
      profiles.config,
      profiles.validations,
    );

    const result = await subject.wakeSquad();

    expect(result).toMatchObject({
      ok: true,
      value: 'Woke 1 exactly bound profile.',
    });
    expect(fake.respawns).toHaveBeenCalledOnce();
    expect(fake.respawns).toHaveBeenCalledWith('bound-failed');
    expect(fake.starts).not.toHaveBeenCalled();
    expect(fake.stops).not.toHaveBeenCalled();
    expect(
      fake.sessions.find((session) => session.id === 'unrelated-failed')?.state,
    ).toBe('failed');
    expect(
      subject.current?.roster.unassigned.map((session) => session.id),
    ).toContain('unrelated-failed');
  });
});
