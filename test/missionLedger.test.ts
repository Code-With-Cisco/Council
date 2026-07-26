import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  MissionLedgerRevisionError,
  MissionLedgerStore,
  MissionLedgerStoreBlockedError,
  emptyMissionLedgerFile,
  parseMissionLedgerFile,
  type MutableMissionLedger,
} from '../src/missions/ledger.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function ledgerFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'council-mission-ledger-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'mission-ledger.json');
}

function seedMission(draft: MutableMissionLedger): void {
  const timestamp = '2026-07-26T12:00:00.000Z';
  draft.missions['mission_12345678'] = {
    id: 'mission_12345678',
    workspaceId: 'workspace-test',
    title: 'Ship the feature',
    objective: 'Deliver exact, reviewed work.',
    phase: 'draft',
    taskIds: ['task_12345678'],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  draft.tasks['task_12345678'] = {
    id: 'task_12345678',
    missionId: 'mission_12345678',
    workspaceId: 'workspace-test',
    title: 'Implement',
    description: 'Make the requested change.',
    state: 'draft',
    dependsOn: [],
    handoffIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  draft.events.push({
    sequence: 1,
    kind: 'mission-created',
    missionId: 'mission_12345678',
    recordId: 'mission_12345678',
    occurredAt: timestamp,
  });
}

describe('Mission ledger strict parsing', () => {
  it('accepts the empty normalized v1 document and rejects unknown fields and versions', () => {
    expect(parseMissionLedgerFile(emptyMissionLedgerFile()).revision).toBe(0);
    expect(() =>
      parseMissionLedgerFile({
        ...emptyMissionLedgerFile(),
        version: 2,
      }),
    ).toThrow('version must be 1');
    expect(() =>
      parseMissionLedgerFile({
        ...emptyMissionLedgerFile(),
        executable: 'powershell.exe',
      }),
    ).toThrow('unexpected field');
  });

  it('rejects impossible task states and dependency cycles all-or-nothing', () => {
    const impossible = structuredClone(
      emptyMissionLedgerFile(),
    ) as MutableMissionLedger;
    seedMission(impossible);
    impossible.tasks['task_12345678'] = {
      ...impossible.tasks['task_12345678']!,
      state: 'running',
    };
    expect(() => parseMissionLedgerFile(impossible)).toThrow(
      'requires an exact execution',
    );

    const missingOwnership = structuredClone(
      emptyMissionLedgerFile(),
    ) as MutableMissionLedger;
    seedMission(missingOwnership);
    missingOwnership.tasks['task_12345678'] = {
      ...missingOwnership.tasks['task_12345678']!,
      state: 'queued',
      assigneeProfileId: 'profile-builder01',
      executionId: 'execution_missing01',
    };
    expect(() => parseMissionLedgerFile(missingOwnership)).toThrow(
      'missing or foreign execution',
    );

    const cyclic = structuredClone(
      emptyMissionLedgerFile(),
    ) as MutableMissionLedger;
    seedMission(cyclic);
    cyclic.missions['mission_12345678'] = {
      ...cyclic.missions['mission_12345678']!,
      taskIds: ['task_12345678', 'task_abcdefgh'],
    };
    cyclic.tasks['task_12345678'] = {
      ...cyclic.tasks['task_12345678']!,
      dependsOn: ['task_abcdefgh'],
    };
    cyclic.tasks['task_abcdefgh'] = {
      id: 'task_abcdefgh',
      missionId: 'mission_12345678',
      workspaceId: 'workspace-test',
      title: 'Review',
      description: 'Review it.',
      state: 'draft',
      dependsOn: ['task_12345678'],
      handoffIds: [],
      createdAt: '2026-07-26T12:00:00.000Z',
      updatedAt: '2026-07-26T12:00:00.000Z',
    };
    expect(() => parseMissionLedgerFile(cyclic)).toThrow(
      'task dependency cycle',
    );
  });
});

describe('MissionLedgerStore durability', () => {
  it('retains last-known-good data and blocks overwrite of malformed external edits', async () => {
    const file = await ledgerFile();
    const store = new MissionLedgerStore(file);
    await store.load();
    await store.transact(0, (draft) => seedMission(draft));
    const knownGood = await readFile(file, 'utf8');

    await writeFile(file, '{"version":1,"revision":', 'utf8');
    const retained = await store.reload();
    expect(retained.problem?.kind).toBe('parse');
    expect(retained.data.revision).toBe(1);
    expect(retained.data.missions['mission_12345678']?.title).toBe(
      'Ship the feature',
    );
    await expect(
      store.transact(1, (draft) => {
        draft.missions['mission_12345678'] = {
          ...draft.missions['mission_12345678']!,
          title: 'Must not overwrite',
        };
      }),
    ).rejects.toBeInstanceOf(MissionLedgerStoreBlockedError);
    expect(await readFile(file, 'utf8')).toBe(
      '{"version":1,"revision":',
    );

    await writeFile(file, knownGood, 'utf8');
    await expect(
      store.transact(1, (draft) => {
        draft.missions['mission_12345678'] = {
          ...draft.missions['mission_12345678']!,
          title: 'Recovered',
        };
      }),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('retains last-known-good data and blocks recreation after external deletion', async () => {
    const file = await ledgerFile();
    const store = new MissionLedgerStore(file);
    await store.load();
    await store.transact(0, (draft) => seedMission(draft));
    await rm(file);

    const retained = await store.reload();

    expect(retained.problem?.kind).toBe('read');
    expect(retained.data.revision).toBe(1);
    expect(retained.data.missions['mission_12345678']?.title).toBe(
      'Ship the feature',
    );
    await expect(
      store.transact(1, (draft) => {
        draft.missions['mission_12345678'] = {
          ...draft.missions['mission_12345678']!,
          title: 'Must not recreate',
        };
      }),
    ).rejects.toBeInstanceOf(MissionLedgerStoreBlockedError);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-reads disk and rejects stale compare-and-swap revisions', async () => {
    const file = await ledgerFile();
    const first = new MissionLedgerStore(file);
    const second = new MissionLedgerStore(file);
    await Promise.all([first.load(), second.load()]);
    await first.transact(0, (draft) => seedMission(draft));

    await expect(
      second.transact(0, () => undefined),
    ).rejects.toBeInstanceOf(MissionLedgerRevisionError);
    expect((await second.reload()).data.revision).toBe(1);
  });

  it('does not replace the prior file when an atomic writer fails', async () => {
    const file = await ledgerFile();
    const initial = new MissionLedgerStore(file);
    await initial.load();
    await initial.transact(0, (draft) => seedMission(draft));
    const before = await readFile(file, 'utf8');

    const failing = new MissionLedgerStore(file, {
      writeData: async () => {
        throw new Error('disk full');
      },
    });
    await failing.load();
    await expect(
      failing.transact(1, (draft) => {
        draft.missions['mission_12345678'] = {
          ...draft.missions['mission_12345678']!,
          title: 'Not durable',
        };
      }),
    ).rejects.toThrow('disk full');
    expect(failing.problem?.kind).toBe('write');
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
