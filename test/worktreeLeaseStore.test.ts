import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  WorktreeLeaseStore,
  WorktreeLeaseStoreBlockedError,
  WorktreeLeaseStoreConflictError,
  emptyWorktreeLeasesFile,
  parseWorktreeLeasesFile,
} from '../src/orchestration/worktrees/leaseStore.js';
import type {
  PendingWorktreeOperation,
  WorktreeLeaseRecord,
} from '../src/orchestration/worktrees/types.js';

const temporaryDirectories: string[] = [];
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const CREATED = '2026-07-26T20:00:00.000Z';
const LEASE_ID = `lease_${'1'.repeat(32)}`;
const OPERATION_ID = `leaseop_${'2'.repeat(32)}`;

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'council-leases-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'worktree-leases.json');
}

function lease(overrides: Partial<WorktreeLeaseRecord> = {}): WorktreeLeaseRecord {
  return {
    leaseId: LEASE_ID,
    workspaceId: 'ws-fixture',
    missionId: 'mission-fixture',
    taskId: 'task-fixture',
    assignmentId: 'assignment-fixture',
    ownerProfileId: 'profile-fixture-builder',
    repositoryRoot: '/repo',
    commonGitDir: '/repo/.git',
    objectFormat: 'sha1',
    checkoutPath: `/council/worktrees/${LEASE_ID}/checkout`,
    branchRef: `refs/heads/council/fixture/${'1'.repeat(32)}`,
    baseCommit: HEAD,
    baseTree: TREE,
    state: 'provisioning',
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function pending(record: WorktreeLeaseRecord): PendingWorktreeOperation {
  return {
    operationId: OPERATION_ID,
    kind: 'provision',
    leaseId: record.leaseId,
    expectedBranchRef: record.branchRef,
    expectedCheckoutPath: record.checkoutPath,
    expectedHead: record.baseCommit,
    createdAt: CREATED,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('WorktreeLeaseStore', () => {
  it('persists a provisioning journal atomically and reloads it', async () => {
    const file = await temporaryFile();
    const store = new WorktreeLeaseStore(file);
    await store.load();
    const record = lease();
    const operation = pending(record);

    await store.transact(0, (draft) => {
      (draft.leases as Record<string, WorktreeLeaseRecord>)[record.leaseId] =
        record;
      (
        draft.pendingOperations as Record<string, PendingWorktreeOperation>
      )[operation.operationId] = operation;
    });

    const restarted = new WorktreeLeaseStore(file);
    const state = await restarted.load();
    expect(state.data.revision).toBe(1);
    expect(state.data.leases[record.leaseId]).toEqual(record);
    expect(state.data.pendingOperations[operation.operationId]).toEqual(operation);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 1,
      revision: 1,
    });
  });

  it('rejects stale revisions after a valid external edit', async () => {
    const file = await temporaryFile();
    const store = new WorktreeLeaseStore(file);
    await store.load();
    await writeFile(
      file,
      `${JSON.stringify({ ...emptyWorktreeLeasesFile(), revision: 3 })}\n`,
      'utf8',
    );

    await expect(store.transact(0, () => undefined)).rejects.toBeInstanceOf(
      WorktreeLeaseStoreConflictError,
    );
    expect(store.state.data.revision).toBe(3);
  });

  it('retains last-known-good data and blocks writes after malformed external edits', async () => {
    const file = await temporaryFile();
    const store = new WorktreeLeaseStore(file);
    await store.load();
    const record = lease();
    const operation = pending(record);
    await store.transact(0, (draft) => {
      (draft.leases as Record<string, WorktreeLeaseRecord>)[record.leaseId] =
        record;
      (
        draft.pendingOperations as Record<string, PendingWorktreeOperation>
      )[operation.operationId] = operation;
    });
    await writeFile(file, '{"version":1,"revision":', 'utf8');

    const state = await store.reload();
    expect(state.problem?.kind).toBe('parse');
    expect(state.data.leases[record.leaseId]).toEqual(record);
    await expect(store.transact(1, () => undefined)).rejects.toBeInstanceOf(
      WorktreeLeaseStoreBlockedError,
    );
    expect(await readFile(file, 'utf8')).toBe('{"version":1,"revision":');
  });

  it('strictly rejects duplicate active assignment and checkout ownership', () => {
    const first = lease();
    const second = lease({
      leaseId: `lease_${'3'.repeat(32)}`,
      branchRef: `refs/heads/council/fixture/${'3'.repeat(32)}`,
    });
    const document = {
      version: 1,
      revision: 1,
      leases: {
        [first.leaseId]: first,
        [second.leaseId]: second,
      },
      pendingOperations: {},
    };

    expect(() => parseWorktreeLeasesFile(document)).toThrow(
      /Checkout path belongs to both/,
    );
  });

  it('accepts full SHA-256 lease identities', () => {
    const record = lease({
      objectFormat: 'sha256',
      baseCommit: 'a'.repeat(64),
      baseTree: 'b'.repeat(64),
    });
    const operation = {
      ...pending(record),
      expectedHead: record.baseCommit,
    };
    expect(
      parseWorktreeLeasesFile({
        version: 1,
        revision: 1,
        leases: { [record.leaseId]: record },
        pendingOperations: { [operation.operationId]: operation },
      }).leases[record.leaseId]?.objectFormat,
    ).toBe('sha256');
  });
});
