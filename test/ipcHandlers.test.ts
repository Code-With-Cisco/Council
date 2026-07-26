import { describe, expect, it, vi } from 'vitest';
import type { CliResult } from '../src/integration/types.js';
import type { AgentSupervisorPort } from '../src/supervisor/contracts.js';
import {
  registerCouncilIpc,
  type CouncilIpcDependencies,
  type IpcRegistrar,
} from '../src/ui/ipcHandlers.js';
import { IPC_CHANNELS, type UiResult } from '../src/ui/ipc.js';

function success<T>(value: T): CliResult<T> {
  return { ok: true, value, raw: '', argv: [], durationMs: 0 };
}

function fixture(trusted = true, confirm = true, councilBound = false) {
  const handlers = new Map<
    string,
    (event: unknown, ...args: readonly unknown[]) => unknown
  >();
  const registrar: IpcRegistrar = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  };
  const stopSession = vi.fn(async () => success('stopped'));
  const logs = vi.fn(async () => success('logs'));
  const reply = vi.fn(async () =>
    success({ delivered: true, acknowledged: true, output: '' }),
  );
  const startNewMember = vi.fn(async () =>
    success({ id: 'new00001', name: 'dc-new', unknownAgent: undefined }),
  );
  const startCouncilReview = vi.fn(async () =>
    success({ id: 'council1', name: 'dc-council', unknownAgent: undefined }),
  );
  const confirmStartNew = vi.fn(async () => confirm);
  const supervisor = {
    stopSession,
    logs,
    reply,
    startNewMember,
    startMember: vi.fn(),
    resumeMember: vi.fn(),
    clearBinding: vi.fn(),
    wakeSquad: vi.fn(),
    councilReviewNeedsReplacement: () => councilBound,
    startCouncilReview,
  } as unknown as AgentSupervisorPort;
  const afterAction = async <T>(result: CliResult<T>): Promise<UiResult<T>> =>
    result.ok
      ? { ok: true, value: result.value }
      : { ok: false, message: result.message, details: result.raw };
  const dependencies: CouncilIpcDependencies = {
    isTrusted: () => trusted,
    getState: () => undefined,
    chooseWorkspace: async () => ({ ok: false, message: 'not used' }),
    getSupervisor: () => supervisor,
    canLaunchDefinitions: () => true,
    confirmStartNew,
    afterAction,
  };
  registerCouncilIpc(registrar, dependencies);
  const invoke = async (channel: string, ...args: readonly unknown[]) =>
    handlers.get(channel)?.({}, ...args);
  return {
    invoke,
    stopSession,
    logs,
    reply,
    startNewMember,
    startCouncilReview,
    confirmStartNew,
  };
}

describe('typed privileged IPC handlers', () => {
  it('rejects an untrusted sender before invoking the supervisor', async () => {
    const f = fixture(false);
    const result = await f.invoke(IPC_CHANNELS.stopSession, 'profile-12345678');
    expect(result).toEqual({ ok: false, message: 'Untrusted IPC sender.' });
    expect(f.stopSession).not.toHaveBeenCalled();
  });

  it('rejects raw/unbound provider IDs, wrong types, and oversized IDs', async () => {
    const f = fixture();
    for (const value of ['deadbeef', 123, `profile-${'x'.repeat(200)}`]) {
      for (const [channel, extra] of [
        [IPC_CHANNELS.stopSession, []],
        [IPC_CHANNELS.logs, []],
        [IPC_CHANNELS.reply, ['ordinary text']],
      ] as const) {
        const result = await f.invoke(channel, value, ...extra);
        expect(result).toEqual({
          ok: false,
          message: 'Invalid opaque profile ID.',
        });
      }
    }
    expect(f.stopSession).not.toHaveBeenCalled();
    expect(f.logs).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('routes Stop, Logs, and Reply only through an opaque profile identity', async () => {
    const f = fixture();
    await f.invoke(IPC_CHANNELS.stopSession, 'profile-12345678');
    await f.invoke(IPC_CHANNELS.logs, 'profile-12345678');
    await f.invoke(IPC_CHANNELS.reply, 'profile-12345678', 'ordinary text');
    expect(f.stopSession).toHaveBeenCalledExactlyOnceWith('profile-12345678');
    expect(f.logs).toHaveBeenCalledExactlyOnceWith('profile-12345678');
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(
      'profile-12345678',
      'ordinary text',
    );
  });

  it('blocks control/oversized reply values before supervisor access', async () => {
    const f = fixture();
    await f.invoke(IPC_CHANNELS.reply, 'profile-12345678', 'two\nlines');
    await f.invoke(IPC_CHANNELS.reply, 'profile-12345678', 'x'.repeat(8_001));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('requires the privileged Start-new confirmation', async () => {
    const canceled = fixture(true, false);
    expect(
      await canceled.invoke(
        IPC_CHANNELS.startNewMember,
        'profile-12345678',
        'a'.repeat(64),
      ),
    ).toEqual({ ok: false, message: 'Start new was canceled.' });
    expect(canceled.startNewMember).not.toHaveBeenCalled();
  });

  it('blocks definition-based launches while the controller projection is stale', async () => {
    const f = fixture();
    const handlers = new Map<
      string,
      (event: unknown, ...args: readonly unknown[]) => unknown
    >();
    const startMember = vi.fn();
    const council = vi.fn();
    registerCouncilIpc(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      {
        isTrusted: () => true,
        getState: () => undefined,
        chooseWorkspace: async () => ({ ok: false, message: 'not used' }),
        getSupervisor: () =>
          ({
            startMember,
            startCouncilReview: council,
          }) as unknown as AgentSupervisorPort,
        canLaunchDefinitions: () => false,
        confirmStartNew: async () => true,
        afterAction: async <T>(result: CliResult<T>) =>
          result.ok
            ? { ok: true, value: result.value }
            : { ok: false, message: result.message },
      },
    );
    const startResult = await handlers.get(IPC_CHANNELS.startMember)?.(
      {},
      'profile-12345678',
      'a'.repeat(64),
    );
    const councilResult = await handlers.get(IPC_CHANNELS.council)?.(
      {},
      'review this',
    );
    expect(startResult).toMatchObject({ ok: false });
    expect(councilResult).toMatchObject({ ok: false });
    expect(startMember).not.toHaveBeenCalled();
    expect(council).not.toHaveBeenCalled();
    // Exact-session operations are deliberately independent of definition
    // freshness; their own binding and runtime authorization still applies.
    expect(f.stopSession).not.toHaveBeenCalled();
  });

  it('requires a SHA-256 fingerprint from the displayed definition for Start', async () => {
    const f = fixture();
    for (const fingerprint of [undefined, 'short', 'G'.repeat(64)]) {
      const result = await f.invoke(
        IPC_CHANNELS.startMember,
        'profile-12345678',
        fingerprint,
      );
      expect(result).toEqual({
        ok: false,
        message: 'Invalid displayed definition fingerprint.',
      });
    }
  });

  it('binds Council launch to its displayed fingerprint and confirms replacement', async () => {
    const fingerprint = 'c'.repeat(64);
    const first = fixture();
    await first.invoke(
      IPC_CHANNELS.council,
      'Review the release.',
      fingerprint,
    );
    expect(first.confirmStartNew).not.toHaveBeenCalled();
    expect(first.startCouncilReview).toHaveBeenCalledExactlyOnceWith(
      'Review the release.',
      fingerprint,
      false,
    );

    const canceled = fixture(true, false, true);
    expect(
      await canceled.invoke(
        IPC_CHANNELS.council,
        'Replace the prior review.',
        fingerprint,
      ),
    ).toEqual({ ok: false, message: 'Start new was canceled.' });
    expect(canceled.confirmStartNew).toHaveBeenCalledOnce();
    expect(canceled.startCouncilReview).not.toHaveBeenCalled();

    const confirmed = fixture(true, true, true);
    await confirmed.invoke(
      IPC_CHANNELS.council,
      'Replace the prior review.',
      fingerprint,
    );
    expect(confirmed.startCouncilReview).toHaveBeenCalledExactlyOnceWith(
      'Replace the prior review.',
      fingerprint,
      true,
    );
  });

  it('rejects a missing or malformed displayed Council fingerprint', async () => {
    const f = fixture();
    for (const fingerprint of [undefined, 'short', 'G'.repeat(64)]) {
      const result = await f.invoke(
        IPC_CHANNELS.council,
        'Review this.',
        fingerprint,
      );
      expect(result).toEqual({
        ok: false,
        message: 'Invalid displayed Council definition fingerprint.',
      });
    }
    expect(f.startCouncilReview).not.toHaveBeenCalled();
  });
});
