import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCHER = path.join(REPO_ROOT, 'scripts', 'gates', 'agent-write-dispatch.ps1');
const cleanups: (() => Promise<void>)[] = [];

function locatePowerShell(): string | undefined {
  for (const candidate of ['pwsh', 'powershell']) {
    if (
      spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: 'ignore',
      }).status === 0
    ) {
      return candidate;
    }
  }
  return undefined;
}

const POWERSHELL = locatePowerShell();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'decagram-write-guard-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  return root;
}

function run(
  script: string,
  projectDir: string,
  payload: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL!,
      ['-NoProfile', '-NonInteractive', '-File', script],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    child.stdin.end(payload);
  });
}

const payload = (
  root: string,
  agentType: string | undefined,
  target: string,
): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    ...(agentType === undefined ? {} : { agent_type: agentType }),
    cwd: root,
    tool_name: 'Write',
    tool_input: { file_path: target },
  });

describe('PowerShell write-guard source', () => {
  it('contains the Windows path and protected-config rules', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(path.join(REPO_ROOT, 'scripts', 'gates', '_guard-lib.ps1'), 'utf8'),
    );
    expect(source).toContain('[StringComparison]::OrdinalIgnoreCase');
    expect(source).toContain("'.claude/settings.json'");
    expect(source).toContain("'.claude/hooks/*'");
    expect(source).toContain('Get-GuardChangedPaths');
    expect(source).toContain("throw 'Git could not read unstaged changes.'");
  });
});

describe.skipIf(POWERSHELL === undefined)(
  'PowerShell write guards (skipped when PowerShell is unavailable)',
  () => {
    it('allows Builder production changes and blocks test changes', async () => {
      const root = await project();
      expect(
        (
          await run(
            DISPATCHER,
            root,
            payload(root, 'builder', path.join(root, 'src', 'client.ts')),
          )
        ).code,
      ).toBe(0);
      const blocked = await run(
        DISPATCHER,
        root,
        payload(root, 'builder', path.join(root, 'test', 'client.test.ts')),
      );
      expect(blocked.code).toBe(2);
      expect(blocked.stderr).toContain('must not write tests');
    });

    it('blocks Claude configuration case-insensitively for every guarded agent', async () => {
      const root = await project();
      for (const agent of ['builder', 'test-engineer', 'prd-lead']) {
        const result = await run(
          DISPATCHER,
          root,
          payload(root, agent, path.join(root, '.CLAUDE', 'SETTINGS.JSON')),
        );
        expect(result.code).toBe(2);
      }
    });

    it('allows a human session and blocks an outside absolute path', async () => {
      const root = await project();
      expect(
        (await run(DISPATCHER, root, payload(root, undefined, path.join(root, 'test', 'x.ts'))))
          .code,
      ).toBe(0);
      const outside = path.join(path.dirname(root), 'outside.ts');
      expect((await run(DISPATCHER, root, payload(root, 'builder', outside))).code).toBe(2);
    });

    it('fails closed when a direct guarded payload is unparseable', async () => {
      const root = await project();
      const direct = path.join(REPO_ROOT, 'scripts', 'gates', 'builder-write-guard.ps1');
      expect((await run(direct, root, 'not json')).code).toBe(2);
    });

    it('writes an audit line for a guarded decision', async () => {
      const root = await project();
      await run(
        DISPATCHER,
        root,
        payload(root, 'builder', path.join(root, 'test', 'audit.test.ts')),
      );
      const audit = await import('node:fs/promises').then(({ readFile }) =>
        readFile(path.join(root, '.claude', 'gate-audit.log'), 'utf8'),
      );
      expect(audit).toContain('builder');
      expect(audit).toContain('BLOCK');
    });

    it('creates no probe target as part of setup', async () => {
      const root = await project();
      await writeFile(path.join(root, 'src', 'existing.ts'), 'export {};\n');
      const result = await run(
        DISPATCHER,
        root,
        payload(root, 'builder', path.join(root, 'src', 'existing.ts')),
      );
      expect(result.code).toBe(0);
    });
  },
);
