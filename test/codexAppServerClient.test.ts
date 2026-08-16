import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerClient,
  CodexAppServerError,
  type CodexAppServerConnection,
} from '../src/providers/codex/appServerClient.js';
import type { CodexAppServerEvent } from '../src/providers/codex/protocol.js';

type WireMessage = Record<string, unknown>;

class FakeConnection implements CodexAppServerConnection {
  readonly writes: WireMessage[] = [];
  closed = false;
  private dataListener: ((chunk: Uint8Array) => void) | undefined;
  private stderrListener: ((chunk: Uint8Array) => void) | undefined;
  private exitListener:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;
  private errorListener: ((error: Error) => void) | undefined;

  constructor(
    private readonly onWrite?: (
      message: WireMessage,
      connection: FakeConnection,
    ) => void,
  ) {}

  async write(line: string): Promise<void> {
    if (this.closed) throw new Error('closed');
    const message = JSON.parse(line) as WireMessage;
    this.writes.push(message);
    this.onWrite?.(message, this);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListener = listener;
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.stderrListener = listener;
  }

  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.exitListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  server(message: unknown): void {
    this.dataListener?.(Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'));
  }

  raw(bytes: string | Uint8Array): void {
    this.dataListener?.(
      typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes,
    );
  }

  stderr(text: string): void {
    this.stderrListener?.(Buffer.from(text, 'utf8'));
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitListener?.(code, signal);
  }

  error(error: Error): void {
    this.errorListener?.(error);
  }
}

const initializeResult = {
  userAgent: 'codex-cli/0.146.0',
  codexHome: 'C:\\Users\\User\\.codex',
  platformFamily: 'windows',
  platformOs: 'windows',
};

const authenticatedAccount = {
  account: {
    type: 'chatgpt',
    email: 'person@example.test',
    planType: 'plus',
  },
  requiresOpenaiAuth: true,
};

function respondingConnection(
  account: unknown = authenticatedAccount,
): FakeConnection {
  return new FakeConnection((message, connection) => {
    const method = message['method'];
    const id = message['id'];
    if (method === 'initialize') {
      queueMicrotask(() => connection.server({ id, result: initializeResult }));
    }
    if (method === 'account/read') {
      queueMicrotask(() => connection.server({ id, result: account }));
    }
  });
}

async function connectedFixture(
  options: {
    readonly connection?: FakeConnection;
    readonly requestTimeoutMs?: number;
    readonly approvalTimeoutMs?: number;
    readonly maxLineBytes?: number;
    readonly maxOutputDeltaChars?: number;
  } = {},
) {
  const connection = options.connection ?? respondingConnection();
  const client = new CodexAppServerClient({
    executable: '/Applications/Codex/codex',
    clientVersion: '0.1.0',
    connectionFactory: () => connection,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
    ...(options.maxLineBytes === undefined
      ? {}
      : { maxLineBytes: options.maxLineBytes }),
    ...(options.maxOutputDeltaChars === undefined
      ? {}
      : { maxOutputDeltaChars: options.maxOutputDeltaChars }),
    approvalId: () => 'approval-opaque-1',
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });
  const events: CodexAppServerEvent[] = [];
  client.onEvent((event) => events.push(event));
  await client.connect();
  return { client, connection, events };
}

describe('CodexAppServerClient', () => {
  it('rejects unsafe transport limits before opening a provider process', () => {
    const base = {
      executable: 'codex',
      clientVersion: '0.1.0',
    };
    for (const [name, value] of [
      ['requestTimeoutMs', 0],
      ['approvalTimeoutMs', -1],
      ['maxLineBytes', Number.NaN],
      ['maxOutputDeltaChars', Number.POSITIVE_INFINITY],
      ['maxStderrChars', 1.5],
      ['maxPendingRequests', Number.MAX_SAFE_INTEGER + 1],
      ['maxPendingApprovals', 0],
    ] as const) {
      expect(
        () =>
          new CodexAppServerClient({
            ...base,
            [name]: value,
          }),
      ).toThrow(`${name} must be a positive safe integer.`);
    }
  });

  it('starts one connection, initializes exactly once, and exposes only non-secret auth state', async () => {
    const connection = respondingConnection();
    const factory = vi.fn(() => connection);
    const client = new CodexAppServerClient({
      executable: 'C:\\Program Files\\Codex\\codex.exe',
      clientVersion: '0.1.0',
      connectionFactory: factory,
    });

    const [first, second] = await Promise.all([client.connect(), client.connect()]);

    expect(factory).toHaveBeenCalledExactlyOnceWith(
      'C:\\Program Files\\Codex\\codex.exe',
    );
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      phase: 'ready',
      initialized: true,
      userAgent: 'codex-cli/0.146.0',
      account: {
        authenticated: true,
        accountKind: 'chatgpt',
        displayLabel: 'person@example.test',
      },
    });
    expect(connection.writes.filter((entry) => entry['method'] === 'initialize')).toHaveLength(1);
    expect(connection.writes).toContainEqual({ method: 'initialized' });
    expect(JSON.stringify(first)).not.toContain('token');
  });

  it('reports missing provider auth truthfully and blocks thread creation', async () => {
    const connection = respondingConnection({
      account: null,
      requiresOpenaiAuth: true,
    });
    const { client } = await connectedFixture({ connection });

    expect(client.state).toMatchObject({
      phase: 'unauthenticated',
      account: { authenticated: false, requiresOpenaiAuth: true },
    });
    await expect(
      client.startThread({
        cwd: '/repo',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        developerInstructions: 'Builder role.',
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('uses stable exact-ID thread and turn methods with persistent threads', async () => {
    const connection = respondingConnection();
    const { client } = await connectedFixture({ connection });
    const baseThread = {
      id: '019c-thread',
      cwd: '/repo/worktree',
      status: { type: 'idle' },
    };
    const baseTurn = {
      id: '019c-turn',
      items: [],
      status: 'inProgress',
      error: null,
    };
    const provider = (message: WireMessage): void => {
      const id = message['id'];
      switch (message['method']) {
        case 'thread/start':
          connection.server({
            id,
            result: {
              thread: baseThread,
              model: 'gpt-5.6-codex',
              modelProvider: 'openai',
              cwd: '/repo/worktree',
            },
          });
          break;
        case 'thread/resume':
          connection.server({ id, result: { thread: baseThread } });
          break;
        case 'turn/start':
          connection.server({ id, result: { turn: baseTurn } });
          break;
        case 'turn/steer':
          connection.server({ id, result: { turnId: '019c-turn' } });
          break;
        case 'turn/interrupt':
          connection.server({ id, result: {} });
          break;
      }
    };
    const originalWrite = connection.write.bind(connection);
    connection.write = async (line) => {
      await originalWrite(line);
      const message = connection.writes.at(-1);
      if (message !== undefined) queueMicrotask(() => provider(message));
    };

    const started = await client.startThread({
      cwd: '/repo/worktree',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: 'Implement the assigned task.',
      model: 'gpt-5.6-codex',
    });
    const resumed = await client.resumeThread('019c-thread', '/repo/worktree');
    const turn = await client.startTurn({
      threadId: '019c-thread',
      text: 'Begin.',
      cwd: '/repo/worktree',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
    });
    await client.steerTurn('019c-thread', '019c-turn', 'Use the exact handoff.');
    await client.interruptTurn('019c-thread', '019c-turn');

    expect(started.thread.id).toBe('019c-thread');
    expect(resumed.id).toBe('019c-thread');
    expect(turn.id).toBe('019c-turn');
    expect(
      connection.writes.find((entry) => entry['method'] === 'thread/start'),
    ).toMatchObject({
      params: {
        cwd: '/repo/worktree',
        ephemeral: false,
        sandbox: 'workspace-write',
      },
    });
    expect(
      connection.writes.find((entry) => entry['method'] === 'thread/resume'),
    ).toMatchObject({
      params: { threadId: '019c-thread', cwd: '/repo/worktree' },
    });
    expect(
      connection.writes.find((entry) => entry['method'] === 'turn/steer'),
    ).toMatchObject({
      params: {
        threadId: '019c-thread',
        expectedTurnId: '019c-turn',
      },
    });
  });

  it('projects bounded output and routes only exact pending command/file approvals', async () => {
    const { client, connection, events } = await connectedFixture({
      maxOutputDeltaChars: 5,
    });

    connection.server({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: '123456789',
      },
    });
    connection.server({
      id: 'provider-request-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-2',
        command: 'npm test',
        cwd: '/repo',
        reason: 'Run tests',
      },
    });

    expect(events).toContainEqual({
      type: 'output',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      stream: 'assistant',
      delta: '12345',
      truncated: true,
    });
    expect(events).toContainEqual({
      type: 'approval-requested',
      approval: {
        approvalId: 'approval-opaque-1',
        kind: 'command',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-2',
        command: 'npm test',
        cwd: '/repo',
        reason: 'Run tests',
        requestedAt: '2026-07-26T12:00:00.000Z',
      },
    });

    await client.resolveApproval('approval-opaque-1', 'accept');
    expect(connection.writes.at(-1)).toEqual({
      id: 'provider-request-1',
      result: { decision: 'accept' },
    });
    await expect(
      client.resolveApproval('approval-opaque-1', 'accept'),
    ).rejects.toBeInstanceOf(CodexAppServerError);

    connection.server({
      id: 'provider-request-2',
      method: 'item/tool/requestUserInput',
      params: {},
    });
    await Promise.resolve();
    expect(connection.writes.at(-1)).toMatchObject({
      id: 'provider-request-2',
      error: { code: -32601 },
    });
  });

  it('expires unanswered approvals closed', async () => {
    vi.useFakeTimers();
    try {
      const connection = respondingConnection();
      const client = new CodexAppServerClient({
        executable: 'codex',
        clientVersion: '0.1.0',
        connectionFactory: () => connection,
        approvalTimeoutMs: 10,
        approvalId: () => 'approval-expiring',
      });
      const connect = client.connect();
      await vi.runAllTicks();
      await connect;
      connection.server({
        id: 91,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          reason: 'edit',
        },
      });

      await vi.advanceTimersByTimeAsync(11);

      expect(connection.writes.at(-1)).toEqual({
        id: 91,
        result: { decision: 'decline' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails pending work on process exit and retains bounded stderr diagnostics', async () => {
    const connection = respondingConnection();
    const { client } = await connectedFixture({ connection });
    const operation = client.startThread({
      cwd: '/repo',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      developerInstructions: 'Review.',
    });
    connection.stderr('provider exploded');
    connection.exit(7);

    await expect(operation).rejects.toMatchObject({ code: 'process-exit' });
    expect(client.state).toMatchObject({
      phase: 'failed',
      diagnostic: expect.stringContaining('provider exploded'),
    });
  });

  it('fails closed on malformed or oversized protocol lines', async () => {
    const malformedConnection = respondingConnection();
    const malformedClient = new CodexAppServerClient({
      executable: 'codex',
      clientVersion: '0.1.0',
      connectionFactory: () => malformedConnection,
    });
    const malformedConnect = malformedClient.connect();
    malformedConnection.raw('{not json}\n');
    await expect(malformedConnect).rejects.toMatchObject({
      code: 'protocol-error',
    });
    expect(malformedConnection.closed).toBe(true);

    const oversizedConnection = new FakeConnection();
    const oversizedClient = new CodexAppServerClient({
      executable: 'codex',
      clientVersion: '0.1.0',
      connectionFactory: () => oversizedConnection,
      maxLineBytes: 8,
    });
    const oversizedConnect = oversizedClient.connect();
    oversizedConnection.raw('123456789');
    await expect(oversizedConnect).rejects.toMatchObject({
      code: 'protocol-error',
    });

    const invalidUtf8Connection = new FakeConnection();
    const invalidUtf8Client = new CodexAppServerClient({
      executable: 'codex',
      clientVersion: '0.1.0',
      connectionFactory: () => invalidUtf8Connection,
    });
    const invalidUtf8Connect = invalidUtf8Client.connect();
    invalidUtf8Connection.raw(
      Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
    );
    await expect(invalidUtf8Connect).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });

  it('reports duplicate and late responses without settling another request', async () => {
    const connection = respondingConnection();
    const { client, events } = await connectedFixture({ connection });
    const refresh = client.refreshAccount();
    const request = connection.writes.at(-1);
    const id = request?.['id'];
    connection.server({ id, result: authenticatedAccount });
    await refresh;
    connection.server({ id, result: authenticatedAccount });

    expect(events).toContainEqual({
      type: 'protocol-warning',
      message: 'Codex App Server sent a duplicate or late response.',
    });
  });

  it('stops only the owned transport and never emits thread deletion requests', async () => {
    const { client, connection } = await connectedFixture();

    await client.stop();

    expect(connection.closed).toBe(true);
    expect(client.state.phase).toBe('stopped');
    expect(
      connection.writes.some(
        (entry) =>
          entry['method'] === 'thread/delete' ||
          entry['method'] === 'thread/archive',
      ),
    ).toBe(false);
  });
});
