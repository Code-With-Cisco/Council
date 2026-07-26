import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_THREAD_BINDINGS_FILENAME,
  CODEX_PROVIDER_ID,
  CodexThreadBindingConflictError,
  CodexThreadBindingStore,
  CodexThreadBindingWriteBlockedError,
  emptyCodexThreadBindingsFile,
  parseCodexThreadBindingsFile,
  type CodexThreadBindingRecord,
  type PendingCodexThreadStart,
} from '../src/providers/codex/threadBindings.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'council-codex-bindings-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const timestamp = '2026-07-26T12:00:00.000Z';

function pending(
  overrides: Partial<PendingCodexThreadStart> = {},
): PendingCodexThreadStart {
  return {
    operationId: 'operation-codex-000001',
    providerId: CODEX_PROVIDER_ID,
    workspaceId: 'workspace-000001',
    workspacePath: path.resolve('/tmp', 'Council Workspace'),
    missionId: 'mission-000001',
    taskId: 'task-000001',
    assignmentId: 'assignment-000001',
    roleProfileId: 'profile-000001',
    requestFingerprint: 'a'.repeat(64),
    accessMode: 'workspace-write',
    startedAt: timestamp,
    ...overrides,
  };
}

function binding(
  overrides: Partial<CodexThreadBindingRecord> = {},
): CodexThreadBindingRecord {
  return {
    bindingId: 'binding-codex-000001',
    providerId: CODEX_PROVIDER_ID,
    workspaceId: 'workspace-000001',
    workspacePath: path.resolve('/tmp', 'Council Workspace'),
    missionId: 'mission-000001',
    taskId: 'task-000001',
    assignmentId: 'assignment-000001',
    roleProfileId: 'profile-000001',
    requestFingerprint: 'a'.repeat(64),
    accessMode: 'workspace-write',
    threadId: '019c-thread-000001',
    initialTaskDispatchState: 'not-started',
    state: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('Codex thread binding schema', () => {
  it('parses a strict valid file and rejects unknown fields', () => {
    const record = binding();
    expect(
      parseCodexThreadBindingsFile({
        version: 1,
        revision: 2,
        bindings: { [record.assignmentId]: record },
        pendingStarts: {},
      }),
    ).toMatchObject({ version: 1, revision: 2 });

    expect(() =>
      parseCodexThreadBindingsFile({
        ...emptyCodexThreadBindingsFile(),
        credentials: 'must never be stored',
      }),
    ).toThrow(/unknown field "credentials"/);
    expect(() =>
      parseCodexThreadBindingsFile({
        ...emptyCodexThreadBindingsFile(),
        bindings: {
          'assignment-000001': {
            ...record,
            token: 'secret',
          },
        },
      }),
    ).toThrow(/unknown field "token"/);
  });

  it('enforces one owner per exact thread and active-turn consistency', () => {
    const first = binding();
    const second = binding({
      bindingId: 'binding-codex-000002',
      assignmentId: 'assignment-000002',
    });
    expect(() =>
      parseCodexThreadBindingsFile({
        version: 1,
        revision: 1,
        bindings: {
          [first.assignmentId]: first,
          [second.assignmentId]: second,
        },
        pendingStarts: {},
      }),
    ).toThrow(/belongs to multiple assignments/);

    expect(() =>
      parseCodexThreadBindingsFile({
        version: 1,
        revision: 1,
        bindings: {
          [first.assignmentId]: { ...first, state: 'active' },
        },
        pendingStarts: {},
      }),
    ).toThrow(/must name activeTurnId/);
  });

  it('does not permit one assignment to be bound and pending', () => {
    const record = binding();
    const journal = pending();
    expect(() =>
      parseCodexThreadBindingsFile({
        version: 1,
        revision: 1,
        bindings: { [record.assignmentId]: record },
        pendingStarts: { [journal.assignmentId]: journal },
      }),
    ).toThrow(/both bound and pending/);
  });
});

describe('CodexThreadBindingStore', () => {
  it('opens a missing store without writing or inventing ownership', async () => {
    const userData = await temporaryRoot();
    const write = vi.fn();
    const store = new CodexThreadBindingStore(userData, { writeFile: write });

    const loaded = await store.load();

    expect(loaded).toEqual({
      data: emptyCodexThreadBindingsFile(),
      source: 'missing',
      writeBlocked: false,
      problem: undefined,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('journals before start, commits the exact returned thread, and survives restart', async () => {
    const userData = await temporaryRoot();
    const store = new CodexThreadBindingStore(userData);
    await store.load();
    const journal = pending();

    await store.beginStart(0, journal);
    expect(store.state.data).toMatchObject({
      revision: 1,
      pendingStarts: { [journal.assignmentId]: journal },
    });
    const record = binding();
    await store.commitStart(1, journal.operationId, record);

    expect(store.state.data).toMatchObject({
      revision: 2,
      bindings: { [record.assignmentId]: record },
      pendingStarts: {},
    });
    const restarted = new CodexThreadBindingStore(userData);
    await restarted.load();
    expect(restarted.getBinding(record.assignmentId)).toEqual(record);
    expect(
      JSON.parse(
        await readFile(
          path.join(userData, CODEX_THREAD_BINDINGS_FILENAME),
          'utf8',
        ),
      ),
    ).not.toHaveProperty('credentials');
  });

  it('rejects stale revisions and mismatched acknowledgements', async () => {
    const userData = await temporaryRoot();
    const store = new CodexThreadBindingStore(userData);
    await store.load();
    const journal = pending();
    await store.beginStart(0, journal);

    await expect(store.beginStart(0, journal)).rejects.toBeInstanceOf(
      CodexThreadBindingConflictError,
    );
    await expect(
      store.commitStart(
        1,
        journal.operationId,
        binding({ workspaceId: 'workspace-different' }),
      ),
    ).rejects.toThrow(/does not match/);
    expect(store.state.data.pendingStarts[journal.assignmentId]).toEqual(journal);
  });

  it('retains last-known-good state and blocks overwrite after malformed edits', async () => {
    const userData = await temporaryRoot();
    const store = new CodexThreadBindingStore(userData);
    await store.load();
    const journal = pending();
    await store.beginStart(0, journal);
    const file = path.join(userData, CODEX_THREAD_BINDINGS_FILENAME);
    await writeFile(file, '{malformed', 'utf8');

    const loaded = await store.reload();

    expect(loaded.source).toBe('last-known-good');
    expect(loaded.writeBlocked).toBe(true);
    expect(loaded.data.pendingStarts[journal.assignmentId]).toEqual(journal);
    await expect(
      store.clearPending(1, journal.assignmentId, journal.operationId),
    ).rejects.toBeInstanceOf(CodexThreadBindingWriteBlockedError);
    expect(await readFile(file, 'utf8')).toBe('{malformed');
  });

  it('retains last-known-good state and blocks recreation after external deletion', async () => {
    const userData = await temporaryRoot();
    const store = new CodexThreadBindingStore(userData);
    await store.load();
    const journal = pending();
    await store.beginStart(0, journal);
    const file = path.join(userData, CODEX_THREAD_BINDINGS_FILENAME);
    await rm(file);

    const loaded = await store.reload();

    expect(loaded.source).toBe('last-known-good');
    expect(loaded.writeBlocked).toBe(true);
    expect(loaded.problem?.code).toBe('read-failed');
    expect(loaded.data.pendingStarts[journal.assignmentId]).toEqual(journal);
    await expect(
      store.clearPending(1, journal.assignmentId, journal.operationId),
    ).rejects.toBeInstanceOf(CodexThreadBindingWriteBlockedError);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unblocks only after an authoritative external repair', async () => {
    const userData = await temporaryRoot();
    const file = path.join(userData, CODEX_THREAD_BINDINGS_FILENAME);
    await writeFile(file, '{bad', 'utf8');
    const store = new CodexThreadBindingStore(userData);
    expect((await store.load()).writeBlocked).toBe(true);

    await writeFile(
      file,
      `${JSON.stringify(emptyCodexThreadBindingsFile())}\n`,
      'utf8',
    );
    expect((await store.reload()).writeBlocked).toBe(false);
    await expect(store.beginStart(0, pending())).resolves.toMatchObject({
      assignmentId: 'assignment-000001',
    });
  });

  it('does not advance in-memory authority when atomic persistence fails', async () => {
    const userData = await temporaryRoot();
    const writeFileFailure = vi.fn(async () => {
      throw new Error('disk full');
    });
    const store = new CodexThreadBindingStore(userData, {
      writeFile: writeFileFailure,
    });
    await store.load();

    await expect(store.beginStart(0, pending())).rejects.toThrow('disk full');

    expect(store.state.data).toEqual(emptyCodexThreadBindingsFile());
    expect(store.getBinding('assignment-000001')).toBeUndefined();
  });

  it('journals the initial task before provider dispatch and retains its exact turn identity', async () => {
    const userData = await temporaryRoot();
    const store = new CodexThreadBindingStore(userData);
    await store.load();
    const journal = pending();
    await store.beginStart(0, journal);
    await store.commitStart(1, journal.operationId, binding());

    const pendingDispatch = await store.beginInitialTaskDispatch(
      2,
      journal.assignmentId,
    );
    expect(pendingDispatch).toMatchObject({
      initialTaskDispatchState: 'pending',
      state: 'idle',
    });

    const restarted = new CodexThreadBindingStore(userData);
    await restarted.load();
    expect(restarted.getBinding(journal.assignmentId)).toMatchObject({
      initialTaskDispatchState: 'pending',
      state: 'idle',
    });

    const active = await restarted.updateTurn(
      3,
      journal.assignmentId,
      '019c-turn-000001',
      'active',
    );
    expect(active).toMatchObject({
      activeTurnId: '019c-turn-000001',
      initialTaskDispatchState: 'started',
      initialTaskTurnId: '019c-turn-000001',
      state: 'active',
    });
    const idle = await restarted.updateTurn(
      4,
      journal.assignmentId,
      undefined,
      'idle',
    );
    expect(idle.activeTurnId).toBeUndefined();
    expect(idle.initialTaskDispatchState).toBe('started');
    expect(idle.initialTaskTurnId).toBe('019c-turn-000001');
    expect(idle.state).toBe('idle');
  });
});
