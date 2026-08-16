import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeClient,
  StartSessionRequest,
} from '../src/integration/client.js';
import { ClaudeProviderAdapter } from '../src/integration/claudeProviderAdapter.js';
import {
  sendReply,
  type ReplyOutcome,
} from '../src/integration/pty/attach.js';
import type {
  CliResult,
  DaemonStatus,
  Session,
} from '../src/integration/types.js';

function success<T>(value: T, argv: readonly string[] = []): CliResult<T> {
  return {
    ok: true,
    value,
    raw: '',
    argv,
    durationMs: 0,
  };
}

describe('ClaudeProviderAdapter', () => {
  it('delegates every provider operation without changing arguments or results', async () => {
    const session = { id: 'session-1' } as Session;
    const daemon = { recognized: true, running: true } as DaemonStatus;
    const verifyResult = success('ready', ['--version']);
    const rosterResult = success([session], ['agents', '--json', '--all']);
    const startResult = success(
      { id: 'session-1', name: 'launch-1', unknownAgent: undefined },
      ['--bg'],
    );
    const stopResult = success('stopped', ['stop', 'session-1']);
    const resumeResult = success('resumed', ['respawn', 'session-1']);
    const logsResult = success('recent output', ['logs', 'session-1']);
    const daemonResult = success(daemon, ['daemon', 'status']);
    const replyResult = success<ReplyOutcome>(
      { transcript: 'ack', acknowledged: true },
      ['attach', 'session-1'],
    );

    const verifyLaunchCapability = vi.fn(async () => verifyResult);
    const listSessions = vi.fn(async () => rosterResult);
    const start = vi.fn(async () => startResult);
    const stop = vi.fn(async () => stopResult);
    const respawn = vi.fn(async () => resumeResult);
    const logs = vi.fn(async () => logsResult);
    const daemonStatus = vi.fn(async () => daemonResult);
    const replyTransport = vi.fn(async () => replyResult);
    const client = {
      cli: {
        bin: 'claude.exe',
        version: '2.1.233',
        meetsMinimum: true,
        discoveredVia: 'override',
      },
      verifyLaunchCapability,
      listSessions,
      start,
      stop,
      respawn,
      logs,
      daemonStatus,
    } as unknown as ClaudeClient;
    const adapter = new ClaudeProviderAdapter(client, {
      ptyAvailable: true,
      reply: replyTransport as unknown as typeof sendReply,
    });
    const request: StartSessionRequest = {
      agent: 'builder',
      name: 'launch-1',
      prompt: 'Build it.',
      cwd: '/work',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
    };
    const listOptions = { all: true, cwd: '/work' };

    expect(await adapter.verifyLaunchCapability()).toBe(verifyResult);
    expect(await adapter.listSessions(listOptions)).toBe(rosterResult);
    expect(await adapter.startSession(request)).toBe(startResult);
    expect(await adapter.stopSession('session-1')).toBe(stopResult);
    expect(await adapter.resumeSession('session-1')).toBe(resumeResult);
    expect(await adapter.readLogs('session-1')).toBe(logsResult);
    expect(await adapter.sendReply('session-1', 'Continue.')).toBe(replyResult);
    expect(await adapter.daemonStatus()).toBe(daemonResult);

    expect(adapter.providerId).toBe('claude-code');
    expect(adapter.capabilities).toEqual({
      start: true,
      stop: true,
      logs: true,
      plainTextReply: true,
      persistentSessions: true,
    });
    expect(listSessions).toHaveBeenCalledExactlyOnceWith(listOptions);
    expect(start).toHaveBeenCalledExactlyOnceWith(request);
    expect(stop).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(respawn).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(logs).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(replyTransport).toHaveBeenCalledExactlyOnceWith(
      'claude.exe',
      'session-1',
      'Continue.',
    );
  });

  it('reports plain-text reply unavailable when the PTY bridge is absent', () => {
    const adapter = new ClaudeProviderAdapter({} as ClaudeClient, {
      ptyAvailable: false,
    });

    expect(adapter.capabilities.plainTextReply).toBe(false);
  });
});
