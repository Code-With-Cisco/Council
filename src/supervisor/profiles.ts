import { createHash } from 'node:crypto';
import type {
  AgentValidation,
  ParseProblem,
  RosterConfig,
  RosterMember,
  SessionBindingRef,
} from '../integration/types.js';
import type {
  ResolvedAgentCatalog,
  ResolvedCatalogEntry,
} from './catalog.js';
import type { PendingLaunchRecord } from './sessionBindings.js';
import { generatedProfileKind } from '../profileIdentity.js';

const LEGACY_PLACEHOLDERS = new Set(['arden', 'bram', 'rook', 'tess', 'sage']);

export interface ResolvedProfiles {
  readonly config: RosterConfig;
  readonly validations: ReadonlyMap<string, AgentValidation>;
  readonly catalogProblems: readonly ParseProblem[];
  readonly councilProfileId: string | undefined;
  readonly ignoredLegacyPlaceholders: boolean;
}

function profileId(kind: 'virtual' | 'internal', workspaceId: string, catalogId: string): string {
  const digest = createHash('sha256')
    .update(`${kind}\u0000${workspaceId}\u0000${catalogId}`)
    .digest('hex')
    .slice(0, 24);
  return `profile-${kind}-${digest}`;
}

function allocateGeneratedProfileId(
  kind: 'virtual' | 'internal',
  workspaceId: string,
  catalogId: string,
  usedProfileIds: Set<string>,
  reservedProfileIds: ReadonlySet<string>,
): string {
  let attempt = 0;
  while (true) {
    const identity =
      attempt === 0 ? catalogId : `${catalogId}\u0000collision\u0000${attempt}`;
    const candidate = profileId(kind, workspaceId, identity);
    if (
      !usedProfileIds.has(candidate) &&
      !reservedProfileIds.has(candidate)
    ) {
      usedProfileIds.add(candidate);
      return candidate;
    }
    attempt += 1;
  }
}

function allocateOwnedOrGeneratedProfileId(
  kind: 'virtual' | 'internal',
  workspaceId: string,
  catalogId: string,
  agentName: string,
  durableRecords: readonly (SessionBindingRef | PendingLaunchRecord)[],
  usedProfileIds: Set<string>,
  reservedProfileIds: ReadonlySet<string>,
): string {
  const ownedCandidates = [
    ...new Set(
      durableRecords
        .filter(
          (record) =>
            record.catalogId === catalogId &&
            record.agentName === agentName &&
            generatedProfileKind(record.profileId) === kind,
        )
        .map((record) => record.profileId),
    ),
  ];
  const preferred =
    ownedCandidates.length === 1 ? ownedCandidates[0] : undefined;
  if (preferred !== undefined && !usedProfileIds.has(preferred)) {
    usedProfileIds.add(preferred);
    return preferred;
  }
  return allocateGeneratedProfileId(
    kind,
    workspaceId,
    catalogId,
    usedProfileIds,
    reservedProfileIds,
  );
}

function validation(
  entry: ResolvedCatalogEntry | undefined,
  agentName: string,
): AgentValidation {
  if (entry === undefined) {
    return {
      agent: agentName,
      found: false,
      launchable: false,
      diagnostic: `No effective definition named "${agentName}" is visible.`,
      path: undefined,
      shadowedBy: [],
      candidatePaths: [],
    };
  }
  if (entry.agentName !== agentName) {
    return {
      agent: agentName,
      found: entry.definitionPath !== undefined,
      catalogId: entry.catalogId,
      fingerprint: entry.fingerprint,
      launchable: false,
      scope: entry.scope,
      diagnostic:
        `Configured agent name "${agentName}" does not match catalog identity ` +
        `"${entry.agentName}". Fix the saved profile before launching.`,
      path: entry.definitionPath,
      shadowedBy: entry.shadowedDefinitions.map(
        (source) => source.definitionPath,
      ),
      candidatePaths: entry.ambiguousDefinitions.map(
        (source) => source.definitionPath,
      ),
    };
  }
  return {
    agent: entry.agentName,
    found: entry.definitionPath !== undefined,
    catalogId: entry.catalogId,
    fingerprint: entry.fingerprint,
    launchable: entry.launchability.launchable,
    scope: entry.scope,
    diagnostic: entry.launchability.message,
    path: entry.definitionPath,
    shadowedBy: entry.shadowedDefinitions.map((source) => source.definitionPath),
    candidatePaths: entry.ambiguousDefinitions.map(
      (source) => source.definitionPath,
    ),
  };
}

function missingCatalogIdentityValidation(
  member: RosterMember,
): AgentValidation {
  const catalogIdentity =
    member.catalogId === undefined
      ? 'This v2 profile has no catalog identity.'
      : `Catalog identity "${member.catalogId}" is not present in the effective catalog.`;
  return {
    agent: member.agent,
    found: false,
    ...(member.catalogId === undefined ? {} : { catalogId: member.catalogId }),
    launchable: false,
    diagnostic:
      `${catalogIdentity} A same-named agent definition is not substituted; ` +
      'select and save the intended catalog identity before launching.',
    path: undefined,
    shadowedBy: [],
    candidatePaths: [],
  };
}

function missingDurableCatalogIdentityValidation(
  binding: SessionBindingRef | PendingLaunchRecord,
): AgentValidation {
  return {
    agent: binding.agentName,
    found: false,
    catalogId: binding.catalogId,
    launchable: false,
    diagnostic:
      `Durable session ownership references catalog identity "${binding.catalogId}", ` +
      'which is not present in the effective catalog. A same-named agent definition ' +
      'is not substituted.',
    path: undefined,
    shadowedBy: [],
    candidatePaths: [],
  };
}

function durableIdentityValidation(
  binding: SessionBindingRef | PendingLaunchRecord,
  entry: ResolvedCatalogEntry | undefined,
  durableRecords: readonly (SessionBindingRef | PendingLaunchRecord)[],
): AgentValidation {
  const base =
    entry === undefined
      ? missingDurableCatalogIdentityValidation(binding)
      : validation(entry, binding.agentName);
  const kind = generatedProfileKind(binding.profileId);
  if (kind === undefined) return base;
  const matchingProfileIds = new Set(
    durableRecords
      .filter(
        (record) =>
          generatedProfileKind(record.profileId) === kind &&
          record.catalogId === binding.catalogId &&
          record.agentName === binding.agentName,
      )
      .map((record) => record.profileId),
  );
  if (matchingProfileIds.size <= 1) return base;
  return {
    ...base,
    launchable: false,
    diagnostic:
      `Multiple durable generated ${kind} profile ids claim catalog identity ` +
      `"${binding.catalogId}" for agent "${binding.agentName}". Existing exact ` +
      'session actions remain available, but launch actions are blocked.',
  };
}

function generatedIdCollisionValidation(
  member: RosterMember,
  kind: 'virtual' | 'internal',
  base: AgentValidation,
): AgentValidation {
  return {
    ...base,
    launchable: false,
    diagnostic:
      `Configured profile id "${member.key}" collides with the reserved generated ` +
      `${kind} profile namespace. Save this configured profile with a distinct id ` +
      `before launching.${base.diagnostic === undefined ? '' : ` ${base.diagnostic}`}`,
  };
}

function profileFromEntry(
  entry: ResolvedCatalogEntry,
  key: string,
  order: number,
  configured: boolean,
  mode: 'normal' | 'internal' = entry.mode,
): RosterMember {
  return {
    key,
    label: entry.label,
    agent: entry.agentName,
    cwd: entry.launchCwd,
    ...(entry.description === undefined ? {} : { role: entry.description }),
    ...(entry.metadata?.model === undefined ? {} : { model: entry.metadata.model }),
    ...(entry.metadata?.effort === undefined ? {} : { effort: entry.metadata.effort }),
    ...(entry.metadata?.permissionMode === undefined
      ? {}
      : { permissionMode: entry.metadata.permissionMode }),
    workspaceId: entry.workspaceId,
    catalogId: entry.catalogId,
    ...(entry.fingerprint === undefined
      ? {}
      : { definitionFingerprint: entry.fingerprint }),
    configured,
    mode,
    visible: mode === 'normal' && !entry.hidden,
    order,
    autoStart: false,
  };
}

function isLegacyPlaceholderSet(members: readonly RosterMember[]): boolean {
  return (
    members.length === LEGACY_PLACEHOLDERS.size &&
    members.every(
      (member) =>
        LEGACY_PLACEHOLDERS.has(member.agent) &&
        (member.legacyKey ?? member.agent) === member.agent &&
        member.bootPrompt === undefined &&
        member.model === undefined &&
        member.effort === undefined,
    )
  );
}

/**
 * Layers saved preferences over resolved inventory. Virtual profiles stay in
 * memory; saving the returned v2 config filters them out.
 */
export function resolveProfiles(
  saved: RosterConfig,
  catalog: ResolvedAgentCatalog,
  bindings: readonly SessionBindingRef[] = [],
  pendingLaunches: readonly PendingLaunchRecord[] = [],
): ResolvedProfiles {
  const byCatalogId = new Map(catalog.entries.map((entry) => [entry.catalogId, entry]));
  const byName = new Map(catalog.entries.map((entry) => [entry.agentName, entry]));
  const activeConfigured = saved.members.filter(
    (member) =>
      member.workspaceId === undefined || member.workspaceId === catalog.workspaceId,
  );
  const ignoredLegacyPlaceholders =
    isLegacyPlaceholderSet(activeConfigured) &&
    !activeConfigured.some((member) => byName.has(member.agent));
  const configuredBeforeOwnership = ignoredLegacyPlaceholders
    ? []
    : activeConfigured;
  const durableRecords = [...bindings, ...pendingLaunches].filter(
    (record) =>
      record.workspaceId === catalog.workspaceId &&
      generatedProfileKind(record.profileId) !== undefined,
  );
  const durableProfileIds = new Set(
    durableRecords.map((record) => record.profileId),
  );
  const suppressedConfigured = configuredBeforeOwnership.filter(
    (member) =>
      member.configured !== false &&
      generatedProfileKind(member.key) !== undefined &&
      durableProfileIds.has(member.key),
  );
  const suppressedProfileIds = new Set(
    suppressedConfigured.map((member) => member.key),
  );
  const configured = configuredBeforeOwnership.filter(
    (member) => !suppressedProfileIds.has(member.key),
  );

  const members: RosterMember[] = [];
  const validations = new Map<string, AgentValidation>();
  const represented = new Set<string>();
  const usedProfileIds = new Set(configured.map((member) => member.key));

  for (const [index, member] of configured.entries()) {
    const persisted = member.configured !== false;
    const reservedGeneratedKind = persisted
      ? generatedProfileKind(member.key)
      : undefined;
    const entry =
      member.catalogId === undefined
        ? saved.version === 1
          ? byName.get(member.agent)
          : undefined
        : byCatalogId.get(member.catalogId);
    if (entry !== undefined && reservedGeneratedKind === undefined) {
      represented.add(entry.catalogId);
    }
    const resolved: RosterMember = {
      ...member,
      cwd: catalog.workspaceRoot,
      workspaceId: catalog.workspaceId,
      ...(entry === undefined
        ? {}
        : {
            catalogId: entry.catalogId,
            ...(entry.fingerprint === undefined
              ? { definitionFingerprint: undefined }
              : { definitionFingerprint: entry.fingerprint }),
          }),
      configured: member.configured ?? true,
      mode: member.mode ?? 'normal',
      visible: member.visible ?? true,
      order: member.order ?? index,
      autoStart: member.autoStart ?? false,
    };
    members.push(resolved);
    const identityValidation =
      entry === undefined && saved.version === 2
        ? missingCatalogIdentityValidation(member)
        : validation(entry, member.agent);
    validations.set(
      resolved.key,
      reservedGeneratedKind === undefined
        ? identityValidation
        : generatedIdCollisionValidation(
            member,
            reservedGeneratedKind,
            identityValidation,
          ),
    );
  }

  for (const entry of catalog.entries) {
    if (represented.has(entry.catalogId) || entry.hidden || entry.mode === 'internal') continue;
    const member = profileFromEntry(
      entry,
      allocateOwnedOrGeneratedProfileId(
        'virtual',
        catalog.workspaceId,
        entry.catalogId,
        entry.agentName,
        durableRecords,
        usedProfileIds,
        durableProfileIds,
      ),
      members.length,
      false,
    );
    members.push(member);
    validations.set(member.key, validation(entry, entry.agentName));
  }

  // Council Review is an explicit internal profile only when the definition
  // declares internal metadata. No filename-prefix hiding or classification.
  const councilEntry = catalog.entries.find(
    (entry) =>
      entry.agentName === 'council-lead' &&
      entry.mode === 'internal' &&
      entry.launchability.launchable,
  );
  let councilProfileId: string | undefined;
  if (councilEntry !== undefined) {
    const existingCouncil = members.find(
      (member) =>
        member.configured === false &&
        generatedProfileKind(member.key) === 'internal' &&
        member.mode === 'internal' &&
        member.catalogId === councilEntry.catalogId &&
        member.agent === councilEntry.agentName,
    );
    if (existingCouncil !== undefined) {
      councilProfileId = existingCouncil.key;
    } else {
      councilProfileId = allocateOwnedOrGeneratedProfileId(
        'internal',
        catalog.workspaceId,
        councilEntry.catalogId,
        councilEntry.agentName,
        durableRecords,
        usedProfileIds,
        durableProfileIds,
      );
      const council = profileFromEntry(
        councilEntry,
        councilProfileId,
        members.length,
        false,
        'internal',
      );
      members.push(council);
      validations.set(council.key, validation(councilEntry, councilEntry.agentName));
    }
  }

  // A launched virtual profile has no persisted preference by design. Its
  // exact binding therefore carries the minimum durable identity needed to
  // keep the station recoverable if the definition is later removed.
  for (const binding of [...bindings, ...pendingLaunches]) {
    if (
      binding.workspaceId !== catalog.workspaceId ||
      !/^profile-(virtual|internal)-/.test(binding.profileId) ||
      members.some((member) => member.key === binding.profileId)
    ) {
      continue;
    }
    const entry = byCatalogId.get(binding.catalogId);
    const recovered: RosterMember = {
      key: binding.profileId,
      label: entry?.label ?? binding.agentName,
      agent: binding.agentName,
      cwd: catalog.workspaceRoot,
      workspaceId: catalog.workspaceId,
      catalogId: binding.catalogId,
      definitionFingerprint: entry?.fingerprint ?? binding.definitionFingerprint,
      configured: false,
      mode: binding.profileId.startsWith('profile-internal-') ? 'internal' : 'normal',
      visible: !binding.profileId.startsWith('profile-internal-'),
      order: members.length,
      autoStart: false,
    };
    members.push(recovered);
    usedProfileIds.add(recovered.key);
    validations.set(
      recovered.key,
      durableIdentityValidation(binding, entry, durableRecords),
    );
  }

  return {
    config: {
      version: saved.version,
      members: members.sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key),
      ),
      pollIntervalMs: saved.pollIntervalMs,
    },
    validations,
    catalogProblems: [
      ...catalog.diagnostics.map((problem) => ({
        path: problem.path,
        message: problem.message,
      })),
      ...suppressedConfigured.map((member) => ({
        path: member.key,
        message:
          `Configured profile id "${member.key}" was suppressed because an exact ` +
          'durable generated session record owns that identity.',
      })),
    ],
    councilProfileId,
    ignoredLegacyPlaceholders,
  };
}
