import { describe, expect, it } from 'vitest';
import type {
  RosterConfig,
  SessionBindingRef,
} from '../src/integration/types.js';
import type {
  ResolvedAgentCatalog,
  ResolvedCatalogEntry,
} from '../src/supervisor/catalog.js';
import { resolveProfiles } from '../src/supervisor/profiles.js';
import type { PendingLaunchRecord } from '../src/supervisor/sessionBindings.js';

function entry(
  name: string,
  overrides: Partial<ResolvedCatalogEntry> = {},
): ResolvedCatalogEntry {
  return {
    catalogId: `catalog_${name}`,
    workspaceId: 'ws_test',
    workspaceRoot: '/work',
    launchCwd: '/work',
    agentName: name,
    label: name,
    description: `${name} role`,
    definitionPath: `/work/.claude/agents/${name}.md`,
    canonicalDefinitionPath: `/work/.claude/agents/${name}.md`,
    scope: 'project',
    precedenceTier: 0,
    fingerprint: 'a'.repeat(64),
    metadata: {
      model: undefined,
      tools: undefined,
      disallowedTools: undefined,
      permissionMode: undefined,
      maxTurns: undefined,
      memory: undefined,
      effort: undefined,
      skills: undefined,
    },
    hidden: false,
    mode: 'normal',
    launchability: { launchable: true, state: 'launchable', message: undefined },
    ambiguousDefinitions: [],
    shadowedDefinitions: [],
    diagnostics: [],
    ...overrides,
  };
}

function catalog(entries: readonly ResolvedCatalogEntry[]): ResolvedAgentCatalog {
  return {
    workspaceId: 'ws_test',
    workspaceRoot: '/work',
    includeUser: true,
    roots: [],
    entries,
    diagnostics: [],
    revision: 'revision',
  };
}

function binding(
  profileId: string,
  agentName: string,
  catalogId: string,
): SessionBindingRef {
  return {
    providerId: 'claude-code',
    workspaceId: 'ws_test',
    profileId,
    shortSessionId: 'bound-session',
    uniqueLaunchName: 'dc-bound-session',
    agentName,
    catalogId,
    definitionFingerprint: 'b'.repeat(64),
    requestedCanonicalCwd: '/work',
    createdAt: '2026-07-26T00:00:00.000Z',
    lastConfirmedAt: '2026-07-26T00:01:00.000Z',
  };
}

function pending(
  profileId: string,
  agentName: string,
  catalogId: string,
): PendingLaunchRecord {
  return {
    providerId: 'claude-code',
    workspaceId: 'ws_test',
    profileId,
    uniqueLaunchName: 'dc-pending-session',
    agentName,
    catalogId,
    definitionFingerprint: 'c'.repeat(64),
    requestedCanonicalCwd: '/work',
    createdAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('resolveProfiles', () => {
  it('creates deterministic opaque virtual profiles without persisting them', () => {
    const saved: RosterConfig = { version: 2, members: [], pollIntervalMs: 10_000 };
    const first = resolveProfiles(saved, catalog([entry('builder')]));
    const second = resolveProfiles(saved, catalog([entry('builder')]));
    expect(first.config.members[0]?.key).toMatch(/^profile-virtual-/);
    expect(second.config.members[0]?.key).toBe(first.config.members[0]?.key);
    expect(first.config.members[0]?.configured).toBe(false);
  });

  it('keeps configured missing profiles visible and nonlaunchable', () => {
    const saved: RosterConfig = {
      version: 2,
      members: [
        {
          key: 'profile-configured1',
          label: 'Missing',
          agent: 'missing',
          cwd: '/old',
          workspaceId: 'ws_test',
          catalogId: 'catalog_missing',
          configured: true,
        },
      ],
      pollIntervalMs: 10_000,
    };
    const resolved = resolveProfiles(saved, catalog([]));
    expect(resolved.config.members[0]?.cwd).toBe('/work');
    expect(resolved.validations.get('profile-configured1')).toMatchObject({
      found: false,
      launchable: false,
    });
  });

  it('does not substitute a same-named definition for an unknown v2 catalog identity', () => {
    const saved: RosterConfig = {
      version: 2,
      members: [
        {
          key: 'profile-configured1',
          label: 'Stale builder identity',
          agent: 'builder',
          cwd: '/work',
          workspaceId: 'ws_test',
          catalogId: 'catalog_removed',
          configured: true,
        },
      ],
      pollIntervalMs: 10_000,
    };

    const resolved = resolveProfiles(saved, catalog([entry('builder')]));

    expect(resolved.validations.get('profile-configured1')).toMatchObject({
      agent: 'builder',
      found: false,
      catalogId: 'catalog_removed',
      launchable: false,
      diagnostic: expect.stringMatching(
        /Catalog identity "catalog_removed" is not present.*same-named agent definition is not substituted/,
      ),
    });
    expect(resolved.config.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'profile-configured1',
          catalogId: 'catalog_removed',
          configured: true,
        }),
        expect.objectContaining({
          agent: 'builder',
          catalogId: 'catalog_builder',
          configured: false,
        }),
      ]),
    );
  });

  it('uses agent-name fallback only for a legacy v1 member without a catalog id', () => {
    const saved: RosterConfig = {
      version: 1,
      members: [
        {
          key: 'profile-v1-configured1',
          legacyKey: 'builder',
          label: 'Legacy builder',
          agent: 'builder',
          cwd: '/work',
          workspaceId: 'ws_test',
          configured: true,
        },
      ],
      pollIntervalMs: 10_000,
    };

    const resolved = resolveProfiles(saved, catalog([entry('builder')]));

    expect(resolved.validations.get('profile-v1-configured1')).toMatchObject({
      agent: 'builder',
      found: true,
      catalogId: 'catalog_builder',
      launchable: true,
    });
    expect(resolved.config.members).toHaveLength(1);
  });

  it('rejects a configured catalog and agent-name identity mismatch', () => {
    const saved: RosterConfig = {
      version: 2,
      members: [
        {
          key: 'profile-configured1',
          label: 'Mismatched',
          agent: 'reviewer',
          cwd: '/work',
          workspaceId: 'ws_test',
          catalogId: 'catalog_builder',
          configured: true,
        },
      ],
      pollIntervalMs: 10_000,
    };

    const resolved = resolveProfiles(
      saved,
      catalog([entry('builder'), entry('reviewer')]),
    );

    expect(resolved.validations.get('profile-configured1')).toMatchObject({
      agent: 'reviewer',
      found: true,
      catalogId: 'catalog_builder',
      launchable: false,
      diagnostic: expect.stringMatching(/does not match catalog identity "builder"/),
    });
  });

  it('keeps a configured virtual-id collision diagnostic and projects a unique safe virtual id', () => {
    const inventory = catalog([entry('builder')]);
    const generatedId = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      inventory,
    ).config.members[0]!.key;
    const saved: RosterConfig = {
      version: 2,
      members: [
        {
          key: generatedId,
          label: 'Configured builder',
          agent: 'builder',
          cwd: '/work',
          workspaceId: 'ws_test',
          catalogId: 'catalog_builder',
          configured: true,
        },
      ],
      pollIntervalMs: 10_000,
    };

    const first = resolveProfiles(saved, inventory);
    const second = resolveProfiles(saved, inventory);
    const generated = first.config.members.find(
      (member) => member.configured === false,
    );

    expect(first.config.members.map((member) => member.key)).toHaveLength(
      new Set(first.config.members.map((member) => member.key)).size,
    );
    expect(first.config.members.find((member) => member.configured === true)?.key).toBe(
      generatedId,
    );
    expect(first.validations.get(generatedId)).toMatchObject({
      launchable: false,
      diagnostic: expect.stringMatching(
        /collides with the reserved generated virtual profile namespace/,
      ),
    });
    expect(generated).toMatchObject({
      agent: 'builder',
      catalogId: 'catalog_builder',
      configured: false,
    });
    expect(generated?.key).not.toBe(generatedId);
    expect(first.validations.get(generated!.key)?.launchable).toBe(true);
    expect(
      second.config.members.find((member) => member.configured === false)?.key,
    ).toBe(generated?.key);
  });

  it('gives an exact virtual binding ownership precedence over a configured id collider', () => {
    const builder = entry('builder');
    const canonicalBuilderId = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([builder]),
    ).config.members[0]!.key;
    const saved: RosterConfig = {
      version: 2,
      members: [
        {
          key: canonicalBuilderId,
          label: 'Unrelated configured reviewer',
          agent: 'reviewer',
          cwd: '/work',
          workspaceId: 'ws_test',
          catalogId: 'catalog_reviewer',
          configured: true,
        },
      ],
      pollIntervalMs: 10_000,
    };

    const resolved = resolveProfiles(
      saved,
      catalog([builder, entry('reviewer')]),
      [binding(canonicalBuilderId, 'builder', 'catalog_builder')],
    );
    const owner = resolved.config.members.find(
      (member) => member.key === canonicalBuilderId,
    );

    expect(owner).toMatchObject({
      agent: 'builder',
      catalogId: 'catalog_builder',
      configured: false,
    });
    expect(
      resolved.config.members.some(
        (member) =>
          member.key === canonicalBuilderId && member.configured === true,
      ),
    ).toBe(false);
    expect(resolved.validations.get(canonicalBuilderId)?.launchable).toBe(true);
    expect(resolved.catalogProblems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: canonicalBuilderId,
          message: expect.stringMatching(/durable generated session record owns/),
        }),
      ]),
    );
  });

  it('reserves a mismatched durable id and recovers it fail-closed instead of adopting it', () => {
    const builder = entry('builder');
    const canonicalBuilderId = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([builder]),
    ).config.members[0]!.key;

    const resolved = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([builder]),
      [binding(canonicalBuilderId, 'impostor', 'catalog_builder')],
    );
    const launchableBuilder = resolved.config.members.find(
      (member) =>
        member.agent === 'builder' && member.key !== canonicalBuilderId,
    );
    const recovered = resolved.config.members.find(
      (member) => member.key === canonicalBuilderId,
    );

    expect(launchableBuilder).toMatchObject({
      catalogId: 'catalog_builder',
      configured: false,
    });
    expect(
      resolved.validations.get(launchableBuilder!.key)?.launchable,
    ).toBe(true);
    expect(recovered).toMatchObject({
      agent: 'impostor',
      catalogId: 'catalog_builder',
      configured: false,
    });
    expect(resolved.validations.get(canonicalBuilderId)).toMatchObject({
      agent: 'impostor',
      launchable: false,
      diagnostic: expect.stringMatching(
        /does not match catalog identity "builder"/,
      ),
    });
  });

  it('keeps ambiguous durable generated ids separate and blocks their launch actions', () => {
    const firstOwnedId = 'profile-virtual-owned-first';
    const secondOwnedId = 'profile-virtual-owned-second';
    const resolved = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([entry('builder')]),
      [
        binding(firstOwnedId, 'builder', 'catalog_builder'),
        {
          ...binding(secondOwnedId, 'builder', 'catalog_builder'),
          shortSessionId: 'bound-session-two',
          uniqueLaunchName: 'dc-bound-session-two',
        },
      ],
    );
    const fresh = resolved.config.members.find(
      (member) =>
        member.catalogId === 'catalog_builder' &&
        member.key !== firstOwnedId &&
        member.key !== secondOwnedId,
    );

    expect(fresh).toBeDefined();
    expect(resolved.validations.get(fresh!.key)?.launchable).toBe(true);
    for (const ownedId of [firstOwnedId, secondOwnedId]) {
      expect(
        resolved.validations.get(ownedId),
      ).toMatchObject({
        launchable: false,
        diagnostic: expect.stringMatching(
          /Multiple durable generated virtual profile ids claim catalog identity/,
        ),
      });
    }
  });

  it('creates Council only from explicit internal metadata', () => {
    const saved: RosterConfig = { version: 2, members: [], pollIntervalMs: 10_000 };
    const normal = resolveProfiles(saved, catalog([entry('council-lead')]));
    expect(normal.councilProfileId).toBeUndefined();
    const internal = resolveProfiles(
      saved,
      catalog([entry('council-lead', { mode: 'internal', hidden: true })]),
    );
    expect(internal.councilProfileId).toMatch(/^profile-internal-/);
    expect(
      internal.config.members.find((member) => member.key === internal.councilProfileId)?.visible,
    ).toBe(false);
  });

  it('keeps Council bound to its exact generated member across an internal-id collision', () => {
    const council = entry('council-lead', { mode: 'internal', hidden: true });
    const canonicalCouncilId = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([council]),
    ).councilProfileId!;
    const saved: RosterConfig = {
      version: 2,
      members: [
        {
          key: canonicalCouncilId,
          label: 'Unrelated configured reviewer',
          agent: 'reviewer',
          cwd: '/work',
          workspaceId: 'ws_test',
          catalogId: 'catalog_reviewer',
          configured: true,
          mode: 'normal',
        },
      ],
      pollIntervalMs: 10_000,
    };

    const resolved = resolveProfiles(
      saved,
      catalog([entry('reviewer'), council]),
    );
    const councilMember = resolved.config.members.find(
      (member) => member.key === resolved.councilProfileId,
    );

    expect(resolved.config.members.map((member) => member.key)).toHaveLength(
      new Set(resolved.config.members.map((member) => member.key)).size,
    );
    expect(resolved.validations.get(canonicalCouncilId)).toMatchObject({
      agent: 'reviewer',
      launchable: false,
      diagnostic: expect.stringMatching(
        /collides with the reserved generated internal profile namespace/,
      ),
    });
    expect(resolved.councilProfileId).not.toBe(canonicalCouncilId);
    expect(councilMember).toMatchObject({
      agent: 'council-lead',
      catalogId: 'catalog_council-lead',
      configured: false,
      mode: 'internal',
      visible: false,
    });
    expect(
      resolved.validations.get(resolved.councilProfileId!)?.launchable,
    ).toBe(true);
  });

  it('gives an exact pending Council launch ownership precedence over an internal id collider', () => {
    const council = entry('council-lead', { mode: 'internal', hidden: true });
    const canonicalCouncilId = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([council]),
    ).councilProfileId!;
    const saved: RosterConfig = {
      version: 2,
      members: [
        {
          key: canonicalCouncilId,
          label: 'Unrelated configured reviewer',
          agent: 'reviewer',
          cwd: '/work',
          workspaceId: 'ws_test',
          catalogId: 'catalog_reviewer',
          configured: true,
        },
      ],
      pollIntervalMs: 10_000,
    };

    const resolved = resolveProfiles(
      saved,
      catalog([entry('reviewer'), council]),
      [],
      [
        pending(
          canonicalCouncilId,
          'council-lead',
          'catalog_council-lead',
        ),
      ],
    );
    const councilMember = resolved.config.members.find(
      (member) => member.key === resolved.councilProfileId,
    );

    expect(resolved.councilProfileId).toBe(canonicalCouncilId);
    expect(councilMember).toMatchObject({
      agent: 'council-lead',
      catalogId: 'catalog_council-lead',
      configured: false,
      mode: 'internal',
    });
    expect(
      resolved.config.members.some(
        (member) =>
          member.key === canonicalCouncilId && member.agent === 'reviewer',
      ),
    ).toBe(false);
  });

  it('preserves two configured profiles selecting the same catalog identity', () => {
    const saved: RosterConfig = {
      version: 2,
      members: ['profile-one1111', 'profile-two2222'].map((key) => ({
        key,
        label: 'Same label',
        agent: 'builder',
        cwd: '/work',
        workspaceId: 'ws_test',
        catalogId: 'catalog_builder',
        configured: true,
      })),
      pollIntervalMs: 10_000,
    };
    const resolved = resolveProfiles(saved, catalog([entry('builder')]));
    expect(resolved.config.members.map((member) => member.key)).toEqual([
      'profile-one1111',
      'profile-two2222',
    ]);
  });

  it('keeps a bound virtual profile recoverable after its definition disappears', () => {
    const saved: RosterConfig = { version: 2, members: [], pollIntervalMs: 10_000 };
    const resolved = resolveProfiles(saved, catalog([]), [
      {
        providerId: 'claude-code',
        workspaceId: 'ws_test',
        profileId: 'profile-virtual-12345678',
        shortSessionId: 'deadbeef',
        uniqueLaunchName: 'dc-virtual-deadbeef',
        agentName: 'removed-agent',
        catalogId: 'catalog_removed',
        definitionFingerprint: 'b'.repeat(64),
        requestedCanonicalCwd: '/work',
        createdAt: '2026-07-26T00:00:00.000Z',
        lastConfirmedAt: '2026-07-26T00:00:00.000Z',
      },
    ]);
    expect(resolved.config.members[0]).toMatchObject({
      key: 'profile-virtual-12345678',
      agent: 'removed-agent',
      visible: true,
    });
    expect(resolved.validations.get('profile-virtual-12345678')).toMatchObject({
      found: false,
      launchable: false,
    });
  });

  it('keeps a pending-only virtual profile recoverable for crash reconciliation', () => {
    const saved: RosterConfig = { version: 2, members: [], pollIntervalMs: 10_000 };
    const resolved = resolveProfiles(saved, catalog([]), [], [
      {
        providerId: 'claude-code',
        workspaceId: 'ws_test',
        profileId: 'profile-virtual-87654321',
        uniqueLaunchName: 'dc-pending-crash',
        agentName: 'removed-agent',
        catalogId: 'catalog_removed',
        definitionFingerprint: 'c'.repeat(64),
        requestedCanonicalCwd: '/work',
        createdAt: '2026-07-26T00:00:00.000Z',
      },
    ]);

    expect(resolved.config.members[0]).toMatchObject({
      key: 'profile-virtual-87654321',
      agent: 'removed-agent',
      visible: true,
    });
  });

  it('recovers a Mission-scoped binding as a hidden internal profile', () => {
    const missionProfileId =
      'profile-internal-mission-12345678';
    const secondMissionProfileId =
      'profile-internal-mission-87654321';
    const resolved = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([entry('builder')]),
      [
        binding(missionProfileId, 'builder', 'catalog_builder'),
        binding(secondMissionProfileId, 'builder', 'catalog_builder'),
      ],
    );

    expect(
      resolved.config.members.find(
        (member) => member.key === missionProfileId,
      ),
    ).toMatchObject({
      agent: 'builder',
      mode: 'internal',
      visible: false,
    });
    expect(
      resolved.validations.get(missionProfileId)?.launchable,
    ).toBe(true);
    expect(
      resolved.validations.get(secondMissionProfileId)?.launchable,
    ).toBe(true);
  });

  it('does not substitute a same-named definition for a recovered durable catalog identity', () => {
    const recoveredId = 'profile-virtual-identity-missing';
    const resolved = resolveProfiles(
      { version: 2, members: [], pollIntervalMs: 10_000 },
      catalog([entry('builder')]),
      [binding(recoveredId, 'builder', 'catalog_removed')],
    );

    expect(resolved.validations.get(recoveredId)).toMatchObject({
      agent: 'builder',
      found: false,
      catalogId: 'catalog_removed',
      launchable: false,
      diagnostic: expect.stringMatching(
        /Durable session ownership references catalog identity "catalog_removed".*same-named agent definition is not substituted/,
      ),
    });
  });
});
