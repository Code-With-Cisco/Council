/**
 * Work-board and path tests.
 *
 * The board renders files the agents own, so the important property is that a
 * malformed story degrades to a marked card and never takes the board down.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { boardCounts, readBoard, worktreeBoards } from '../src/integration/board/read.js';
import { ClaudePaths, claudeConfigDir } from '../src/integration/paths.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function scaffoldProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'decagram-board-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'epics'), { recursive: true });
  await mkdir(path.join(root, 'stories'), { recursive: true });

  await writeFile(path.join(root, 'docs', 'prd.md'), '# Meridian PRD\n\n## §1 Scope\n');
  await writeFile(path.join(root, 'epics', 'epic-1.md'), '---\nid: epic-1\ntitle: Ingest\n---\n');
  await writeFile(path.join(root, 'epics', 'epic-2.md'), '---\nid: epic-2\ntitle: Reporting\n---\n');

  await writeFile(
    path.join(root, 'stories', 'MER-101.md'),
    ['---', 'id: MER-101', 'title: Parse uploads', 'epic: epic-1', 'prd_ref: "§1.2"', 'acceptance: npm test -- upload', 'status: done', 'gate: pass', '---', '', 'Body.'].join('\n'),
  );
  await writeFile(
    path.join(root, 'stories', 'MER-102.md'),
    ['---', 'id: MER-102', 'epic: epic-1', 'acceptance: npm test -- retry', 'status: review', 'gate: fail', '---', '', '# Retry failed uploads'].join('\n'),
  );
  // Deliberately broken frontmatter — must become a marked card, not a crash.
  await writeFile(path.join(root, 'stories', 'MER-103.md'), '---\nid: [unclosed\n---\nBody\n');

  return root;
}

describe('readBoard', () => {
  it('groups stories under their epics', async () => {
    const board = await readBoard(await scaffoldProject());
    const epic1 = board.epics.find((epic) => epic.id === 'epic-1');
    expect(epic1?.title).toBe('Ingest');
    expect(epic1?.stories.map((s) => s.id).sort()).toEqual(['MER-101', 'MER-102']);
  });

  it('makes an unparseable story an orphan rather than guessing its epic', async () => {
    // MER-103's frontmatter is broken, so its `epic` field is unreadable. It
    // cannot be attributed to a column, so it surfaces as an orphan and as a
    // problem — visible and flagged, never silently filed under the wrong epic.
    const board = await readBoard(await scaffoldProject());
    expect(board.orphanStories.map((s) => s.id)).toEqual(['MER-103']);
    expect(board.problems.map((p) => path.basename(p.path))).toContain('MER-103.md');
  });

  it('marks an epic with no stories as unspecced', async () => {
    const board = await readBoard(await scaffoldProject());
    expect(board.epics.find((epic) => epic.id === 'epic-2')?.unspecced).toBe(true);
  });

  it('reads traceability and acceptance fields', async () => {
    const board = await readBoard(await scaffoldProject());
    const story = board.epics.flatMap((e) => e.stories).find((s) => s.id === 'MER-101');
    expect(story?.prdRef).toBe('§1.2');
    expect(story?.acceptance).toBe('npm test -- upload');
    expect(story?.gate).toBe('pass');
  });

  it('records a missing prd_ref without failing', async () => {
    const board = await readBoard(await scaffoldProject());
    const story = board.epics.flatMap((e) => e.stories).find((s) => s.id === 'MER-102');
    expect(story?.prdRef).toBeUndefined();
    // Falls back to the first heading when frontmatter has no title.
    expect(story?.title).toBe('Retry failed uploads');
  });

  it('turns a parse failure into a needs-attention problem', async () => {
    const board = await readBoard(await scaffoldProject());
    expect(board.problems.length).toBeGreaterThan(0);
    expect(board.problems[0]?.path).toContain('MER-103.md');
    // And the rest of the board still renders.
    expect(board.epics).toHaveLength(2);
  });

  it('reads the PRD title', async () => {
    const board = await readBoard(await scaffoldProject());
    expect(board.prd.exists).toBe(true);
    expect(board.prd.title).toBe('Meridian PRD');
  });

  it('returns an empty board for a project with no pipeline files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'decagram-empty-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const board = await readBoard(root);
    expect(board.epics).toEqual([]);
    expect(board.prd.exists).toBe(false);
    expect(board.problems).toEqual([]);
  });
});

describe('boardCounts', () => {
  it('reports real fractions only', async () => {
    // The design spec forbids a determinate meter without a real denominator,
    // so these are counts of things that exist, never a synthesised percentage.
    const counts = boardCounts(await readBoard(await scaffoldProject()));
    expect(counts).toEqual({ epicsSpecced: 1, epicsTotal: 2, gatesPassing: 1, gatesTotal: 3 });
  });
});

describe('worktreeBoards', () => {
  it('lists worktrees background sessions may be editing in', async () => {
    const root = await scaffoldProject();
    await mkdir(path.join(root, '.claude', 'worktrees', 'MER-101'), { recursive: true });
    expect((await worktreeBoards(root)).map((p) => path.basename(p))).toEqual(['MER-101']);
  });

  it('returns nothing when isolation is unused', async () => {
    expect(await worktreeBoards(await scaffoldProject())).toEqual([]);
  });
});

describe('claudeConfigDir', () => {
  it('honours CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/custom/claude' } })).toBe('/custom/claude');
  });

  it('ignores an empty override', () => {
    expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '   ' }, home: '/home/me' })).toBe(
      path.join('/home/me', '.claude'),
    );
  });

  it('derives every state path from the config directory', () => {
    const paths = new ClaudePaths({ configDir: '/custom/claude' });
    expect(paths.jobStateFile('abc12345')).toBe(path.join('/custom/claude', 'jobs', 'abc12345', 'state.json'));
    expect(paths.pinsFile()).toBe(path.join('/custom/claude', 'jobs', 'pins.json'));
    expect(paths.teamConfigFile('session-abc12345')).toBe(
      path.join('/custom/claude', 'teams', 'session-abc12345', 'config.json'),
    );
    // The app's own writable subtree — the only place it writes under <config>.
    expect(paths.receiverFile()).toBe(path.join('/custom/claude', 'decagram-council', 'receiver.json'));
  });
});
