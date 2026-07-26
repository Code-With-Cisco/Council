import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudePaths } from '../src/integration/paths.js';
import { DecagramCouncilRuntime } from '../src/integration/runtime.js';
import type {
  CliFailure,
  CliResult,
  Session,
  SessionBindingRef,
} from '../src/integration/types.js';
import type { ClaudeRuntimeReader } from '../src/providers/contracts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function rosterResult(session: Session): CliResult<Session[]> {
  return {
    ok: true,
    value: [session],
    raw: '',
    argv: ['agents', '--json', '--all'],
    durationMs: 0,
  };
}

function session(id: string): Session {
  return {
    id,
    sessionId: `${id}-full`,
    name: id,
    kind: 'background',
    state: 'working',
    waitingFor: undefined,
    status: undefined,
    detail: undefined,
    cwd: '/work',
    startedAt: undefined,
    updatedAt: undefined,
    pid: undefined,
    cold: false,
    pinned: false,
    intent: undefined,
    source: 'roster',
  };
}

function rosterFailure(message = 'transient roster failure'): CliFailure {
  return {
    ok: false,
    kind: 'cli-error',
    message,
    raw: '',
    argv: ['agents', '--json', '--all'],
    exitCode: 1,
    durationMs: 0,
  };
}

function binding(shortSessionId: string): SessionBindingRef {
  return {
    providerId: 'claude-code',
    workspaceId: 'workspace-test',
    profileId: 'profile-builder123',
    shortSessionId,
    fullSessionId: `${shortSessionId}-full`,
    uniqueLaunchName: 'dc-profile-builder123-test',
    agentName: 'builder',
    catalogId: 'catalog-builder',
    definitionFingerprint: 'a'.repeat(64),
    requestedCanonicalCwd: '/work',
    createdAt: '2026-07-26T00:00:00.000Z',
    lastConfirmedAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('authoritative runtime refresh ordering', () => {
  it('serializes explicit refreshes so an older read cannot publish last', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'council-runtime-refresh-'));
    roots.push(root);
    const resolvers: Array<(value: CliResult<Session[]>) => void> = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const listSessions = vi.fn(
      () =>
        new Promise<CliResult<Session[]>>((resolve) => {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          resolvers.push((value) => {
            concurrent -= 1;
            resolve(value);
          });
        }),
    );
    const published: string[] = [];
    const runtime = new DecagramCouncilRuntime({
      provider: { listSessions } as unknown as ClaudeRuntimeReader,
      paths: new ClaudePaths({ configDir: root }),
      config: { version: 2, members: [], pollIntervalMs: 10_000 },
      onSnapshot: (snapshot) => {
        published.push(snapshot.roster.sessions[0]?.id ?? 'empty');
      },
    });

    const first = runtime.refresh();
    const second = runtime.refresh();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]!(rosterResult(session('older')));
    await first;
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!(rosterResult(session('newer')));
    await second;

    expect(maximumConcurrent).toBe(1);
    expect(published).toEqual(['older', 'newer']);
    expect(runtime.current?.roster.sessions[0]?.id).toBe('newer');
  });

  it('keeps exact binding absence unavailable rather than stale when the roster read fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'council-runtime-refresh-'));
    roots.push(root);
    const runtime = new DecagramCouncilRuntime({
      provider: {
        listSessions: vi.fn().mockResolvedValue(rosterFailure()),
      } as unknown as ClaudeRuntimeReader,
      paths: new ClaudePaths({ configDir: root }),
      config: {
        version: 2,
        members: [
          {
            key: 'profile-builder123',
            label: 'Builder',
            agent: 'builder',
            cwd: '/work',
            workspaceId: 'workspace-test',
          },
        ],
        pollIntervalMs: 10_000,
      },
      bindings: new Map([
        ['profile-builder123', binding('bound-session')],
      ]),
      onSnapshot: () => undefined,
    });

    const snapshot = await runtime.refresh();
    const slot = snapshot.roster.squad[0];

    expect(snapshot.rosterError?.message).toBe('transient roster failure');
    expect(slot?.bindingState).toBe('unavailable');
    expect(slot?.staleBinding).toBe(false);
    expect(slot?.session).toBeUndefined();
  });

  it('retains a previously visible exact session but marks ownership unavailable during a failed read', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'council-runtime-refresh-'));
    roots.push(root);
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(rosterResult(session('bound-session')))
      .mockResolvedValueOnce(rosterFailure());
    const runtime = new DecagramCouncilRuntime({
      provider: { listSessions } as unknown as ClaudeRuntimeReader,
      paths: new ClaudePaths({ configDir: root }),
      config: {
        version: 2,
        members: [
          {
            key: 'profile-builder123',
            label: 'Builder',
            agent: 'builder',
            cwd: '/work',
            workspaceId: 'workspace-test',
          },
        ],
        pollIntervalMs: 10_000,
      },
      bindings: new Map([
        ['profile-builder123', binding('bound-session')],
      ]),
      onSnapshot: () => undefined,
    });

    expect((await runtime.refresh()).roster.squad[0]?.bindingState).toBe('active');
    const failed = await runtime.refresh();

    expect(failed.roster.squad[0]?.session?.id).toBe('bound-session');
    expect(failed.roster.squad[0]?.bindingState).toBe('unavailable');
    expect(failed.roster.squad[0]?.staleBinding).toBe(false);
  });
});
