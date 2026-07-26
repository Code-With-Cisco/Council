import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function mapper(): Promise<{
  slotMode(slot: unknown): string;
  actionState(
    slot: unknown,
    options: unknown,
  ): {
    start: boolean;
    startNew: boolean;
    resume: boolean;
    stop: boolean;
    logs: boolean;
    reply: boolean;
    clear: boolean;
  };
  createProfileActionRouter(api: Record<string, unknown>): {
    start(profileId: string, expectedDefinitionFingerprint: string): unknown;
  };
  findCouncilSlot(snapshot: unknown): unknown;
  invokeProfileStart(
    slot: { member: { key: string } },
    actions: {
      start(profileId: string, expectedDefinitionFingerprint: string): unknown;
    },
  ): unknown;
  mapSnapshot(snapshot: unknown, options: unknown): {
    agents: {
      key: string;
      mode: string;
      missionBadge?: { label: string; missionTitle: string };
    }[];
    stale: boolean;
  };
}> {
  const [missionSource, source] = await Promise.all([
    readFile(
      path.join(root, 'src', 'ui', 'renderer', 'mission-view-model.js'),
      'utf8',
    ),
    readFile(
      path.join(root, 'src', 'ui', 'renderer', 'scene-view-model.js'),
      'utf8',
    ),
  ]);
  const window: Record<string, unknown> = {};
  runInNewContext(missionSource, { window });
  runInNewContext(source, { window });
  return window['CouncilSceneViewModel'] as Awaited<ReturnType<typeof mapper>>;
}

function slot(overrides: Record<string, unknown> = {}) {
  return {
    member: { key: 'profile-12345678', label: 'Builder', visible: true },
    session: undefined,
    bindingState: 'none',
    staleBinding: false,
    validation: { launchable: true, fingerprint: 'a'.repeat(64) },
    ...overrides,
  };
}

describe('Snapshot -> pixel office scene view model', () => {
  it('maps exact binding and definition states truthfully', async () => {
    const view = await mapper();
    expect(view.slotMode(slot())).toBe('missing');
    expect(view.slotMode(slot({ validation: { launchable: false } }))).toBe('failed');
    expect(
      view.slotMode(
        slot({
          validation: { launchable: false },
          bindingState: 'active',
          session: { id: 'exact001', state: 'working', cold: false },
        }),
      ),
    ).toBe('working');
    expect(view.slotMode(slot({ staleBinding: true }))).toBe('failed');
    expect(
      view.slotMode(slot({ session: { state: 'working', cold: false } })),
    ).toBe('working');
    expect(
      view.slotMode(slot({ session: { state: 'blocked', cold: false } })),
    ).toBe('blocked');
    expect(view.slotMode(slot({ session: { state: 'done', cold: true } }))).toBe('done');
    expect(
      view.slotMode(slot({ session: { state: 'stopped', cold: true } })),
    ).toBe('stopped');
  });

  it('preserves stale state and stable profile IDs while paging visible profiles', async () => {
    const view = await mapper();
    const snapshot = {
      roster: {
        squad: [
          slot(),
          slot({ member: { key: 'profile-hidden00', label: 'Hidden', visible: false } }),
        ],
      },
      rosterError: { message: 'stale' },
    };
    const scene = view.mapSnapshot(snapshot, {
      page: 0,
      perPage: 5,
      runtimeAvailable: true,
    });
    expect(scene.agents.map((agent) => agent.key)).toEqual(['profile-12345678']);
    expect(scene.stale).toBe(true);
    expect(
      view.mapSnapshot(
        { ...snapshot, rosterError: undefined, definitionError: 'watch failed' },
        { page: 0, perPage: 5, runtimeAvailable: true },
      ).stale,
    ).toBe(true);
  });

  it('adds the same durable Mission assignment used by cards to the pixel scene', async () => {
    const view = await mapper();
    const scene = view.mapSnapshot(
      { roster: { squad: [slot()] } },
      {
        page: 0,
        perPage: 5,
        runtimeAvailable: true,
        missionState: {
          projection: {
            assignmentsByProfileId: {
              'profile-12345678': [
                {
                  missionTitle: 'Provider-neutral missions',
                  taskTitle: 'Mission UI',
                  taskState: 'running',
                  providerId: 'codex',
                },
              ],
            },
          },
        },
      },
    );
    expect(scene.agents[0]?.missionBadge).toMatchObject({
      label: 'Mission UI',
      missionTitle: 'Provider-neutral missions',
    });
  });

  it('disables definition-based starts for missing, ambiguous, stale, and untrusted states', async () => {
    const view = await mapper();
    const ready = {
      workspaceReady: true,
      trusted: true,
      definitionStale: false,
      capabilities: {
        start: true,
        stop: true,
        logs: true,
        plainTextReply: true,
      },
    };
    expect(view.actionState(slot(), ready).start).toBe(true);
    expect(
      view.actionState(slot({ validation: { launchable: false } }), ready).start,
    ).toBe(false);
    expect(
      view.actionState(
        slot({
          validation: {
            launchable: false,
            diagnostic: 'Same-tier definitions are ambiguous.',
          },
        }),
        ready,
      ).start,
    ).toBe(false);
    expect(
      view.actionState(slot(), { ...ready, definitionStale: true }).start,
    ).toBe(false);
    expect(view.actionState(slot(), { ...ready, trusted: false }).start).toBe(
      false,
    );
  });

  it('blocks definition launches while preserving exact lifecycle actions during profile staleness', async () => {
    const view = await mapper();
    const actions = view.actionState(
      slot({
        session: {
          id: 'bound123',
          state: 'blocked',
          waitingFor: 'input needed',
        },
        bindingState: 'active',
      }),
      {
        workspaceReady: true,
        trusted: true,
        definitionStale: true,
        capabilities: {
          start: true,
          stop: true,
          logs: true,
          plainTextReply: true,
        },
      },
    );

    expect(actions.start).toBe(false);
    expect(actions.startNew).toBe(false);
    expect(actions.stop).toBe(true);
    expect(actions.logs).toBe(true);
    expect(actions.reply).toBe(true);
  });

  it('does not offer Clear while exact binding absence is unverified', async () => {
    const view = await mapper();
    const actions = view.actionState(
      slot({
        bindingState: 'unavailable',
        staleBinding: false,
      }),
      {
        workspaceReady: true,
        trusted: true,
        capabilities: {},
      },
    );

    expect(actions.clear).toBe(false);
  });

  it('does not offer Clear while the durable binding store is malformed', async () => {
    const view = await mapper();
    const stale = slot({
      bindingState: 'stale',
      staleBinding: true,
    });
    const ready = {
      workspaceReady: true,
      trusted: true,
      capabilities: {},
    };

    expect(
      view.actionState(stale, { ...ready, bindingHealthy: false }).clear,
    ).toBe(false);
    expect(
      view.actionState(stale, { ...ready, bindingHealthy: true }).clear,
    ).toBe(true);
  });

  it('routes card and pixel-detail starts through the same opaque profile action', async () => {
    const view = await mapper();
    const starts: [string, string][] = [];
    const router = view.createProfileActionRouter({
      startMember: (
        profileId: string,
        expectedDefinitionFingerprint: string,
      ) => {
        starts.push([profileId, expectedDefinitionFingerprint]);
        return profileId;
      },
      startNewMember: () => undefined,
      resumeMember: () => undefined,
      stopSession: () => undefined,
      logs: () => undefined,
      reply: () => undefined,
      clearBinding: () => undefined,
    });
    const selected = {
      member: { key: 'profile-shared001' },
      validation: { fingerprint: 'b'.repeat(64) },
    };
    view.invokeProfileStart(selected, router); // card Start
    view.invokeProfileStart(selected, router); // pixel detail Start
    expect(starts).toEqual([
      ['profile-shared001', 'b'.repeat(64)],
      ['profile-shared001', 'b'.repeat(64)],
    ]);
  });

  it('locates only the explicitly internal Council lead for dedicated lifecycle controls', async () => {
    const view = await mapper();
    const ordinary = slot({
      member: {
        key: 'profile-normal01',
        label: 'Visible lead',
        visible: true,
        mode: 'normal',
        agent: 'council-lead',
      },
    });
    const configuredInternal = slot({
      member: {
        key: 'profile-configured-internal01',
        label: 'Configured internal lead',
        visible: false,
        mode: 'internal',
        agent: 'council-lead',
        configured: true,
      },
    });
    const internal = slot({
      member: {
        key: 'profile-internal01',
        label: 'Council Lead',
        visible: false,
        mode: 'internal',
        agent: 'council-lead',
        configured: false,
      },
    });

    expect(
      view.findCouncilSlot({
        roster: { squad: [ordinary, configuredInternal, internal] },
      }),
    ).toEqual(internal);
    expect(
      view.findCouncilSlot({
        roster: { squad: [ordinary, configuredInternal] },
      }),
    ).toBeUndefined();
  });
});
