import { describe, expect, it, vi } from 'vitest';
import type { ClaudeClient } from '../src/integration/client.js';
import { ClaudePaths } from '../src/integration/paths.js';
import { ClaudeCodeAgentSupervisor } from '../src/supervisor/agentSupervisor.js';

function fakeClient(): ClaudeClient {
  return {
    cli: {
      bin: 'claude.exe',
      version: '2.1.220',
      meetsMinimum: true,
      discoveredVia: 'override',
    },
    stop: vi.fn(),
    logs: vi.fn(),
  } as unknown as ClaudeClient;
}

describe('ClaudeCodeAgentSupervisor', () => {
  it('exposes runtime capabilities without leaking a generic process API', () => {
    const supervisor = new ClaudeCodeAgentSupervisor({
      client: fakeClient(),
      paths: new ClaudePaths({ configDir: '/tmp/council-supervisor-test' }),
      config: { version: 1, members: [], pollIntervalMs: 10_000 },
      ptyAvailable: false,
      onSnapshot: vi.fn(),
    });

    expect(supervisor.runtimeId).toBe('claude-code');
    expect(supervisor.capabilities).toEqual({
      start: true,
      stop: true,
      logs: true,
      plainTextReply: false,
      interactiveTerminal: false,
      persistentSessions: true,
      councilReview: true,
    });
  });

  it('rejects unknown profile and session ids before invoking the CLI', async () => {
    const client = fakeClient();
    const supervisor = new ClaudeCodeAgentSupervisor({
      client,
      paths: new ClaudePaths({ configDir: '/tmp/council-supervisor-test' }),
      config: { version: 1, members: [], pollIntervalMs: 10_000 },
      ptyAvailable: true,
      onSnapshot: vi.fn(),
    });

    const start = await supervisor.startMember('renderer-supplied-name');
    const stop = await supervisor.stopSession('renderer-supplied-session');
    const logs = await supervisor.logs('renderer-supplied-session');

    expect(start.ok).toBe(false);
    expect(stop.ok).toBe(false);
    expect(logs.ok).toBe(false);
    expect(client.stop).not.toHaveBeenCalled();
    expect(client.logs).not.toHaveBeenCalled();
  });
});
