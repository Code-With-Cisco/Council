/**
 * Hook receiver, event parsing, and settings-merge tests.
 *
 * The receiver is a loopback listener any local process can reach, so the
 * security assertions here are load-bearing, not decorative.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ClaudePaths } from '../src/integration/paths.js';
import { HookReceiver, SECRET_HEADER } from '../src/integration/hooks/receiver.js';
import { isNeedsInput, parseHookDelivery } from '../src/integration/hooks/events.js';
import {
  MUSTER_HOOK_MARKER,
  generateHookConfig,
  mergeHookConfig,
  removeHookConfig,
} from '../src/integration/hooks/generate.js';
import type { HookDelivery } from '../src/integration/hooks/events.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempPaths(): Promise<ClaudePaths> {
  const dir = await mkdtemp(path.join(tmpdir(), 'muster-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return new ClaudePaths({ configDir: dir });
}

describe('parseHookDelivery', () => {
  it('derives the short id from session_id', () => {
    const delivery = parseHookDelivery('Notification', {
      session_id: 'e1f523d7-e83b-46b8-9eca-538f4e74e609',
      notification_type: 'agent_needs_input',
    });
    expect(delivery?.shortId).toBe('e1f523d7');
  });

  it('rejects an event Muster did not register', () => {
    expect(parseHookDelivery('PreToolUse', { session_id: 'x' })).toBeNull();
  });

  it('rejects a non-object body', () => {
    expect(parseHookDelivery('Notification', 'not an object')).toBeNull();
    expect(parseHookDelivery('Notification', [1, 2])).toBeNull();
  });
});

describe('isNeedsInput', () => {
  const delivery = (event: string, payload: Record<string, unknown>): HookDelivery =>
    parseHookDelivery(event, payload)!;

  it('treats agent_needs_input and permission prompts as attention', () => {
    expect(isNeedsInput(delivery('Notification', { notification_type: 'agent_needs_input' }))).toBe(true);
    expect(isNeedsInput(delivery('Notification', { notification_type: 'permission_prompt' }))).toBe(true);
  });

  it('does not treat completion as a demand for a decision', () => {
    // Exactly one thing on screen demands attention; completion is news.
    expect(isNeedsInput(delivery('Notification', { notification_type: 'agent_completed' }))).toBe(false);
  });

  it('only counts a teammate idling on the user', () => {
    expect(isNeedsInput(delivery('TeammateIdle', { reason: 'waiting_for_user' }))).toBe(true);
    expect(isNeedsInput(delivery('TeammateIdle', { reason: 'task_complete' }))).toBe(false);
  });
});

describe('HookReceiver', () => {
  it('binds loopback, publishes a descriptor, and delivers a payload', async () => {
    const paths = await tempPaths();
    const received: HookDelivery[] = [];
    const receiver = new HookReceiver(paths, { onDelivery: (d) => received.push(d) });
    cleanups.push(() => receiver.stop());

    const info = await receiver.start();
    expect(info.port).toBeGreaterThan(0);
    expect(info.url).toBe(`http://127.0.0.1:${info.port}`);

    // The descriptor is the well-known file hook scripts read at fire time,
    // which is what allows an ephemeral port.
    const descriptor = JSON.parse(await readFile(paths.receiverFile(), 'utf8')) as { port: number; secret: string };
    expect(descriptor.port).toBe(info.port);
    expect(descriptor.secret).toBe(info.secret);

    const response = await fetch(`${info.url}/hook/Notification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: info.secret },
      body: JSON.stringify({ session_id: 'abcdefgh-1111', notification_type: 'agent_needs_input' }),
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe('Notification');
    expect(received[0]?.shortId).toBe('abcdefgh');
  });

  it('rejects a request without the shared secret', async () => {
    const paths = await tempPaths();
    const received: HookDelivery[] = [];
    const receiver = new HookReceiver(paths, { onDelivery: (d) => received.push(d) });
    cleanups.push(() => receiver.stop());
    const info = await receiver.start();

    const response = await fetch(`${info.url}/hook/Notification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('takes the event from the path, not the body', async () => {
    // Otherwise any local process could claim to be an event Muster never
    // registered a hook for.
    const paths = await tempPaths();
    const received: HookDelivery[] = [];
    const receiver = new HookReceiver(paths, { onDelivery: (d) => received.push(d) });
    cleanups.push(() => receiver.stop());
    const info = await receiver.start();

    const response = await fetch(`${info.url}/hook/TaskCompleted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: info.secret },
      body: JSON.stringify({ hook_event_name: 'Notification', task_id: 't1' }),
    });

    expect(response.status).toBe(200);
    expect(received[0]?.event).toBe('TaskCompleted');
  });

  it('rejects an unsupported event and a bad body', async () => {
    const paths = await tempPaths();
    const receiver = new HookReceiver(paths, { onDelivery: () => undefined });
    cleanups.push(() => receiver.stop());
    const info = await receiver.start();
    const headers = { 'content-type': 'application/json', [SECRET_HEADER]: info.secret };

    expect((await fetch(`${info.url}/hook/PreToolUse`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
    expect((await fetch(`${info.url}/hook/Notification`, { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await fetch(`${info.url}/nope`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
    expect((await fetch(`${info.url}/hook/Notification`, { method: 'GET', headers })).status).toBe(405);
  });

  it('removes the descriptor on stop so scripts stop posting', async () => {
    const paths = await tempPaths();
    const receiver = new HookReceiver(paths, { onDelivery: () => undefined });
    await receiver.start();
    await receiver.stop();
    await expect(readFile(paths.receiverFile(), 'utf8')).rejects.toThrow();
  });
});

describe('hook config generation', () => {
  it('emits async command hooks for every subscribed event', async () => {
    const paths = await tempPaths();
    const config = generateHookConfig(paths, { windows: false });

    expect(Object.keys(config).sort()).toEqual([
      'Notification',
      'PostToolUseFailure',
      'SubagentStart',
      'SubagentStop',
      'TaskCompleted',
      'TaskCreated',
      'TeammateIdle',
    ]);

    const handler = config['Notification']?.[0]?.hooks[0];
    // async: these observe only. Blocking would add a round trip to every turn.
    expect(handler?.async).toBe(true);
    expect(handler?.args).toEqual(['Notification']);
    expect(handler?.command).toContain('muster-hook.sh');
    expect(config['Notification']?.[0]?.matcher).toContain('agent_needs_input');
  });

  it('uses the PowerShell dialect on Windows', async () => {
    const paths = await tempPaths();
    const handler = generateHookConfig(paths, { windows: true })['Notification']?.[0]?.hooks[0];
    expect(handler?.shell).toBe('powershell');
    expect(handler?.command).toContain('muster-hook.ps1');
  });
});

describe('mergeHookConfig', () => {
  it("preserves the user's own hooks", async () => {
    const paths = await tempPaths();
    const existing = {
      hooks: {
        Notification: [{ matcher: 'auth_success', hooks: [{ type: 'command', command: '/my/own.sh' }] }],
      },
    };

    const merged = mergeHookConfig(existing, generateHookConfig(paths, { windows: false }));
    const groups = (merged['hooks'] as Record<string, unknown[]>)['Notification'] ?? [];

    expect(JSON.stringify(groups)).toContain('/my/own.sh');
    expect(JSON.stringify(groups)).toContain('muster-hook.sh');
  });

  it('is idempotent, so re-running never accumulates duplicates', async () => {
    const paths = await tempPaths();
    const generated = generateHookConfig(paths, { windows: false });
    const once = mergeHookConfig({}, generated);
    const twice = mergeHookConfig(once, generated);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('replaces a stale Muster handler rather than leaving both', async () => {
    const paths = await tempPaths();
    const stale = {
      hooks: {
        Notification: [
          { hooks: [{ type: 'command', command: '/old/path/muster-hook.sh', statusMessage: MUSTER_HOOK_MARKER }] },
        ],
      },
    };
    const merged = mergeHookConfig(stale, generateHookConfig(paths, { windows: false }));
    const text = JSON.stringify(merged);
    expect(text).not.toContain('/old/path/muster-hook.sh');
    expect(text).toContain('muster-hook.sh');
  });

  it('removes only Muster entries on uninstall', async () => {
    const paths = await tempPaths();
    const merged = mergeHookConfig(
      { hooks: { Notification: [{ hooks: [{ type: 'command', command: '/my/own.sh' }] }] } },
      generateHookConfig(paths, { windows: false }),
    );

    const cleaned = removeHookConfig(merged);
    const text = JSON.stringify(cleaned);
    expect(text).toContain('/my/own.sh');
    expect(text).not.toContain('muster-hook');
  });
});
