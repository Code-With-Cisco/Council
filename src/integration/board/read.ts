/**
 * Reading the work board out of a project repo.
 *
 * The pipeline — PRD, epics, stories, gates — lives in files the agents own.
 * The app renders them and never writes them, so a parse failure is a rendered
 * "needs attention" state on the affected card, never an exception and never a
 * reason to hide the rest of the board.
 *
 * WORKTREE CAVEAT: background sessions relocate into `.claude/worktrees/<name>`
 * before editing files, so the in-flight version of a story often lives in a
 * worktree rather than the main checkout. `readBoard` reads the main checkout;
 * `worktreeBoards` enumerates the others so the UI can show which copy it is
 * looking at instead of appearing to lose edits. A project can opt out entirely
 * with `{"worktree": {"bgIsolation": "none"}}`.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ProjectPaths } from '../paths.js';
import type { ParseProblem } from '../types.js';

/** Gate outcome for a story, as the board renders it. */
export type GateStatus = 'pass' | 'fail' | 'build' | 'queue' | 'unknown';

export interface Story {
  /** Frontmatter `id`, falling back to the filename stem. */
  readonly id: string;
  readonly title: string | undefined;
  readonly file: string;
  /** Traceability to a PRD section. A story without this is blocked by the gate. */
  readonly prdRef: string | undefined;
  /** Machine-checkable command that must exit 0 for the story to be complete. */
  readonly acceptance: string | undefined;
  readonly status: string | undefined;
  readonly epic: string | undefined;
  readonly gate: GateStatus;
  readonly assignee: string | undefined;
  /** Set when this story's own file could not be understood. */
  readonly problem: string | undefined;
}

export interface Epic {
  readonly id: string;
  readonly title: string | undefined;
  readonly file: string | undefined;
  readonly stories: readonly Story[];
  /** True when the epic exists but has no stories yet — the dashed placeholder. */
  readonly unspecced: boolean;
}

export interface Board {
  readonly projectDir: string;
  readonly prd: { readonly path: string; readonly exists: boolean; readonly title: string | undefined };
  readonly epics: readonly Epic[];
  /** Stories whose frontmatter names no epic. Rendered rather than dropped. */
  readonly orphanStories: readonly Story[];
  readonly problems: readonly ParseProblem[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

interface Parsed {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly problem: string | undefined;
}

function parseDocument(text: string): Parsed {
  const match = FRONTMATTER.exec(text);
  if (match?.[1] === undefined) {
    return { data: {}, body: text, problem: 'no YAML frontmatter block' };
  }
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (typeof parsed !== 'object' || parsed === null) {
      return { data: {}, body: text.slice(match[0].length), problem: 'frontmatter is not a mapping' };
    }
    return {
      data: parsed as Record<string, unknown>,
      body: text.slice(match[0].length),
      problem: undefined,
    };
  } catch (err) {
    return {
      data: {},
      body: text.slice(match[0].length),
      problem: `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function str(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

/** First markdown heading, used when frontmatter carries no title. */
function firstHeading(body: string): string | undefined {
  return /^#{1,3}\s+(.+)$/m.exec(body)?.[1]?.trim();
}

function toGateStatus(value: string | undefined): GateStatus {
  switch (value?.toLowerCase()) {
    case 'pass':
    case 'passed':
    case 'green':
      return 'pass';
    case 'fail':
    case 'failed':
    case 'red':
      return 'fail';
    case 'build':
    case 'building':
    case 'running':
      return 'build';
    case 'queue':
    case 'queued':
    case 'pending':
      return 'queue';
    default:
      return 'unknown';
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function readStory(file: string): Promise<Story> {
  const stem = path.basename(file, '.md');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    return {
      id: stem,
      title: undefined,
      file,
      prdRef: undefined,
      acceptance: undefined,
      status: undefined,
      epic: undefined,
      gate: 'unknown',
      assignee: undefined,
      problem: err instanceof Error ? err.message : String(err),
    };
  }

  const { data, body, problem } = parseDocument(text);
  return {
    id: str(data, 'id') ?? stem,
    title: str(data, 'title', 'name') ?? firstHeading(body),
    file,
    prdRef: str(data, 'prd_ref', 'prdRef'),
    acceptance: str(data, 'acceptance', 'acceptance_command'),
    status: str(data, 'status', 'state'),
    epic: str(data, 'epic', 'epic_id', 'epicRef'),
    gate: toGateStatus(str(data, 'gate', 'gate_status')),
    assignee: str(data, 'assignee', 'owner', 'agent'),
    problem,
  };
}

async function readEpic(file: string, stories: readonly Story[]): Promise<Epic> {
  const stem = path.basename(file, '.md');
  let data: Record<string, unknown> = {};
  let body = '';
  try {
    const parsed = parseDocument(await readFile(file, 'utf8'));
    data = parsed.data;
    body = parsed.body;
  } catch {
    // An unreadable epic still renders as a column, just without its title.
  }

  const id = str(data, 'id') ?? stem;
  const mine = stories.filter((story) => story.epic === id || story.epic === stem);

  return {
    id,
    title: str(data, 'title', 'name') ?? firstHeading(body),
    file,
    stories: mine,
    unspecced: mine.length === 0,
  };
}

export async function readBoard(projectDir: string): Promise<Board> {
  const paths = new ProjectPaths(projectDir);
  const problems: ParseProblem[] = [];

  const storyFiles = await listMarkdown(paths.storiesDir());
  const stories = await Promise.all(storyFiles.map(readStory));
  for (const story of stories) {
    if (story.problem !== undefined) problems.push({ path: story.file, message: story.problem });
  }

  const epicFiles = await listMarkdown(paths.epicsDir());
  const epics = await Promise.all(epicFiles.map((file) => readEpic(file, stories)));

  const claimed = new Set(epics.flatMap((epic) => epic.stories.map((story) => story.file)));
  const orphanStories = stories.filter((story) => !claimed.has(story.file));

  const prdPath = paths.prdFile();
  let prdExists = false;
  let prdTitle: string | undefined;
  try {
    const text = await readFile(prdPath, 'utf8');
    prdExists = true;
    const parsed = parseDocument(text);
    prdTitle = str(parsed.data, 'title') ?? firstHeading(parsed.body ?? text) ?? firstHeading(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push({ path: prdPath, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    projectDir,
    prd: { path: prdPath, exists: prdExists, title: prdTitle },
    epics,
    orphanStories,
    problems,
  };
}

/**
 * Real fractions for the project strip.
 *
 * The design spec forbids a determinate meter without a real denominator, so
 * these are counts of things that exist, never a synthesised percentage.
 */
export function boardCounts(board: Board): {
  epicsSpecced: number;
  epicsTotal: number;
  gatesPassing: number;
  gatesTotal: number;
} {
  const allStories = [...board.epics.flatMap((epic) => epic.stories), ...board.orphanStories];
  return {
    epicsSpecced: board.epics.filter((epic) => !epic.unspecced).length,
    epicsTotal: board.epics.length,
    gatesPassing: allStories.filter((story) => story.gate === 'pass').length,
    gatesTotal: allStories.length,
  };
}

/**
 * Lists worktrees a background session may be editing in.
 *
 * Surfaced so the UI can tell the user which copy the board reflects, rather
 * than silently showing a stale main checkout while an agent works elsewhere.
 */
export async function worktreeBoards(projectDir: string): Promise<string[]> {
  const dir = new ProjectPaths(projectDir).worktreesDir();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const info = await stat(full).catch(() => undefined);
      if (info?.isDirectory() === true) dirs.push(full);
    }
    return dirs.sort();
  } catch {
    return [];
  }
}
