/**
 * Gate script tests — these execute the real bash script.
 *
 * The exit code is the entire contract: 2 blocks and feeds stderr back to
 * Claude, 0 lets the completion through. A gate that silently returns 0 is
 * worse than no gate, so each branch is exercised against a real story tree.
 *
 * The PowerShell twin is not executed here (no pwsh on macOS CI); it is
 * maintained as a behavioural mirror and covered by the Windows smoke run.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'gates',
  'story-gate.sh',
);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface GateRun {
  readonly code: number;
  readonly stderr: string;
}

function runGate(event: string, projectDir: string, payload: unknown): Promise<GateRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [GATE, event], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function project(stories: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'muster-gate-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'stories'), { recursive: true });
  for (const [name, contents] of Object.entries(stories)) {
    await writeFile(path.join(root, 'stories', name), contents);
  }
  return root;
}

const story = (fields: Record<string, string>): string =>
  ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', 'Body.'].join('\n');

describe('story-gate.sh TaskCompleted', () => {
  it('allows a story that traces to the PRD and passes acceptance', async () => {
    const root = await project({
      'MER-101.md': story({ id: 'MER-101', prd_ref: '§1.2', acceptance: 'true', status: 'done' }),
    });
    const run = await runGate('TaskCompleted', root, { task_name: 'Finish MER-101', task_id: 't1' });
    expect(run.code).toBe(0);
  });

  it('blocks when the acceptance command fails', async () => {
    const root = await project({
      'MER-101.md': story({ id: 'MER-101', prd_ref: '§1.2', acceptance: 'exit 3', status: 'done' }),
    });
    const run = await runGate('TaskCompleted', root, { task_name: 'Finish MER-101', task_id: 't1' });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('acceptance command failed');
    expect(run.stderr).toContain('exit 3');
  });

  it('blocks when prd_ref is missing', async () => {
    const root = await project({
      'MER-101.md': story({ id: 'MER-101', acceptance: 'true', status: 'done' }),
    });
    const run = await runGate('TaskCompleted', root, { task_name: 'Finish MER-101', task_id: 't1' });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("missing 'prd_ref'");
  });

  it('blocks when the story has no acceptance command', async () => {
    // A story with nothing machine-checkable cannot be verified, so it is not done.
    const root = await project({ 'MER-101.md': story({ id: 'MER-101', prd_ref: '§1' }) });
    const run = await runGate('TaskCompleted', root, { task_name: 'MER-101', task_id: 't1' });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("missing 'acceptance'");
  });

  it('includes the failing command output in the reason', async () => {
    const root = await project({
      'MER-101.md': story({
        id: 'MER-101',
        prd_ref: '§1',
        acceptance: 'echo "3 tests failed"; exit 1',
      }),
    });
    const run = await runGate('TaskCompleted', root, { task_name: 'MER-101', task_id: 't1' });
    expect(run.stderr).toContain('3 tests failed');
  });

  it('allows a task that maps to no story', async () => {
    // Not every task is a story; gating unrelated work would wedge the squad.
    const root = await project({ 'MER-101.md': story({ id: 'MER-101', prd_ref: '§1', acceptance: 'true' }) });
    const run = await runGate('TaskCompleted', root, { task_name: 'Tidy the changelog', task_id: 't9' });
    expect(run.code).toBe(0);
  });

  it('stays out of the way in a project with no stories directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'muster-nogate-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const run = await runGate('TaskCompleted', root, { task_name: 'anything' });
    expect(run.code).toBe(0);
  });
});

describe('story-gate.sh TeammateIdle', () => {
  it('blocks going idle while a finished story fails its gate', async () => {
    const root = await project({
      'MER-101.md': story({ id: 'MER-101', prd_ref: '§1', acceptance: 'true', status: 'done' }),
      'MER-102.md': story({ id: 'MER-102', prd_ref: '§2', acceptance: 'exit 1', status: 'done' }),
    });
    const run = await runGate('TeammateIdle', root, { teammate_name: 'Bram', reason: 'task_complete' });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Bram');
    expect(run.stderr).toContain('MER-102.md');
    expect(run.stderr).not.toContain('MER-101.md');
  });

  it('ignores stories still in progress', async () => {
    // Only stories the squad has marked finished are re-checked.
    const root = await project({
      'MER-101.md': story({ id: 'MER-101', prd_ref: '§1', acceptance: 'exit 1', status: 'in_progress' }),
    });
    const run = await runGate('TeammateIdle', root, { teammate_name: 'Bram' });
    expect(run.code).toBe(0);
  });

  it('allows idling when every finished story passes', async () => {
    const root = await project({
      'MER-101.md': story({ id: 'MER-101', prd_ref: '§1', acceptance: 'true', status: 'done' }),
    });
    const run = await runGate('TeammateIdle', root, { teammate_name: 'Bram' });
    expect(run.code).toBe(0);
  });

  it('tells the agent not to edit the check to make it pass', async () => {
    const root = await project({
      'MER-101.md': story({ id: 'MER-101', prd_ref: '§1', acceptance: 'exit 1', status: 'done' }),
    });
    const run = await runGate('TeammateIdle', root, {});
    expect(run.stderr).toContain('Do not edit the acceptance command');
  });
});

describe('story-gate.sh guards', () => {
  it('exits 0 for an event it does not handle', async () => {
    const root = await project({ 'a.md': story({ id: 'a', prd_ref: '§1', acceptance: 'exit 1' }) });
    expect((await runGate('PostToolUse', root, {})).code).toBe(0);
  });

  it('exits 0 with no event argument', async () => {
    const root = await project({});
    expect((await runGate('', root, {})).code).toBe(0);
  });
});
