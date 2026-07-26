/**
 * Reading agent-team state from `<config>/teams/` and `<config>/tasks/`.
 *
 * IMPORTANT — teams are not the squad. The original spec assumed the five
 * specialists could be modelled as a persistent team, and the shipped runtime
 * does not work that way:
 *
 *  - Teams are experimental and off unless CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.
 *  - There is exactly one team per session, named `session-<first 8 of session id>`.
 *  - `<config>/teams/<team>/` is deleted when the lead session ends;
 *    `<config>/tasks/<team>/` persists so resumed sessions keep their tasks.
 *  - The docs explicitly warn against pre-authoring or hand-editing the config,
 *    because it holds runtime state that is overwritten on the next update.
 *
 * So the squad is five background sessions dispatched with `--agent`, and this
 * module is strictly read-only observation of whatever huddles happen to exist.
 * Teammates genuinely do not appear in `claude agents --json`, which is why the
 * unified roster still merges this source.
 */

import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { ClaudePaths } from '../paths.js';
import type { ParseProblem, TeamMember, TeamSnapshot, TeamTask } from '../types.js';

interface RawTeamConfig {
  readonly members?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseMembers(value: unknown): TeamMember[] {
  if (!Array.isArray(value)) return [];
  const members: TeamMember[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = asString(record['name']);
    if (name === undefined) continue;
    members.push({
      name,
      agentId: asString(record['agentId']) ?? asString(record['agent_id']),
      // Present for the lead ('team-lead'), and for teammates only when they
      // were spawned from a subagent definition.
      agentType: asString(record['agentType']) ?? asString(record['agent_type']),
    });
  }
  return members;
}

function parseTask(id: string, value: unknown): TeamTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const dependsOnRaw = record['dependsOn'] ?? record['depends_on'];
  return {
    id: asString(record['id']) ?? id,
    name: asString(record['name']) ?? asString(record['title']) ?? asString(record['description']),
    state: asString(record['state']) ?? asString(record['status']),
    assignee: asString(record['assignee']) ?? asString(record['owner']),
    dependsOn: Array.isArray(dependsOnRaw)
      ? dependsOnRaw.filter((d): d is string => typeof d === 'string')
      : [],
  };
}

async function readTasks(dir: string): Promise<{ tasks: TeamTask[]; problems: ParseProblem[] }> {
  const tasks: TeamTask[] = [];
  const problems: ParseProblem[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { tasks, problems };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const id = entry.replace(/\.json$/, '');
      // A file may hold one task or an array of them; both are accepted.
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const task = parseTask(id, item);
          if (task !== undefined) tasks.push(task);
        }
      } else {
        const task = parseTask(id, parsed);
        if (task !== undefined) tasks.push(task);
      }
    } catch (err) {
      // Parse failures are "needs attention", never a crash. Task claiming uses
      // file locking, so a concurrent claim can be observed mid-write.
      problems.push({ path: file, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { tasks, problems };
}

/** Lists team directory names currently on disk. Absent directory means no teams, not an error. */
export async function listTeams(paths: ClaudePaths): Promise<string[]> {
  try {
    return await readdir(paths.teamsDir());
  } catch {
    return [];
  }
}

export async function readTeam(paths: ClaudePaths, team: string): Promise<TeamSnapshot> {
  const problems: ParseProblem[] = [];
  let members: TeamMember[] = [];

  const configFile = paths.teamConfigFile(team);
  try {
    const parsed = JSON.parse(await readFile(configFile, 'utf8')) as RawTeamConfig;
    members = parseMembers(parsed.members);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      problems.push({ path: configFile, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const { tasks, problems: taskProblems } = await readTasks(paths.teamTasksDir(team));
  problems.push(...taskProblems);

  return { team, members, tasks, parseErrors: problems };
}

export async function readAllTeams(paths: ClaudePaths): Promise<TeamSnapshot[]> {
  const teams = await listTeams(paths);
  return Promise.all(teams.map((team) => readTeam(paths, team)));
}

/**
 * Recovers the lead's session id prefix from a team name.
 *
 * Team names are `session-<first 8 chars of the lead's session id>`, which is
 * also the daemon's short id, so this links a huddle back to its roster row.
 */
export function leadShortIdFromTeamName(team: string): string | undefined {
  const match = /^session-([0-9a-f]{8})$/i.exec(team);
  return match?.[1];
}
