import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { HookReceiver } from '../src/integration/hooks/receiver.js';
import { powershellHookScript } from '../src/integration/hooks/scripts.js';
import { ClaudePaths } from '../src/integration/paths.js';
import type { HookDelivery } from '../src/integration/hooks/events.js';

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
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Harness {
  readonly configDir: string;
  readonly script: string;
  readonly received: HookDelivery[];
  readonly stop: () => Promise<void>;
}

async function setup(startReceiver: boolean): Promise<Harness> {
  const configDir = await mkdtemp(path.join(tmpdir(), 'decagram-hookscript-'));
  cleanups.push(() => rm(configDir, { recursive: true, force: true }));
  const paths = new ClaudePaths({ configDir });
  const script = path.join(configDir, 'decagram-council-hook.ps1');
  await writeFile(script, powershellHookScript(), 'utf8');
  await mkdir(paths.decagramCouncilDir(), { recursive: true });

  const received: HookDelivery[] = [];
  const receiver = new HookReceiver(paths, { onDelivery: (delivery) => received.push(delivery) });
  if (startReceiver) await receiver.start();

  return { configDir, script, received, stop: () => receiver.stop() };
}

function runScript(
  harness: Harness,
  event: string,
  payload: unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL!,
      ['-NoProfile', '-NonInteractive', '-File', harness.script, event],
      {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: harness.configDir,
          USERPROFILE: harness.configDir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('PowerShell hook source', () => {
  it('uses the renamed descriptor path and secret header', () => {
    const source = powershellHookScript();
    expect(source).toContain("'decagram-council'");
    expect(source).toContain('x-decagram-council-secret');
    expect(source).not.toContain('Write-Host');
  });
});

describe.skipIf(POWERSHELL === undefined)(
  'decagram-council-hook.ps1 (skipped when PowerShell is unavailable)',
  () => {
    it('delivers a payload without writing to stdout', async () => {
      const harness = await setup(true);
      cleanups.push(harness.stop);
      const run = await runScript(harness, 'Notification', {
        session_id: 'e1f523d7-1111',
        notification_type: 'agent_needs_input',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(harness.received[0]?.shortId).toBe('e1f523d7');
    });

    it('exits 0 when the app is not running', async () => {
      const harness = await setup(false);
      const run = await runScript(harness, 'Notification', { session_id: 'x' });
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      await expect(readFile(path.join(harness.configDir, 'missing'), 'utf8')).rejects.toThrow();
    });
  },
);
