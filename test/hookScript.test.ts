/**
 * End-to-end test of the generated bash forwarder.
 *
 * The other hook tests post with `fetch`, which proves the receiver but not the
 * script. This runs the real `muster-hook.sh` against a real listening receiver,
 * which is the only way to catch a bug in the descriptor parsing — the sed
 * expressions are exactly the kind of thing that breaks silently and leaves the
 * fast path dead while polling quietly covers for it.
 *
 * The PowerShell twin is not executed here (no pwsh on macOS CI) and is covered
 * by the Windows smoke run.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ClaudePaths } from '../src/integration/paths.js';
import { HookReceiver } from '../src/integration/hooks/receiver.js';
import { bashHookScript, BASH_HOOK_FILENAME } from '../src/integration/hooks/scripts.js';
import type { HookDelivery } from '../src/integration/hooks/events.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Harness {
  readonly script: string;
  readonly configDir: string;
  readonly received: HookDelivery[];
  /** Stops just the receiver, leaving the descriptor and script on disk. */
  readonly stopReceiver: () => Promise<void>;
}

/** Installs the script into a throwaway config dir and starts a receiver there. */
async function setup(options: { startReceiver: boolean }): Promise<Harness> {
  const configDir = await mkdtemp(path.join(tmpdir(), 'muster-hookscript-'));
  cleanups.push(() => rm(configDir, { recursive: true, force: true }));

  const paths = new ClaudePaths({ configDir });
  await mkdir(paths.hookScriptsDir(), { recursive: true });
  const script = path.join(paths.hookScriptsDir(), BASH_HOOK_FILENAME);
  await writeFile(script, bashHookScript(), 'utf8');
  await chmod(script, 0o755);

  const received: HookDelivery[] = [];
  let stopReceiver = async (): Promise<void> => undefined;
  if (options.startReceiver) {
    const receiver = new HookReceiver(paths, { onDelivery: (d) => received.push(d) });
    cleanups.push(() => receiver.stop());
    const info = await receiver.start();
    // Closes the port but restores the descriptor, so the script finds a port
    // and then discovers nothing is listening on it — the app-closed-mid-turn
    // case, which is distinct from "no descriptor at all".
    stopReceiver = async () => {
      await receiver.stop();
      await writeFile(paths.receiverFile(), JSON.stringify(info, null, 2), 'utf8');
    };
  }

  return { script, configDir, received, stopReceiver };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
}

function runScript(harness: Harness, event: string, payload: unknown): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [harness.script, event], {
      // The script resolves the descriptor through CLAUDE_CONFIG_DIR, which is
      // also how it will behave for a user who has relocated their config.
      env: { ...process.env, CLAUDE_CONFIG_DIR: harness.configDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** The script posts asynchronously; give the receiver a moment to record it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

describe('muster-hook.sh', () => {
  it('reads the descriptor and delivers the payload', async () => {
    const harness = await setup({ startReceiver: true });
    const run = await runScript(harness, 'Notification', {
      session_id: 'e1f523d7-e83b-46b8-9eca-538f4e74e609',
      notification_type: 'agent_needs_input',
      cwd: '/work/meridian',
    });

    expect(run.code).toBe(0);
    await settle();

    expect(harness.received).toHaveLength(1);
    expect(harness.received[0]?.event).toBe('Notification');
    expect(harness.received[0]?.shortId).toBe('e1f523d7');
  });

  it('never writes to stdout, which would be fed back into the session', async () => {
    const harness = await setup({ startReceiver: true });
    const run = await runScript(harness, 'TaskCompleted', { task_id: 't1', task_name: 'Ship MER-101' });
    await settle();
    expect(run.stdout).toBe('');
    expect(harness.received[0]?.event).toBe('TaskCompleted');
  });

  it('forwards every subscribed event', async () => {
    const harness = await setup({ startReceiver: true });
    const events = [
      'Notification',
      'SubagentStart',
      'SubagentStop',
      'TaskCreated',
      'TaskCompleted',
      'TeammateIdle',
      'PostToolUseFailure',
    ];
    for (const event of events) {
      expect((await runScript(harness, event, { session_id: 'aaaaaaaa-1' })).code).toBe(0);
    }
    await settle();
    expect(harness.received.map((d) => d.event)).toEqual(events);
  });

  it('exits 0 when the app is not running', async () => {
    // No descriptor on disk. An observation hook must never fail a turn just
    // because the control surface is closed.
    const harness = await setup({ startReceiver: false });
    const run = await runScript(harness, 'Notification', { session_id: 'x' });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('exits 0 with no event argument', async () => {
    const harness = await setup({ startReceiver: true });
    expect((await runScript(harness, '', {})).code).toBe(0);
  });

  it('exits 0 when the receiver has gone away mid-turn', async () => {
    // Descriptor still on disk, nothing listening — the app was closed between
    // the hook firing and the post. Polling reconciles; the turn continues.
    const harness = await setup({ startReceiver: true });
    await harness.stopReceiver();
    const run = await runScript(harness, 'Notification', { session_id: 'x' });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
  });
});
