import { describe, expect, it, vi } from 'vitest';
import type { ClaudeClient } from '../src/integration/client.js';
import { ClaudeProviderAdapter } from '../src/integration/claudeProviderAdapter.js';
import { ClaudePaths } from '../src/integration/paths.js';
import type { Session } from '../src/integration/types.js';
import {
  ClaudeCodeAgentSupervisor,
  isSafePlainTextReplyState,
} from '../src/supervisor/agentSupervisor.js';
import type { ResolvedAgentCatalog } from '../src/supervisor/catalog.js';
import { SessionBindingStore } from '../src/supervisor/sessionBindings.js';

function fakeClient(): ClaudeClient {
  return {
    cli: {
      bin: 'claude.exe',
      version: '2.1.233',
      meetsMinimum: true,
      discoveredVia: 'override',
    },
    stop: vi.fn(),
    logs: vi.fn(),
    listSessions: vi.fn(async () => ({
      ok: true,
      value: [],
      raw: '',
      argv: ['agents', '--json', '--all'],
      durationMs: 0,
    })),
  } as unknown as ClaudeClient;
}

function emptyCatalog(): ResolvedAgentCatalog {
  return {
    workspaceId: 'ws_test',
    workspaceRoot: '/tmp/council-supervisor-workspace',
    includeUser: false,
    roots: [],
    entries: [],
    diagnostics: [],
    revision: 'empty',
  };
}

function supervisorOptions(client: ClaudeClient, ptyAvailable: boolean) {
  const catalog = emptyCatalog();
  return {
    provider: new ClaudeProviderAdapter(client, { ptyAvailable }),
    paths: new ClaudePaths({ configDir: '/tmp/council-supervisor-test' }),
    config: { version: 2 as const, members: [], pollIntervalMs: 10_000 },
    bindings: new SessionBindingStore('/tmp/council-supervisor-bindings.json'),
    workspace: {
      id: 'ws_test',
      canonicalPath: '/tmp/council-supervisor-workspace',
      trusted: true,
    },
    catalog,
    resolveCatalog: async () => catalog,
    validations: new Map(),
    onSnapshot: vi.fn(),
  };
}

describe('ClaudeCodeAgentSupervisor', () => {
  it('exposes runtime capabilities without leaking a generic process API', () => {
    const supervisor = new ClaudeCodeAgentSupervisor(
      supervisorOptions(fakeClient(), false),
    );

    expect(supervisor.runtimeId).toBe('claude-code');
    expect(supervisor.capabilities).toEqual({
      start: true,
      stop: true,
      logs: true,
      plainTextReply: false,
      interactiveTerminal: false,
      persistentSessions: true,
      councilReview: false,
    });
  });

  it('allows one-line reply only for an exact ordinary-text wait state', () => {
    const waiting = {
      id: 'exact001',
      state: 'blocked',
      waitingFor: 'input needed',
    } as Session;
    expect(isSafePlainTextReplyState(waiting)).toBe(true);
    for (const waitingFor of [
      'permission prompt',
      'sandbox request',
      'worker request',
      'dialog open',
      undefined,
    ]) {
      expect(
        isSafePlainTextReplyState({ ...waiting, waitingFor } as Session),
      ).toBe(false);
    }
    expect(
      isSafePlainTextReplyState({ ...waiting, state: 'stopped' } as Session),
    ).toBe(false);
  });

  it('rejects unknown profile and session ids before invoking the CLI', async () => {
    const client = fakeClient();
    const supervisor = new ClaudeCodeAgentSupervisor(
      supervisorOptions(client, true),
    );

    const start = await supervisor.startMember(
      'profile-renderersupplied',
      'a'.repeat(64),
    );
    const stop = await supervisor.stopSession('profile-renderersupplied');
    const logs = await supervisor.logs('profile-renderersupplied');
    const reply = await supervisor.reply(
      'profile-renderersupplied',
      'ordinary text',
    );

    expect(start.ok).toBe(false);
    expect(stop.ok).toBe(false);
    expect(logs.ok).toBe(false);
    expect(reply.ok).toBe(false);
    expect(client.stop).not.toHaveBeenCalled();
    expect(client.logs).not.toHaveBeenCalled();
  });
});
