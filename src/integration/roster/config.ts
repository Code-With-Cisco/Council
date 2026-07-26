/**
 * The app's own roster preferences: named launch profiles layered over the
 * agent definitions currently visible from a project.
 *
 * This file belongs to Decagram Council, not to Claude Code, so it is stored in the app's
 * data directory rather than under `<config>`. The Claude config directory is
 * read-only to this app apart from its own hook scripts.
 *
 * Discovered definitions are merged in memory and are never started
 * automatically. The editable file remains the place for labels, prompts,
 * model overrides, and intentionally persistent profiles.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  generatedProfileKind,
  isValidProfileId,
} from '../../profileIdentity.js';
import { writeJsonAtomic } from '../../config/atomicJson.js';
import type { AgentDefinition } from '../fs/agentDefs.js';
import type { RosterConfig, RosterMember } from '../types.js';

const LEGACY_PLACEHOLDER_AGENTS = new Set(['arden', 'bram', 'rook', 'tess', 'sage']);

/**
 * Poll cadence for `agents --json`. Hooks are the fast path; this is
 * reconciliation, so it exists to correct drift, not to drive the UI.
 */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * First-run preferences deliberately contain no invented agents. The live
 * catalog comes from `.claude/agents` discovery and is merged by
 * `mergeDiscoveredAgents`.
 */
export function defaultRosterConfig(_homeProject: string): RosterConfig {
  return {
    version: 2,
    members: [],
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

export interface RosterDiscoveryMerge {
  readonly config: RosterConfig;
  /** Agent names added as virtual, on-demand launch profiles. */
  readonly discoveredAgents: readonly string[];
  /** True when the obsolete generated five-name placeholder roster was ignored. */
  readonly ignoredLegacyPlaceholders: boolean;
}

function displayName(agent: string): string {
  const acronyms = new Map([
    ['ai', 'AI'],
    ['llm', 'LLM'],
    ['prd', 'PRD'],
    ['qa', 'QA'],
    ['ui', 'UI'],
  ]);
  return agent
    .split(/[-_\s]+/)
    .filter((part) => part !== '')
    .map((part) => acronyms.get(part.toLowerCase()) ?? `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function roleSummary(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const normalized = description.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117).trimEnd()}…`;
}

function isGeneratedLegacyPlaceholderRoster(members: readonly RosterMember[]): boolean {
  return (
    members.length === LEGACY_PLACEHOLDER_AGENTS.size &&
    members.every(
      (member) =>
        (member.legacyKey ?? member.key) === member.agent &&
        LEGACY_PLACEHOLDER_AGENTS.has(member.agent) &&
        member.bootPrompt === undefined &&
        member.model === undefined &&
        member.effort === undefined,
    )
  );
}

function opaqueId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

/**
 * Layers effective on-disk definitions over saved launch preferences.
 *
 * The first definition for a name is the one Claude's current precedence rules
 * select (project definitions are returned before user definitions). Saved
 * members win for label/order/overrides. Newly discovered agents are virtual:
 * the user must still click Start, and the preferences file is not rewritten.
 */
export function mergeDiscoveredAgents(
  config: RosterConfig,
  definitions: readonly AgentDefinition[],
  projectDir: string,
): RosterDiscoveryMerge {
  const effective = new Map<string, AgentDefinition>();
  for (const definition of definitions) {
    if (!effective.has(definition.name)) effective.set(definition.name, definition);
  }

  const ignoreLegacy =
    isGeneratedLegacyPlaceholderRoster(config.members) &&
    !config.members.some((member) => effective.has(member.agent));
  const configured = ignoreLegacy ? [] : [...config.members];
  const represented = new Set(configured.map((member) => member.agent));
  const usedKeys = new Set(configured.map((member) => member.key));
  const discovered: string[] = [];

  for (const definition of [...effective.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (represented.has(definition.name)) continue;

    const catalogId = opaqueId('catalog', path.resolve(projectDir), definition.name);
    let key = opaqueId('profile-virtual', catalogId);
    let suffix = 2;
    while (usedKeys.has(key)) key = `${opaqueId('profile-virtual', catalogId)}-${suffix++}`;

    const role = roleSummary(definition.description);
    const member: RosterMember = {
      key,
      label: displayName(definition.name),
      agent: definition.name,
      cwd: path.resolve(projectDir),
      catalogId,
      configured: false,
      mode: 'normal',
      visible: true,
      order: configured.length,
      autoStart: false,
      ...(role === undefined ? {} : { role }),
      ...(definition.model === undefined ? {} : { model: definition.model }),
    };
    configured.push(member);
    represented.add(definition.name);
    usedKeys.add(key);
    discovered.push(definition.name);
  }

  return {
    config: { ...config, members: configured },
    discoveredAgents: discovered,
    ignoredLegacyPlaceholders: ignoreLegacy,
  };
}

export interface RosterConfigLoad {
  readonly config: RosterConfig;
  /**
   * Problems found while reading. The config is user-editable, so a bad edit
   * must degrade to defaults with a visible explanation rather than crash the
   * app the user needs in order to fix it.
   */
  readonly problems: readonly string[];
  readonly createdDefault: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  location: string,
  problems: string[],
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    problems.push(`${location} has a non-string "${key}"`);
    return undefined;
  }
  return asString(value);
}

function optionalBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fallback: boolean,
  location: string,
  problems: string[],
): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    problems.push(`${location} has a non-boolean "${key}"`);
    return fallback;
  }
  return value;
}

function optionalOrder(
  record: Readonly<Record<string, unknown>>,
  fallback: number,
  location: string,
  problems: string[],
): number {
  const value = record['order'];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    problems.push(`${location} has an invalid non-negative integer "order"`);
    return fallback;
  }
  return value;
}

function coerceV1Member(
  value: unknown,
  index: number,
  problems: string[],
  homeProject: string,
  workspaceId: string,
): RosterMember | undefined {
  if (typeof value !== 'object' || value === null) {
    problems.push(`members[${index}] is not an object`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const key = asString(record['key']);
  const agent = asString(record['agent']);
  const cwd = asString(record['cwd']);

  if (key === undefined) {
    problems.push(`members[${index}] is missing "key"`);
    return undefined;
  }
  if (agent === undefined) {
    problems.push(`members[${index}] ("${key}") is missing "agent"`);
    return undefined;
  }
  if (cwd === undefined) {
    problems.push(`members[${index}] ("${key}") is missing "cwd"`);
    return undefined;
  }

  return {
    key: opaqueId('profile-v1', workspaceId, key),
    legacyKey: key,
    label: asString(record['label']) ?? key,
    agent,
    // Resolve relative legacy paths against the selected workspace, never the
    // packaged application's current working directory.
    cwd: path.resolve(homeProject, cwd),
    role: asString(record['role']),
    bootPrompt: asString(record['bootPrompt']),
    model: asString(record['model']),
    effort: asString(record['effort']),
    workspaceId,
    configured: true,
    mode: 'normal',
    visible: true,
    order: index,
    autoStart: false,
  };
}

function coerceV2Profile(
  value: unknown,
  index: number,
  problems: string[],
  homeProject: string,
): RosterMember | undefined {
  if (typeof value !== 'object' || value === null) {
    problems.push(`profiles[${index}] is not an object`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record['id']);
  const workspaceId = asString(record['workspaceId']);
  const catalogId = asString(record['catalogId']);
  const agent = asString(record['agentName']) ?? asString(record['agent']);
  if (!isValidProfileId(id)) {
    problems.push(`profiles[${index}] has an invalid opaque "id"`);
    return undefined;
  }
  const reservedKind = generatedProfileKind(id);
  if (reservedKind !== undefined) {
    problems.push(
      `profiles[${index}] ("${id}") uses the reserved generated ${reservedKind} profile namespace`,
    );
    return undefined;
  }
  if (workspaceId === undefined) {
    problems.push(`profiles[${index}] ("${id}") is missing "workspaceId"`);
    return undefined;
  }
  if (catalogId === undefined) {
    problems.push(`profiles[${index}] ("${id}") is missing "catalogId"`);
    return undefined;
  }
  if (agent === undefined) {
    problems.push(`profiles[${index}] ("${id}") is missing "agentName"`);
    return undefined;
  }
  const mode = record['mode'];
  if (mode !== undefined && mode !== 'normal' && mode !== 'internal') {
    problems.push(`profiles[${index}] ("${id}") has an invalid "mode"`);
    return undefined;
  }
  const location = `profiles[${index}] ("${id}")`;
  return {
    key: id,
    label: optionalString(record, 'label', location, problems) ?? agent,
    agent,
    cwd: path.resolve(homeProject),
    role: optionalString(record, 'role', location, problems),
    bootPrompt: optionalString(record, 'bootPrompt', location, problems),
    model: optionalString(record, 'model', location, problems),
    effort: optionalString(record, 'effort', location, problems),
    workspaceId,
    catalogId,
    configured: true,
    mode: mode ?? 'normal',
    visible: optionalBoolean(record, 'visible', true, location, problems),
    order: optionalOrder(record, index, location, problems),
    autoStart: optionalBoolean(record, 'autoStart', false, location, problems),
    permissionMode: optionalString(record, 'permissionMode', location, problems),
    definitionFingerprint: optionalString(
      record,
      'definitionFingerprint',
      location,
      problems,
    ),
  };
}

export function parseRosterConfig(
  value: unknown,
  fallback: RosterConfig,
  homeProject = '.',
  workspaceId = 'workspace-legacy',
): RosterConfigLoad {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return { config: fallback, problems: ['roster config is not a JSON object'], createdDefault: false };
  }

  const record = value as Record<string, unknown>;
  const version = record['version'] === undefined ? 1 : record['version'];
  if (version !== 1 && version !== 2) {
    return {
      config: fallback,
      problems: [`unsupported roster config version "${String(version)}"`],
      createdDefault: false,
    };
  }
  const rawMembers = version === 1 ? record['members'] : record['profiles'];
  if (!Array.isArray(rawMembers)) {
    return {
      config: fallback,
      problems: [`roster config has no "${version === 1 ? 'members' : 'profiles'}" array`],
      createdDefault: false,
    };
  }

  const members: RosterMember[] = [];
  const seen = new Set<string>();
  rawMembers.forEach((entry, index) => {
    const member =
      version === 1
        ? coerceV1Member(entry, index, problems, homeProject, workspaceId)
        : coerceV2Profile(entry, index, problems, homeProject);
    if (member === undefined) return;
    // Duplicate keys would make two cards fight over one identity slot.
    if (seen.has(member.key)) {
      problems.push(`duplicate profile id "${member.key}" — keeping the first`);
      return;
    }
    seen.add(member.key);
    members.push(member);
  });

  if (rawMembers.length > 0 && members.length === 0) {
    return { config: fallback, problems: [...problems, 'no usable members'], createdDefault: false };
  }

  const pollRaw = record['pollIntervalMs'];
  // Floor the interval: a config typo of 10 would spawn a CLI process per
  // 10ms and pin a core, which the user would experience as the app hanging.
  const pollIntervalMs =
    typeof pollRaw === 'number' && Number.isFinite(pollRaw) && pollRaw >= 1_000
      ? pollRaw
      : DEFAULT_POLL_INTERVAL_MS;
  if (pollRaw !== undefined && pollIntervalMs !== pollRaw) {
    problems.push(`pollIntervalMs must be a number >= 1000; using ${DEFAULT_POLL_INTERVAL_MS}`);
  }

  return {
    config: {
      version,
      members: [...members].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key),
      ),
      pollIntervalMs,
    },
    problems,
    createdDefault: false,
  };
}

/** Loads preferences without persisting a new schema merely because the app opened. */
export async function loadRosterConfig(
  file: string,
  homeProject: string,
  workspaceId = 'workspace-legacy',
): Promise<RosterConfigLoad> {
  const fallback = defaultRosterConfig(homeProject);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: fallback, problems: [], createdDefault: false };
    }
    return {
      config: fallback,
      problems: [err instanceof Error ? err.message : String(err)],
      createdDefault: false,
    };
  }

  try {
    return parseRosterConfig(JSON.parse(text), fallback, homeProject, workspaceId);
  } catch (err) {
    return {
      config: fallback,
      problems: [`roster config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
      createdDefault: false,
    };
  }
}

/** Writes via a temp file and rename, so a crash mid-write cannot truncate the user's config. */
function persistedRosterConfig(config: RosterConfig): unknown {
  return (
    config.version === 1
      ? {
          version: 1,
          members: config.members.map((member) => ({
            key: member.legacyKey ?? member.key,
            label: member.label,
            agent: member.agent,
            cwd: member.cwd,
            ...(member.role === undefined ? {} : { role: member.role }),
            ...(member.bootPrompt === undefined ? {} : { bootPrompt: member.bootPrompt }),
            ...(member.model === undefined ? {} : { model: member.model }),
            ...(member.effort === undefined ? {} : { effort: member.effort }),
          })),
          pollIntervalMs: config.pollIntervalMs,
        }
      : {
          version: 2,
          profiles: config.members
            .filter((member) => member.configured !== false)
            .map((member, index) => ({
              id: member.key,
              workspaceId: member.workspaceId,
              catalogId: member.catalogId,
              agentName: member.agent,
              label: member.label,
              order: member.order ?? index,
              visible: member.visible ?? true,
              mode: member.mode ?? 'normal',
              autoStart: member.autoStart ?? false,
              ...(member.role === undefined ? {} : { role: member.role }),
              ...(member.bootPrompt === undefined ? {} : { bootPrompt: member.bootPrompt }),
              ...(member.model === undefined ? {} : { model: member.model }),
              ...(member.effort === undefined ? {} : { effort: member.effort }),
              ...(member.permissionMode === undefined
                ? {}
                : { permissionMode: member.permissionMode }),
              ...(member.definitionFingerprint === undefined
                ? {}
                : { definitionFingerprint: member.definitionFingerprint }),
            })),
          pollIntervalMs: config.pollIntervalMs,
        }
  );
}

function rosterConfigRevision(config: RosterConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(persistedRosterConfig(config)))
    .digest('hex');
}

export async function saveRosterConfig(file: string, config: RosterConfig): Promise<void> {
  await writeJsonAtomic(file, persistedRosterConfig(config));
}

export interface RosterConfigStoreLoad extends RosterConfigLoad {
  readonly source: 'disk' | 'missing' | 'last-known-good' | 'safe-default';
  readonly writeBlocked: boolean;
}

export interface RosterConfigStoreOptions {
  readonly readText?: ((file: string) => Promise<string>) | undefined;
  readonly writeConfig?: ((file: string, config: RosterConfig) => Promise<void>) | undefined;
}

export class RosterConfigWriteBlockedError extends Error {
  override readonly name = 'RosterConfigWriteBlockedError';
}

/**
 * Stateful profile-preference store. A malformed external edit leaves the
 * active normalized profiles untouched and blocks writes until a valid reload.
 */
export class RosterConfigStore {
  private configValue: RosterConfig;
  private problemsValue: readonly string[] = [];
  private hasKnownGood = false;
  private blocked = false;
  private diskStateKnown = false;
  private diskExists = false;
  private diskRevision: string | undefined;
  private readonly readText: (file: string) => Promise<string>;
  private readonly writeConfig: (file: string, config: RosterConfig) => Promise<void>;

  constructor(
    readonly file: string,
    readonly homeProject: string,
    readonly workspaceId: string,
    options: RosterConfigStoreOptions = {},
  ) {
    this.configValue = defaultRosterConfig(homeProject);
    this.readText = options.readText ?? ((target) => readFile(target, 'utf8'));
    this.writeConfig = options.writeConfig ?? saveRosterConfig;
  }

  get current(): RosterConfig {
    return this.configValue;
  }

  get problems(): readonly string[] {
    return this.problemsValue;
  }

  get writeBlocked(): boolean {
    return this.blocked;
  }

  async load(): Promise<RosterConfigStoreLoad> {
    let text: string;
    try {
      text = await this.readText(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const fallback = defaultRosterConfig(this.homeProject);
        this.configValue = fallback;
        this.problemsValue = [];
        this.hasKnownGood = true;
        this.blocked = false;
        this.diskStateKnown = true;
        this.diskExists = false;
        this.diskRevision = undefined;
        return {
          config: fallback,
          problems: [],
          createdDefault: false,
          source: 'missing',
          writeBlocked: false,
        };
      }
      return this.retain(
        error instanceof Error ? error.message : String(error),
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return this.retain(
        `roster config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const fallback = this.configValue;
    const parsed = parseRosterConfig(
      raw,
      fallback,
      this.homeProject,
      this.workspaceId,
    );
    // Any schema problem makes the complete edit untrusted. Partial recovery
    // would silently drop or rewrite the malformed profile on a later save.
    if (parsed.problems.length > 0) {
      return this.retain(parsed.problems.join(' · '));
    }
    this.configValue = parsed.config;
    this.problemsValue = parsed.problems;
    this.hasKnownGood = true;
    this.blocked = false;
    this.diskStateKnown = true;
    this.diskExists = true;
    this.diskRevision = rosterConfigRevision(parsed.config);
    return {
      ...parsed,
      source: 'disk',
      writeBlocked: false,
    };
  }

  reload(): Promise<RosterConfigStoreLoad> {
    return this.load();
  }

  async save(config: RosterConfig): Promise<void> {
    if (this.blocked) {
      throw new RosterConfigWriteBlockedError(
        `Refusing to overwrite profile preferences at ${this.file}.`,
      );
    }

    let currentDiskRevision: string | undefined;
    let currentDiskExists = false;
    try {
      const text = await this.readText(this.file);
      currentDiskExists = true;
      const parsed = parseRosterConfig(
        JSON.parse(text) as unknown,
        this.configValue,
        this.homeProject,
        this.workspaceId,
      );
      // Parsing is intentionally all-or-nothing here. parseRosterConfig also
      // returns a sanitized projection for diagnostics, but that projection is
      // never evidence that the externally edited bytes are safe to replace.
      if (parsed.problems.length > 0) {
        this.retain(parsed.problems.join(' · '));
        throw new RosterConfigWriteBlockedError(
          `Refusing to overwrite malformed profile preferences at ${this.file}.`,
        );
      }
      currentDiskRevision = rosterConfigRevision(parsed.config);
    } catch (error) {
      if (error instanceof RosterConfigWriteBlockedError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.retain(error instanceof Error ? error.message : String(error));
        throw new RosterConfigWriteBlockedError(
          `Refusing to overwrite unreadable profile preferences at ${this.file}.`,
        );
      }
    }

    // Compare the strict current document with the state observed by load (or
    // the preceding successful save). This prevents a valid external edit or
    // delete/create race from being lost to a save derived from stale memory.
    if (
      this.diskStateKnown &&
      (currentDiskExists !== this.diskExists ||
        currentDiskRevision !== this.diskRevision)
    ) {
      this.retain(
        `Profile preferences changed externally at ${this.file}; reload before saving.`,
      );
      throw new RosterConfigWriteBlockedError(
        `Refusing to overwrite externally changed profile preferences at ${this.file}.`,
      );
    }
    if (!this.diskStateKnown && currentDiskExists) {
      this.retain(
        `Profile preferences at ${this.file} were not loaded before saving.`,
      );
      throw new RosterConfigWriteBlockedError(
        `Refusing to overwrite profile preferences that were not loaded from ${this.file}.`,
      );
    }

    await this.writeConfig(this.file, config);
    this.configValue = config;
    this.problemsValue = [];
    this.hasKnownGood = true;
    this.blocked = false;
    this.diskStateKnown = true;
    this.diskExists = true;
    this.diskRevision = rosterConfigRevision(config);
  }

  private retain(problem: string): RosterConfigStoreLoad {
    this.problemsValue = [problem];
    this.blocked = true;
    return {
      config: this.configValue,
      problems: this.problemsValue,
      createdDefault: false,
      source: this.hasKnownGood ? 'last-known-good' : 'safe-default',
      writeBlocked: true,
    };
  }
}
