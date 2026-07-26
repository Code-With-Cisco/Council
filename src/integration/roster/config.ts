/**
 * The app's own roster config: which five specialists exist, which subagent
 * definition each one runs, and where each one lives.
 *
 * This file belongs to Muster, not to Claude Code, so it is stored in the app's
 * data directory rather than under `<config>`. The Claude config directory is
 * read-only to this app apart from its own hook scripts.
 *
 * The five keys and their identity colours are fixed by the design spec and
 * must not be renumbered: colour and sigil are keyed off `key`.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import * as path from 'node:path';
import type { RosterConfig, RosterMember } from '../types.js';

/** Identity is fixed forever per the design spec — colours and sigils key off these. */
export const SPECIALIST_KEYS = ['arden', 'bram', 'rook', 'tess', 'sage'] as const;
export type SpecialistKey = (typeof SPECIALIST_KEYS)[number];

/**
 * Poll cadence for `agents --json`. Hooks are the fast path; this is
 * reconciliation, so it exists to correct drift, not to drive the UI.
 */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** Written on first run so the user has something concrete to edit. */
export function defaultRosterConfig(homeProject: string): RosterConfig {
  const member = (key: SpecialistKey, label: string, role: string): RosterMember => ({
    key,
    label,
    agent: key,
    cwd: homeProject,
    role,
  });

  return {
    version: 1,
    members: [
      member('arden', 'Arden', 'Architecture'),
      member('bram', 'Bram', 'Implementation'),
      member('rook', 'Rook', 'Security'),
      member('tess', 'Tess', 'Testing'),
      member('sage', 'Sage', 'Research'),
    ],
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
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

  if (members.length === 0) {
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
