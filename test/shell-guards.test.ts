import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCHER = path.join(REPO_ROOT, 'scripts', 'gates', 'agent-shell-dispatch.ps1');
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
  const root = await mkdtemp(path.join(tmpdir(), 'decagram-shell-guard-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.claude'), { recursive: true });
  return root;
}

function run(
  projectDir: string,
  agentType: string | undefined,
  command: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL!,
      ['-NoProfile', '-NonInteractive', '-File', DISPATCHER],
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
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        ...(agentType === undefined ? {} : { agent_type: agentType }),
        cwd: projectDir,
        tool_name: 'PowerShell',
        tool_input: { command },
      }),
    );
  });
}

describe('PowerShell shell-guard source', () => {
  it('covers direct writes and common obfuscation paths', async () => {
    const source = await readFile(DISPATCHER, 'utf8');
    for (const construct of [
      'Set-Content',
      'Copy-Item',
      'Remove-Item',
      'Invoke-Expression',
      'FromBase64String',
      'Start-Process',
      'here-string',
    ]) {
      expect(source).toContain(construct);
    }
  });
});

describe.skipIf(POWERSHELL === undefined)(
  'PowerShell shell guard (skipped when PowerShell is unavailable)',
  () => {
    it('allows existing program invocations', async () => {
      const root = await project();
      expect((await run(root, 'builder', 'npm run typecheck')).code).toBe(0);
      expect((await run(root, 'test-engineer', 'node --version')).code).toBe(0);
    });

    it('blocks direct file mutation constructs', async () => {
      const root = await project();
      for (const command of [
        "Set-Content -Path x.txt -Value x",
        "Get-Content x | Out-File y",
        "Copy-Item x y",
        "Remove-Item x",
        "Write-Output x > y",
      ]) {
        expect((await run(root, 'builder', command)).code).toBe(2);
      }
    });

    it('blocks obfuscated commands and dynamic evaluation', async () => {
      const root = await project();
      for (const command of [
        "iex 'Set-Content x y'",
        "[ScriptBlock]::Create('Set-Content x y')",
        "powershell -EncodedCommand ZQBjAGgAbwAgAHgA",
      ]) {
        expect((await run(root, 'builder', command)).code).toBe(2);
      }
    });

    it('does not gate an unguarded agent or human session', async () => {
      const root = await project();
      expect((await run(root, 'reviewer', 'Set-Content x y')).code).toBe(0);
      expect((await run(root, undefined, 'Set-Content x y')).code).toBe(0);
    });
  },
);
