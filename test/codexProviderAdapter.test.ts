import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerError,
  type CodexAppServerClient,
} from '../src/providers/codex/appServerClient.js';
import {
  CodexMissionProviderAdapter,
  fingerprintCodexAssignment,
} from '../src/providers/codex/adapter.js';
import type {
  CodexAppServerEvent,
  CodexConnectionState,
  CodexThreadStartRequest,
  CodexTurnStartRequest,
} from '../src/providers/codex/protocol.js';
import {
  CodexThreadBindingStore,
} from '../src/providers/codex/threadBindings.js';
import type { MissionRoleAssignment } from '../src/providers/missionContracts.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'council-codex-adapter-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const readyState: CodexConnectionState = {
  phase: 'ready',
  initialized: true,
  userAgent: 'codex-cli/test',
  platformFamily: 'windows',
  platformOs: 'windows',
  account: {
    requiresOpenaiAuth: true,
    authenticated: true,
    accountKind: 'chatgpt',
    displayLabel: 'person@example.test',
  },
  diagnostic: undefined,
};

class FakeCodexClient {
  state: CodexConnectionState = readyState;
  readonly connect = vi.fn(async () => this.state);
  readonly startThread = vi.fn(
    async (request: CodexThreadStartRequest) => ({
      thread: {
        id: '019c-thread-000001',
        cwd: request.cwd,
        status: { type: 'idle' as const },
      },
      model: request.model ?? 'gpt-test',
      modelProvider: 'openai',
      cwd: request.cwd,
    }),
  );
  readonly resumeThread = vi.fn(
    async (threadId: string, cwd: string) => ({
      id: threadId,
      cwd,
      status: { type: 'idle' as const },
    }),
  );
  readonly startTurn = vi.fn(async (_request: CodexTurnStartRequest) => ({
    id: '019c-turn-000001',
    status: 'inProgress',
    error: null,
  }));
  readonly interruptTurn = vi.fn(async () => undefined);
  readonly resolveApproval = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  private eventListener:
    | ((event: CodexAppServerEvent) => void)
    | undefined;

  onEvent(listener: (event: CodexAppServerEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      this.eventListener = undefined;
    };
  }

  emit(event: CodexAppServerEvent): void {
    this.eventListener?.(event);
  }
}

function assignment(workspacePath: string): MissionRoleAssignment {
  const unsigned = {
    workspaceId: 'workspace-000001',
    workspacePath,
    missionId: 'mission-000001',
    taskId: 'task-000001',
    assignmentId: 'assignment-000001',
    roleProfileId: 'profile-000001',
    roleInstructions: 'Implement only the assigned task and report exact evidence.',
    accessMode: 'workspace-write' as const,
    model: 'gpt-test',
  };
  return {
    ...unsigned,
    requestFingerprint: fingerprintCodexAssignment(unsigned),
  };
}

async function fixture() {
  const userData = await temporaryRoot();
  const workspace = path.join(userData, 'leased worktree');
  const bindings = new CodexThreadBindingStore(userData, {
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });
  await bindings.load();
  const client = new FakeCodexClient();
  const adapter = new CodexMissionProviderAdapter({
    client: client as unknown as CodexAppServerClient,
    bindings,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    operationId: () => 'operation-codex-000001',
    bindingId: () => 'binding-codex-000001',
    maxOutputChars: 8,
  });
  return { userData, workspace, bindings, client, adapter };
}

describe('CodexMissionProviderAdapter', () => {
  it('journals and binds a new persistent thread before reporting success', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);

    const result = await f.adapter.ensureConversation(role, 0);

    expect(result).toEqual({
      ok: true,
      value: {
        providerId: 'codex',
        providerConversationId: '019c-thread-000001',
        assignmentId: role.assignmentId,
        resumed: false,
        initialTaskDispatchState: 'not-started',
      },
    });
    expect(f.client.startThread).toHaveBeenCalledExactlyOnceWith({
      cwd: path.normalize(f.workspace),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: role.roleInstructions,
      model: 'gpt-test',
    });
    expect(f.bindings.state.data).toMatchObject({
      revision: 2,
      pendingStarts: {},
      bindings: {
        [role.assignmentId]: {
          threadId: '019c-thread-000001',
          workspacePath: path.normalize(f.workspace),
          requestFingerprint: role.requestFingerprint,
          accessMode: 'workspace-write',
          initialTaskDispatchState: 'not-started',
        },
      },
    });
  });

  it('resumes only the exact durable thread and never starts a replacement', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);
    await f.adapter.ensureConversation(role, 0);

    const result = await f.adapter.ensureConversation(role, 2);

    expect(result).toMatchObject({
      ok: true,
      value: {
        providerConversationId: '019c-thread-000001',
        resumed: true,
        initialTaskDispatchState: 'not-started',
      },
    });
    expect(f.client.startThread).toHaveBeenCalledOnce();
    expect(f.client.resumeThread).toHaveBeenCalledExactlyOnceWith(
      '019c-thread-000001',
      path.normalize(f.workspace),
    );
  });

  it('rejects a resumed assignment whose reviewed contract changed', async () => {
    const f = await fixture();
    const original = assignment(f.workspace);
    await f.adapter.ensureConversation(original, 0);
    const changedUnsigned = {
      workspaceId: original.workspaceId,
      workspacePath: original.workspacePath,
      missionId: original.missionId,
      taskId: original.taskId,
      assignmentId: original.assignmentId,
      roleProfileId: original.roleProfileId,
      roleInstructions: original.roleInstructions,
      accessMode: 'read-only' as const,
      ...(original.model === undefined ? {} : { model: original.model }),
    };
    const changed: MissionRoleAssignment = {
      ...changedUnsigned,
      requestFingerprint: fingerprintCodexAssignment(changedUnsigned),
    };

    const result = await f.adapter.ensureConversation(changed, 2);

    expect(result).toMatchObject({
      ok: false,
      kind: 'conflict',
      message: expect.stringContaining('different Codex conversation'),
    });
    expect(f.client.resumeThread).not.toHaveBeenCalled();
  });

  it('preserves the pending journal on timeout or wrong provider cwd', async () => {
    const timedOut = await fixture();
    timedOut.client.startThread.mockRejectedValueOnce(
      new CodexAppServerError('request-timeout', 'uncertain start'),
    );

    expect(
      await timedOut.adapter.ensureConversation(
        assignment(timedOut.workspace),
        0,
      ),
    ).toEqual({
      ok: false,
      kind: 'uncertain-outcome',
      message: 'uncertain start',
    });
    expect(
      timedOut.bindings.state.data.pendingStarts['assignment-000001'],
    ).toBeDefined();
    expect(
      timedOut.bindings.state.data.bindings['assignment-000001'],
    ).toBeUndefined();

    const relocated = await fixture();
    relocated.client.startThread.mockResolvedValueOnce({
      thread: {
        id: '019c-thread-relocated',
        cwd: path.join(relocated.userData, 'provider-worktree'),
        status: { type: 'idle' },
      },
      model: 'gpt-test',
      modelProvider: 'openai',
      cwd: path.join(relocated.userData, 'provider-worktree'),
    });
    expect(
      await relocated.adapter.ensureConversation(
        assignment(relocated.workspace),
        0,
      ),
    ).toMatchObject({
      ok: false,
      kind: 'provider-failure',
      message: expect.stringContaining('outside the exact Council assignment workspace'),
    });
    expect(
      relocated.bindings.state.data.pendingStarts['assignment-000001'],
    ).toBeDefined();
  });

  it('dispatches against the exact binding and projects bounded output/completion', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);
    await f.adapter.ensureConversation(role, 0);
    const projected = vi.fn();
    f.adapter.onEvent(projected);

    const turn = await f.adapter.dispatchTurn(role.assignmentId, 'Do the work.');

    expect(turn).toMatchObject({
      ok: true,
      value: {
        providerConversationId: '019c-thread-000001',
        providerTurnId: '019c-turn-000001',
      },
    });
    expect(f.bindings.getBinding(role.assignmentId)).toMatchObject({
      state: 'active',
      activeTurnId: '019c-turn-000001',
    });
    f.client.emit({
      type: 'output',
      threadId: '019c-thread-000001',
      turnId: '019c-turn-000001',
      itemId: 'item-1',
      stream: 'assistant',
      delta: '1234567890',
      truncated: false,
    });
    f.client.emit({
      type: 'turn-completed',
      threadId: '019c-thread-000001',
      turnId: '019c-turn-000001',
      payload: {
        id: '019c-turn-000001',
        status: 'completed',
        error: null,
      },
    });
    await vi.waitFor(() => {
      expect(f.bindings.getBinding(role.assignmentId)?.state).toBe('idle');
    });

    expect(f.adapter.recentOutput(role.assignmentId)).toBe('34567890');
    expect(projected).toHaveBeenCalledWith({
      type: 'output',
      providerId: 'codex',
      providerConversationId: '019c-thread-000001',
      providerTurnId: '019c-turn-000001',
      assignmentId: role.assignmentId,
      text: '1234567890',
      truncated: false,
    });
  });

  it('requires the exact active turn for interrupt and clears it durably', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);
    await f.adapter.ensureConversation(role, 0);
    expect(await f.adapter.interruptTurn(role.assignmentId)).toMatchObject({
      ok: false,
      kind: 'invalid-assignment',
    });
    await f.adapter.dispatchTurn(role.assignmentId, 'Begin.');

    expect(await f.adapter.interruptTurn(role.assignmentId)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(f.client.interruptTurn).toHaveBeenCalledExactlyOnceWith(
      '019c-thread-000001',
      '019c-turn-000001',
    );
    expect(f.bindings.getBinding(role.assignmentId)).toMatchObject({
      state: 'idle',
    });
  });

  it('serializes concurrent dispatches so only one provider turn can start', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);
    await f.adapter.ensureConversation(role, 0);
    let enteredStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    let releaseStart!: () => void;
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    f.client.startTurn.mockImplementationOnce(async () => {
      enteredStart();
      await startReleased;
      return {
        id: '019c-turn-race001',
        status: 'inProgress',
        error: null,
      };
    });

    const first = f.adapter.dispatchTurn(role.assignmentId, 'First task.');
    await startEntered;
    const second = f.adapter.dispatchTurn(role.assignmentId, 'Second task.');
    await Promise.resolve();

    expect(f.client.startTurn).toHaveBeenCalledOnce();
    releaseStart();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({
      ok: false,
      kind: 'conflict',
    });
    expect(f.client.startTurn).toHaveBeenCalledOnce();
    expect(f.bindings.getBinding(role.assignmentId)).toMatchObject({
      activeTurnId: '019c-turn-race001',
      initialTaskDispatchState: 'started',
      initialTaskTurnId: '019c-turn-race001',
    });
  });

  it('does not duplicate an initial task whose provider outcome is uncertain', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);
    await f.adapter.ensureConversation(role, 0);
    f.client.startTurn.mockRejectedValueOnce(
      new CodexAppServerError('request-timeout', 'turn result was lost'),
    );

    await expect(
      f.adapter.dispatchTurn(role.assignmentId, 'Initial task.'),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'uncertain-outcome',
    });
    expect(f.bindings.getBinding(role.assignmentId)).toMatchObject({
      initialTaskDispatchState: 'pending',
      state: 'idle',
    });

    await expect(
      f.adapter.dispatchTurn(role.assignmentId, 'Initial task.'),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'uncertain-outcome',
    });
    expect(f.client.startTurn).toHaveBeenCalledOnce();
  });

  it('reports provider-owned authentication without storing or inventing credentials', async () => {
    const f = await fixture();
    f.client.state = {
      ...readyState,
      phase: 'unauthenticated',
      account: {
        requiresOpenaiAuth: true,
        authenticated: false,
        accountKind: undefined,
        displayLabel: undefined,
      },
      diagnostic: 'Codex requires sign-in.',
    };

    const status = await f.adapter.connect();

    expect(status).toMatchObject({
      available: true,
      authenticated: false,
      diagnostic: 'Codex requires sign-in.',
    });
    expect(
      await f.adapter.ensureConversation(assignment(f.workspace), 0),
    ).toMatchObject({
      ok: false,
      kind: 'unauthenticated',
    });
  });

  it('cancels exact active turns before closing only the owned App Server transport', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);
    await f.adapter.ensureConversation(role, 0);
    await f.adapter.dispatchTurn(role.assignmentId, 'Begin.');

    await f.adapter.shutdown();

    expect(f.client.interruptTurn).toHaveBeenCalledWith(
      '019c-thread-000001',
      '019c-turn-000001',
    );
    expect(f.client.stop).toHaveBeenCalledOnce();
    expect(f.bindings.getBinding(role.assignmentId)).toMatchObject({
      threadId: '019c-thread-000001',
      state: 'idle',
    });
  });

  it('closes admission, drains an admitted dispatch, then interrupts and stops', async () => {
    const f = await fixture();
    const role = assignment(f.workspace);
    await f.adapter.ensureConversation(role, 0);
    let enteredStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    let releaseStart!: () => void;
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    f.client.startTurn.mockImplementationOnce(async () => {
      enteredStart();
      await startReleased;
      return {
        id: '019c-turn-shutdown1',
        status: 'inProgress',
        error: null,
      };
    });

    const dispatch = f.adapter.dispatchTurn(role.assignmentId, 'Begin.');
    await startEntered;
    const shutdown = f.adapter.shutdown();
    await Promise.resolve();

    expect(f.client.stop).not.toHaveBeenCalled();
    await expect(
      f.adapter.dispatchTurn(role.assignmentId, 'Too late.'),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'shutting-down',
    });
    releaseStart();
    await expect(dispatch).resolves.toMatchObject({ ok: true });
    await shutdown;

    expect(f.client.startTurn).toHaveBeenCalledOnce();
    expect(f.client.interruptTurn).toHaveBeenCalledExactlyOnceWith(
      '019c-thread-000001',
      '019c-turn-shutdown1',
    );
    expect(f.client.stop).toHaveBeenCalledOnce();
    expect(f.bindings.getBinding(role.assignmentId)).toMatchObject({
      initialTaskTurnId: '019c-turn-shutdown1',
      state: 'idle',
    });
  });
});
