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

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import * as path from 'node:path';
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
    version: 1,
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
        member.key === member.agent &&
        LEGACY_PLACEHOLDER_AGENTS.has(member.agent) &&
        member.bootPrompt === undefined &&
        member.model === undefined &&
        member.effort === undefined,
    )
  );
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

    const baseKey = `agent:${definition.name}`;
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${baseKey}:${suffix}`;
      suffix += 1;
    }

    const role = roleSummary(definition.description);
    const member: RosterMember = {
      key,
      label: displayName(definition.name),
      agent: definition.name,
      cwd: path.resolve(projectDir),
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

function coerceMember(value: unknown, index: number, problems: string[]): RosterMember | undefined {
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
    key,
    label: asString(record['label']) ?? key,
    agent,
    cwd: path.resolve(cwd),
    role: asString(record['role']),
    bootPrompt: asString(record['bootPrompt']),
    model: asString(record['model']),
    effort: asString(record['effort']),
  };
}

export function parseRosterConfig(value: unknown, fallback: RosterConfig): RosterConfigLoad {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return { config: fallback, problems: ['roster config is not a JSON object'], createdDefault: false };
  }

  const record = value as Record<string, unknown>;
  const rawMembers = record['members'];
  if (!Array.isArray(rawMembers)) {
    return { config: fallback, problems: ['roster config has no "members" array'], createdDefault: false };
  }

  const members: RosterMember[] = [];
  const seen = new Set<string>();
  rawMembers.forEach((entry, index) => {
    const member = coerceMember(entry, index, problems);
    if (member === undefined) return;
    // Duplicate keys would make two cards fight over one identity slot.
    if (seen.has(member.key)) {
      problems.push(`duplicate member key "${member.key}" — keeping the first`);
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

  return { config: { version: 1, members, pollIntervalMs }, problems, createdDefault: false };
}

/** Loads the config, writing a default on first run so the file always exists to edit. */
export async function loadRosterConfig(file: string, homeProject: string): Promise<RosterConfigLoad> {
  const fallback = defaultRosterConfig(homeProject);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await saveRosterConfig(file, fallback);
      return { config: fallback, problems: [], createdDefault: true };
    }
    return {
      config: fallback,
      problems: [err instanceof Error ? err.message : String(err)],
      createdDefault: false,
    };
  }

  try {
    return parseRosterConfig(JSON.parse(text), fallback);
  } catch (err) {
    return {
      config: fallback,
      problems: [`roster config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
      createdDefault: false,
    };
  }
}

/** Writes via a temp file and rename, so a crash mid-write cannot truncate the user's config. */
export async function saveRosterConfig(file: string, config: RosterConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}
