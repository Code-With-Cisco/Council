import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  tool: 'Edit' | 'Write' = 'Write',
  edit?: { old_string: string; new_string: string },
): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    ...(agentType === undefined ? {} : { agent_type: agentType }),
    cwd: root,
    tool_name: tool,
    tool_input: { file_path: target, ...edit },
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
    const GUARD_TIMEOUT_MS = 60_000;

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
    }, GUARD_TIMEOUT_MS);

    it('resolves the nearest existing junction before allowing a new target', async () => {
      const root = await project();
      const outside = await mkdtemp(path.join(tmpdir(), 'decagram-guard-outside-'));
      cleanups.push(() => rm(outside, { recursive: true, force: true }));
      const junction = path.join(root, 'src', 'linked');
      await symlink(outside, junction, 'junction');
      const result = await run(
        DISPATCHER,
        root,
        payload(root, 'builder', path.join(junction, 'new-file.ts')),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('outside the project');
    }, GUARD_TIMEOUT_MS);

    it('enforces story ownership at field level', async () => {
      const root = await project();
      await mkdir(path.join(root, 'stories'), { recursive: true });
      const storyPath = path.join(root, 'stories', 'DC-101.md');
      await writeFile(storyPath, '---\nacceptance: npm test\nstatus: ready\n---\n');

      const acceptance = await run(
        DISPATCHER,
        root,
        payload(root, 'test-engineer', storyPath, 'Edit', {
          old_string: 'acceptance: npm test',
          new_string: 'acceptance: npm test -- DC-101',
        }),
      );
      expect(acceptance.code).toBe(0);

      const status = await run(
        DISPATCHER,
        root,
        payload(root, 'test-engineer', storyPath, 'Edit', {
          old_string: 'status: ready',
          new_string: 'status: done',
        }),
      );
      expect(status.code).toBe(2);

      const prdAcceptance = await run(
        DISPATCHER,
        root,
        payload(root, 'prd-lead', storyPath, 'Edit', {
          old_string: 'acceptance: npm test',
          new_string: 'acceptance: exit 0',
        }),
      );
      expect(prdAcceptance.code).toBe(2);
    }, GUARD_TIMEOUT_MS);

    it('converts an unexpected guarded child exit into Claude blocking code 2', async () => {
      const root = await project();
      const hooks = path.join(root, 'hooks');
      await mkdir(hooks, { recursive: true });
      await copyFile(DISPATCHER, path.join(hooks, 'agent-write-dispatch.ps1'));
      await copyFile(
        path.join(REPO_ROOT, 'scripts', 'gates', '_guard-lib.ps1'),
        path.join(hooks, '_guard-lib.ps1'),
      );
      await writeFile(path.join(hooks, 'builder-write-guard.ps1'), 'exit 7\n');
      const result = await run(
        path.join(hooks, 'agent-write-dispatch.ps1'),
        root,
        payload(root, 'builder', path.join(root, 'src', 'client.ts')),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('failed unexpectedly with exit 7');
    }, GUARD_TIMEOUT_MS);

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
