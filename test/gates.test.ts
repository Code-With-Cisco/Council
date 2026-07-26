import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATE_MARKER,
  POWERSHELL_GUARD_FILES,
  generateGateConfig,
  planGateInstall,
} from '../src/integration/gates/install.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'gates', 'story-gate.ps1');
const cleanups: (() => Promise<void>)[] = [];

function locatePowerShell(): string | undefined {
  for (const candidate of ['pwsh', 'powershell']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

const POWERSHELL = locatePowerShell();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface GateRun {
  readonly code: number;
  readonly stderr: string;
}

function runGate(event: string, projectDir: string, payload: unknown): Promise<GateRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL!,
      ['-NoProfile', '-NonInteractive', '-File', GATE, event],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function project(stories: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'decagram-gate-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'stories'), { recursive: true });
  for (const [name, contents] of Object.entries(stories)) {
    await writeFile(path.join(root, 'stories', name), contents);
  }
  return root;
}

const story = (fields: Record<string, string>): string =>
  ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', '', 'Body.'].join(
    '\n',
  );

describe('Windows gate configuration', () => {
  it('registers only PowerShell write, shell, and story handlers', () => {
    const config = generateGateConfig({ scriptLocation: 'source' });
    const text = JSON.stringify(config);
    expect(text).toContain('agent-write-dispatch.ps1');
    expect(text).toContain('agent-shell-dispatch.ps1');
    expect(text).toContain('story-gate.ps1');
    expect(text).toContain('"shell":"powershell"');
    expect(text).not.toContain('.sh');
    expect(config['PreToolUse']?.map((group) => group.matcher)).toEqual([
      'Edit|Write',
      'PowerShell',
    ]);
  });

  it('installs every required PowerShell script and no Bash dialect', async () => {
    const root = await project({});
    const plan = await planGateInstall(root);
    expect(plan.scriptTargets.map((target) => path.basename(target.to)).sort()).toEqual(
      [...POWERSHELL_GUARD_FILES].sort(),
    );
    expect(plan.scriptTargets.every((target) => target.to.endsWith('.ps1'))).toBe(true);
  });

  it('keeps the checked-in repo configuration equal to generated output', async () => {
    const checkedIn = JSON.parse(
      await readFile(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(checkedIn['hooks']).toEqual(generateGateConfig({ scriptLocation: 'source' }));
    expect((checkedIn['env'] as Record<string, string>)['CLAUDE_CODE_USE_POWERSHELL_TOOL']).toBe('1');
    expect(checkedIn['defaultShell']).toBe('powershell');
  });

  it('uses the Decagram Council marker', () => {
    expect(GATE_MARKER).toBe('decagram-council-story-gate');
  });
});

describe.skipIf(POWERSHELL === undefined)(
  'story-gate.ps1 (skipped when PowerShell is unavailable)',
  () => {
    it('allows a traced story whose PowerShell acceptance passes', async () => {
      const root = await project({
        'MER-101.md': story({
          id: 'MER-101',
          prd_ref: '§1.2',
          acceptance: 'node -e "process.exit(0)"',
          status: 'done',
        }),
      });
      const run = await runGate('TaskCompleted', root, {
        task_name: 'Finish MER-101',
        task_id: 't1',
      });
      expect(run.code).toBe(0);
    });

    it('blocks a failing acceptance command', async () => {
      const root = await project({
        'MER-101.md': story({
          id: 'MER-101',
          prd_ref: '§1.2',
          acceptance: 'node -e "process.exit(3)"',
          status: 'done',
        }),
      });
      const run = await runGate('TaskCompleted', root, {
        task_name: 'Finish MER-101',
        task_id: 't1',
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain('acceptance command failed');
    });

    it('rejects POSIX-only acceptance syntax', async () => {
      const root = await project({
        'MER-101.md': story({
          id: 'MER-101',
          prd_ref: '§1.2',
          acceptance: './scripts/check.sh',
          status: 'done',
        }),
      });
      const run = await runGate('TaskCompleted', root, {
        task_name: 'Finish MER-101',
        task_id: 't1',
      });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain('Windows PowerShell command');
    });
  },
);
