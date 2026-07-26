/**
 * Discovering subagent definitions so `--agent <name>` can be validated.
 *
 * This exists because of a sharp edge verified against v2.1.220: dispatching
 * with an unknown agent name does NOT fail.
 *
 *   $ claude --bg --agent __no_such_agent__ --name probe2 "say hi"
 *   warning: no agent named '__no_such_agent__' — spawning with default template
 *   backgrounded · 4f544317 · probe2
 *
 * A typo in the roster config would therefore produce a live session running a
 * generic agent under a specialist's name — the worst kind of failure, because
 * everything looks fine. Names are checked against disk before dispatch.
 *
 * Identity comes only from the `name` frontmatter field, never the filename,
 * and both directories are scanned recursively.
 */

import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentValidation } from '../types.js';
import type { ClaudePaths } from '../paths.js';

export interface AgentDefinition {
  readonly name: string;
  readonly description: string | undefined;
  readonly model: string | undefined;
  readonly file: string;
  readonly scope: 'project' | 'user';
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Extracts and parses YAML frontmatter. Returns undefined when the file has none. */
export function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  const match = FRONTMATTER.exec(text);
  if (match?.[1] === undefined) return undefined;
  try {
    const parsed: unknown = parseYaml(match[1]);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function walkMarkdown(dir: string, out: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function readDefinitions(dir: string, scope: AgentDefinition['scope']): Promise<AgentDefinition[]> {
  const files = await walkMarkdown(dir);
  const defs: AgentDefinition[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    const name = frontmatter?.['name'];
    if (typeof name !== 'string' || name === '') continue;
    const description = frontmatter?.['description'];
    const model = frontmatter?.['model'];
    defs.push({
      name,
      description: typeof description === 'string' ? description : undefined,
      model: typeof model === 'string' ? model : undefined,
      file,
      scope,
    });
  }
  return defs;
}

/**
 * Lists every definition visible from a project directory.
 *
 * Project scope is listed before user scope because it wins for a shared name.
 * Nested `.claude/agents` directories between cwd and the repo root are also
 * scanned by the CLI, with the definition closest to cwd winning; the same
 * ordering is applied here.
 */
export async function listAgentDefinitions(
  paths: ClaudePaths,
  projectDir: string | undefined,
): Promise<AgentDefinition[]> {
  const defs: AgentDefinition[] = [];

  if (projectDir !== undefined) {
    // Walk up from the project directory so the nearest definition is first.
    let current = path.resolve(projectDir);
    for (;;) {
      defs.push(...(await readDefinitions(paths.projectAgentsDir(current), 'project')));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  defs.push(...(await readDefinitions(paths.agentsDir(), 'user')));
  return defs;
}

/**
 * Checks one agent name against the definitions on disk.
 *
 * `shadowedBy` reports duplicates: when two files in the same directory declare
 * the same `name`, the CLI picks one by filesystem read order with no
 * documented precedence, so the app flags the ambiguity rather than guessing.
 */
export function validateAgentName(
  agent: string,
  definitions: readonly AgentDefinition[],
): AgentValidation {
  const matches = definitions.filter((def) => def.name === agent);
  const winner = matches[0];
  return {
    agent,
    found: winner !== undefined,
    path: winner?.file,
    shadowedBy: matches.slice(1).map((def) => def.file),
  };
}
