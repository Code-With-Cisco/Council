import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_PROVIDER_ID,
  SessionBindingStore,
  SessionBindingStoreBlockedError,
  parseSessionBindingsFile,
  resolveExactBindingSession,
  type PendingLaunchRecord,
  type SessionBindingRecord,
} from '../src/supervisor/sessionBindings.js';
import { MAX_PROFILE_ID_LENGTH } from '../src/profileIdentity.js';

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const CREATED_AT = '2026-07-26T12:00:00.000Z';
const CONFIRMED_AT = '2026-07-26T12:01:00.000Z';
const temporaryDirectories: string[] = [];

async function temporaryFile(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'council-bindings-'));
  temporaryDirectories.push(directory);
  return { directory, file: path.join(directory, 'session-bindings.json') };
}

function binding(
  profileId: string,
  overrides: Partial<SessionBindingRecord> = {},
): SessionBindingRecord {
  const suffix = profileId.replaceAll(':', '-');
  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    workspaceId: 'workspace-main',
    profileId,
    shortSessionId: `short-${suffix}`,
    fullSessionId: `full-${suffix}`,
    uniqueLaunchName: `dc-${suffix}-launch`,
    agentName: `agent-${suffix}`,
    catalogId: `catalog-${suffix}`,
    definitionFingerprint: FINGERPRINT_A,
    requestedCanonicalCwd: `/work/${suffix}`,
    actualCanonicalCwd: `/work/${suffix}/.claude/worktrees/active`,
    createdAt: CREATED_AT,
    lastConfirmedAt: CONFIRMED_AT,
    ...overrides,
  };
}

function pending(
  profileId: string,
  overrides: Partial<PendingLaunchRecord> = {},
): PendingLaunchRecord {
  const suffix = profileId.replaceAll(':', '-');
  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    workspaceId: 'workspace-main',
    profileId,
    uniqueLaunchName: `dc-${suffix}-launch`,
    agentName: `agent-${suffix}`,
    catalogId: `catalog-${suffix}`,
    definitionFingerprint: FINGERPRINT_A,
    requestedCanonicalCwd: `/work/${suffix}`,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('SessionBindingStore durability', () => {
  it('persists pending launch evidence and commits every binding field across restarts', async () => {
    const { file } = await temporaryFile();
    const first = new SessionBindingStore(file);
    const initial = await first.load();

    expect(initial.fileExists).toBe(false);
    expect(initial.data.bindings).toEqual({});
    expect(initial.data.pendingLaunches).toEqual({});

    const pendingLaunch = pending('profile-fixture-builder');
    await first.setPendingLaunch(pendingLaunch);

    const afterPendingRestart = new SessionBindingStore(file);
    await afterPendingRestart.load();
    expect(afterPendingRestart.getPendingLaunch('profile-fixture-builder')).toEqual(pendingLaunch);

    const durableBinding = binding('profile-fixture-builder');
    await afterPendingRestart.setBinding(durableBinding);

    const afterCommitRestart = new SessionBindingStore(file);
    const restarted = await afterCommitRestart.load();
    expect(restarted.data.version).toBe(1);
    expect(afterCommitRestart.getBinding('profile-fixture-builder')).toEqual(durableBinding);
    expect(afterCommitRestart.getPendingLaunch('profile-fixture-builder')).toBeUndefined();

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      bindings: Record<string, unknown>;
      pendingLaunches: Record<string, unknown>;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.bindings['profile-fixture-builder']).toEqual(durableBinding);
    expect(onDisk.pendingLaunches).toEqual({});
  });

  it('serializes concurrent mutations so valid records are never lost', async () => {
    const { file } = await temporaryFile();
    const store = new SessionBindingStore(file);
    await store.load();

    await Promise.all([
      store.setBinding(binding('profile-fixture-a')),
      store.setBinding(binding('profile-fixture-b')),
      store.setBinding(binding('profile-fixture-c')),
    ]);

    const restarted = new SessionBindingStore(file);
    const state = await restarted.load();
    expect(Object.keys(state.data.bindings).sort()).toEqual([
      'profile-fixture-a',
      'profile-fixture-b',
      'profile-fixture-c',
    ]);
  });

  it('persists a short-only acknowledgement without serializing undefined optional fields', async () => {
    const { file } = await temporaryFile();
    const store = new SessionBindingStore(file);
    await store.setBinding(
      binding('profile-fixture-short-only', {
        fullSessionId: undefined,
        actualCanonicalCwd: undefined,
      }),
    );

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as {
      bindings: Record<string, Record<string, unknown>>;
    };
    expect(onDisk.bindings['profile-fixture-short-only']).not.toHaveProperty('fullSessionId');
    expect(onDisk.bindings['profile-fixture-short-only']).not.toHaveProperty('actualCanonicalCwd');

    const restarted = new SessionBindingStore(file);
    await restarted.load();
    expect(restarted.getBinding('profile-fixture-short-only')?.shortSessionId).toBe(
      'short-profile-fixture-short-only',
    );
  });

  it('keeps an old binding while Start new is pending, then replaces it atomically', async () => {
    const { file } = await temporaryFile();
    const store = new SessionBindingStore(file);
    const original = binding('profile-fixture-builder');
    await store.setBinding(original);

    const replacementPending = pending('profile-fixture-builder', {
      uniqueLaunchName: 'dc-builder-replacement-pending',
      definitionFingerprint: FINGERPRINT_B,
    });
    await store.setPendingLaunch(replacementPending);

    const duringLaunchRestart = new SessionBindingStore(file);
    await duringLaunchRestart.load();
    expect(duringLaunchRestart.getBinding('profile-fixture-builder')).toEqual(original);
    expect(duringLaunchRestart.getPendingLaunch('profile-fixture-builder')).toEqual(replacementPending);

    const replacement = binding('profile-fixture-builder', {
      shortSessionId: 'short-builder-replacement',
      fullSessionId: 'full-builder-replacement',
      uniqueLaunchName: replacementPending.uniqueLaunchName,
      definitionFingerprint: FINGERPRINT_B,
      createdAt: '2026-07-26T12:02:00.000Z',
      lastConfirmedAt: '2026-07-26T12:03:00.000Z',
    });
    const previous = await duringLaunchRestart.replaceBinding(replacement);

    expect(previous).toEqual(original);
    expect(duringLaunchRestart.getBinding('profile-fixture-builder')).toEqual(replacement);
    expect(duringLaunchRestart.getPendingLaunch('profile-fixture-builder')).toBeUndefined();
  });

  it('persists rejected-substitution disposition and guards its cleanup with CAS', async () => {
    const { file } = await temporaryFile();
    const store = new SessionBindingStore(file);
    const launch = pending('profile-fixture-builder');
    await store.setPendingLaunch(launch);

    const rejected = await store.markPendingLaunchRejected(
      launch.profileId,
      launch,
    );
    expect(rejected).toEqual({
      ...launch,
      disposition: 'rejected-substitution',
    });

    const restarted = new SessionBindingStore(file);
    await restarted.load();
    expect(restarted.getPendingLaunch(launch.profileId)).toEqual(rejected);
    await expect(
      restarted.clearPendingLaunch(launch.profileId, launch),
    ).rejects.toThrow('changed before it could be cleared');
    expect(restarted.getPendingLaunch(launch.profileId)).toEqual(rejected);

    await restarted.clearPendingLaunch(launch.profileId, rejected);
    expect(restarted.getPendingLaunch(launch.profileId)).toBeUndefined();
  });

  it('retains its last-known-good data and refuses to overwrite a malformed external edit', async () => {
    const { file } = await temporaryFile();
    const store = new SessionBindingStore(file, {
      now: () => new Date('2026-07-26T13:00:00.000Z'),
    });
    const original = binding('profile-fixture-original');
    await store.setBinding(original);
    const validBytes = await readFile(file, 'utf8');

    await writeFile(file, '{"version":1,"bindings":', 'utf8');
    const afterMalformedEdit = await store.reload();

    expect(afterMalformedEdit.problem).toMatchObject({
      kind: 'parse',
      file,
      occurredAt: '2026-07-26T13:00:00.000Z',
    });
    expect(store.getBinding('profile-fixture-original')).toEqual(original);

    await expect(store.setBinding(binding('profile-fixture-new'))).rejects.toBeInstanceOf(
      SessionBindingStoreBlockedError,
    );
    expect(await readFile(file, 'utf8')).toBe('{"version":1,"bindings":');
    expect(store.getBinding('profile-fixture-new')).toBeUndefined();

    await writeFile(file, validBytes, 'utf8');
    const recovered = await store.reload();
    expect(recovered.problem).toBeUndefined();
    expect(store.getBinding('profile-fixture-original')).toEqual(original);
  });

  it('keeps the previous durable file and in-memory value when the atomic writer fails', async () => {
    const { file } = await temporaryFile();
    const original = binding('profile-fixture-builder');
    const seeded = new SessionBindingStore(file);
    await seeded.setBinding(original);
    const before = await readFile(file, 'utf8');

    const interrupted = new SessionBindingStore(file, {
      atomicWrite: async () => {
        throw new Error('simulated interruption before rename');
      },
    });
    await interrupted.load();

    await expect(
      interrupted.replaceBinding(
        binding('profile-fixture-builder', {
          shortSessionId: 'short-replacement',
          fullSessionId: 'full-replacement',
          uniqueLaunchName: 'dc-replacement-launch',
          definitionFingerprint: FINGERPRINT_B,
        }),
      ),
    ).rejects.toThrow('simulated interruption');

    expect(interrupted.problem?.kind).toBe('write');
    expect(interrupted.getBinding('profile-fixture-builder')).toEqual(original);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('clears only app-owned ownership data and leaves provider-owned files untouched', async () => {
    const { directory, file } = await temporaryFile();
    const providerJob = path.join(directory, 'provider-owned', 'jobs', 'short-builder', 'state.json');
    await mkdir(path.dirname(providerJob), { recursive: true });
    await writeFile(providerJob, '{"state":"done"}\n', 'utf8');

    const store = new SessionBindingStore(file);
    const original = binding('profile-fixture-builder');
    await store.setBinding(original);
    const cleared = await store.clearBinding('profile-fixture-builder');

    expect(cleared).toEqual(original);
    expect(store.getBinding('profile-fixture-builder')).toBeUndefined();
    expect(await readFile(providerJob, 'utf8')).toBe('{"state":"done"}\n');

    const restarted = new SessionBindingStore(file);
    await restarted.load();
    expect(restarted.getBinding('profile-fixture-builder')).toBeUndefined();
  });
});

describe('binding document validation', () => {
  it('rejects binding and pending profile ids longer than the IPC routing limit', () => {
    const atLimit = `profile-fixture-${'a'.repeat(
      MAX_PROFILE_ID_LENGTH - 'profile-fixture-'.length,
    )}`;
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: { [atLimit]: binding(atLimit) },
        pendingLaunches: {},
      }),
    ).not.toThrow();

    const tooLong = `${atLimit}a`;
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: { [tooLong]: binding(tooLong) },
        pendingLaunches: {},
      }),
    ).toThrow('is too long');
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {},
        pendingLaunches: { [tooLong]: pending(tooLong) },
      }),
    ).toThrow('is too long');
  });

  it('rejects durable profile ids outside the shared IPC routing grammar', () => {
    const unroutable = 'profile-fixture-invalid.dot';
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: { [unroutable]: binding(unroutable) },
        pendingLaunches: {},
      }),
    ).toThrow('not a valid routable profile identifier');
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {},
        pendingLaunches: { [unroutable]: pending(unroutable) },
      }),
    ).toThrow('not a valid routable profile identifier');
  });

  it('rejects a provider short or full session ID owned by two profiles', () => {
    const first = binding('profile-fixture-first', {
      shortSessionId: 'shared-short',
      fullSessionId: 'full-first',
    });
    const duplicateShort = binding('profile-fixture-second', {
      shortSessionId: 'shared-short',
      fullSessionId: 'full-second',
    });
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {
          'profile-fixture-first': first,
          'profile-fixture-second': duplicateShort,
        },
        pendingLaunches: {},
      }),
    ).toThrow('belongs to both');

    const duplicateFull = binding('profile-fixture-second', {
      shortSessionId: 'short-second',
      fullSessionId: 'full-first',
    });
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {
          'profile-fixture-first': first,
          'profile-fixture-second': duplicateFull,
        },
        pendingLaunches: {},
      }),
    ).toThrow('belongs to both');
  });

  it('rejects mismatched profile keys, unknown fields, and non-SHA fingerprints', () => {
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: { 'profile-fixture-key': binding('profile-fixture-different') },
        pendingLaunches: {},
      }),
    ).toThrow('must match its containing key');

    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {
          'profile-fixture-key': { ...binding('profile-fixture-key'), rendererSessionId: 'unsafe' },
        },
        pendingLaunches: {},
      }),
    ).toThrow('unexpected field');

    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {
          'profile-fixture-key': binding('profile-fixture-key', { definitionFingerprint: 'mtime-123' }),
        },
        pendingLaunches: {},
      }),
    ).toThrow('SHA-256');

    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {},
        pendingLaunches: {
          'profile-fixture-key': pending('profile-fixture-key', {
            disposition: 'pending' as never,
          }),
        },
      }),
    ).toThrow('disposition must be "rejected-substitution"');
  });

  it('prevents duplicate launch names while allowing binding/pending Start-new overlap', () => {
    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: {},
        pendingLaunches: {
          'profile-fixture-first': pending('profile-fixture-first', { uniqueLaunchName: 'dc-shared' }),
          'profile-fixture-second': pending('profile-fixture-second', { uniqueLaunchName: 'dc-shared' }),
        },
      }),
    ).toThrow('belongs to both');

    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: { 'profile-fixture-first': binding('profile-fixture-first') },
        pendingLaunches: {
          'profile-fixture-first': pending('profile-fixture-first', {
            uniqueLaunchName: 'dc-profile-first-replacement',
          }),
        },
      }),
    ).not.toThrow();

    expect(() =>
      parseSessionBindingsFile({
        version: 1,
        bindings: { 'profile-fixture-first': binding('profile-fixture-first') },
        pendingLaunches: { 'profile-fixture-first': pending('profile-fixture-first') },
      }),
    ).toThrow('Unique launch name');
  });
});

describe('resolveExactBindingSession', () => {
  it('uses the full ID when available and never falls back to a short-ID collision', () => {
    const exactBinding = binding('profile-fixture-builder', {
      shortSessionId: 'deadbeef',
      fullSessionId: 'deadbeef-1111-2222-3333',
    });
    const shortCollision = {
      id: 'deadbeef',
      sessionId: 'deadbeef-9999-8888-7777',
      name: exactBinding.uniqueLaunchName,
      cwd: exactBinding.requestedCanonicalCwd,
    };

    expect(resolveExactBindingSession(exactBinding, [shortCollision])).toBeUndefined();

    const exact = {
      id: 'deadbeef',
      sessionId: 'deadbeef-1111-2222-3333',
      name: 'an-unrelated-display-name',
      cwd: '/provider/relocated/worktree',
    };
    expect(resolveExactBindingSession(exactBinding, [shortCollision, exact])).toBe(exact);
  });

  it('uses an exact short ID only when no full ID was persisted', () => {
    const shortOnly = binding('profile-fixture-builder', {
      shortSessionId: 'cafebabe',
      fullSessionId: undefined,
    });
    const exact = {
      id: 'cafebabe',
      sessionId: 'cafebabe-1111-2222-3333',
      name: 'anything',
      cwd: '/anything',
    };
    expect(resolveExactBindingSession(shortOnly, [exact])).toBe(exact);
  });

  it('never claims a session from matching cwd, launch name, or agent-like labels', () => {
    const exactBinding = binding('profile-fixture-builder', {
      shortSessionId: 'owned-id',
      fullSessionId: 'owned-full-id',
    });
    const descriptiveMatchOnly = {
      id: 'other-id',
      sessionId: 'other-full-id',
      name: exactBinding.uniqueLaunchName,
      agent: exactBinding.agentName,
      cwd: exactBinding.requestedCanonicalCwd,
    };

    expect(resolveExactBindingSession(exactBinding, [descriptiveMatchOnly])).toBeUndefined();
  });
});
