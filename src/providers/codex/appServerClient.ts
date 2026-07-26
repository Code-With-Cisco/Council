import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  isRecord,
  optionalString,
  parseThread,
  parseTurn,
  requiredString,
  type CodexAccountKind,
  type CodexAccountState,
  type CodexAppServerEvent,
  type CodexApprovalAttention,
  type CodexApprovalDecision,
  type CodexConnectionState,
  type CodexInitializeResult,
  type CodexThread,
  type CodexThreadStartRequest,
  type CodexThreadStartResult,
  type CodexTurn,
  type CodexTurnStartRequest,
} from './protocol.js';

type WireRequestId = string | number;

export interface CodexAppServerConnection {
  write(line: string): Promise<void>;
  close(): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type CodexAppServerConnectionFactory = (
  executable: string,
) => CodexAppServerConnection;

class NodeCodexAppServerConnection implements CodexAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private closed = false;

  constructor(executable: string) {
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  write(line: string): Promise<void> {
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Codex App Server stdin is closed.'));
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, 'utf8', (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.child.stdout.on('data', (chunk: Buffer) => listener(chunk));
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.child.stderr.on('data', (chunk: Buffer) => listener(chunk));
  }

  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.child.on('exit', listener);
  }

  onError(listener: (error: Error) => void): void {
    this.child.on('error', listener);
  }
}

export function createCodexAppServerConnection(
  executable: string,
): CodexAppServerConnection {
  return new NodeCodexAppServerConnection(executable);
}

export type CodexAppServerErrorCode =
  | 'not-connected'
  | 'unauthenticated'
  | 'request-timeout'
  | 'protocol-error'
  | 'provider-error'
  | 'process-exit'
  | 'stopped';

export class CodexAppServerError extends Error {
  constructor(
    readonly code: CodexAppServerErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface PendingApproval {
  readonly approvalId: string;
  readonly wireId: WireRequestId;
  readonly kind: 'command' | 'file-change';
  readonly timer: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
  readonly executable: string;
  readonly clientVersion: string;
  readonly connectionFactory?: CodexAppServerConnectionFactory | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly approvalTimeoutMs?: number | undefined;
  readonly maxLineBytes?: number | undefined;
  readonly maxOutputDeltaChars?: number | undefined;
  readonly maxStderrChars?: number | undefined;
  readonly maxPendingRequests?: number | undefined;
  readonly maxPendingApprovals?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly approvalId?: (() => string) | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_DELTA_CHARS = 64 * 1024;
const DEFAULT_MAX_STDERR_CHARS = 16 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_MAX_PENDING_APPROVALS = 64;
const MAX_SETTLED_IDS = 128;

function positiveSafeInteger(
  value: number | undefined,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function requestKey(id: WireRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, maximum);
}

function parseInitializeResult(value: unknown): CodexInitializeResult {
  if (!isRecord(value)) throw new Error('initialize result must be an object.');
  return {
    userAgent: requiredString(value, 'userAgent', 'initialize result'),
    codexHome: requiredString(value, 'codexHome', 'initialize result'),
    platformFamily: requiredString(value, 'platformFamily', 'initialize result'),
    platformOs: requiredString(value, 'platformOs', 'initialize result'),
  };
}

function parseAccountState(value: unknown): CodexAccountState {
  if (!isRecord(value)) throw new Error('account/read result must be an object.');
  if (typeof value['requiresOpenaiAuth'] !== 'boolean') {
    throw new Error('account/read result.requiresOpenaiAuth must be a boolean.');
  }
  const account = value['account'];
  if (account === null) {
    return {
      requiresOpenaiAuth: value['requiresOpenaiAuth'],
      authenticated: false,
      accountKind: undefined,
      displayLabel: undefined,
    };
  }
  if (!isRecord(account)) {
    throw new Error('account/read result.account must be an object or null.');
  }
  const kind = requiredString(account, 'type', 'account/read result.account');
  if (kind !== 'apiKey' && kind !== 'chatgpt' && kind !== 'amazonBedrock') {
    throw new Error(`account/read returned unsupported account type "${kind}".`);
  }
  const accountKind: CodexAccountKind = kind;
  const email = optionalString(account, 'email');
  return {
    requiresOpenaiAuth: value['requiresOpenaiAuth'],
    authenticated: true,
    accountKind,
    displayLabel: email ?? accountKind,
  };
}

function parseThreadStartResult(value: unknown): CodexThreadStartResult {
  if (!isRecord(value)) throw new Error('thread/start result must be an object.');
  return {
    thread: parseThread(value['thread'], 'thread/start result.thread'),
    model: requiredString(value, 'model', 'thread/start result'),
    modelProvider: requiredString(
      value,
      'modelProvider',
      'thread/start result',
    ),
    cwd: requiredString(value, 'cwd', 'thread/start result'),
  };
}

function parseThreadResult(value: unknown, context: string): CodexThread {
  if (!isRecord(value)) throw new Error(`${context} result must be an object.`);
  return parseThread(value['thread'], `${context} result.thread`);
}

function parseTurnResult(value: unknown, context: string): CodexTurn {
  if (!isRecord(value)) throw new Error(`${context} result must be an object.`);
  return parseTurn(value['turn'], `${context} result.turn`);
}

function parseTurnIdResult(value: unknown, context: string): string {
  if (!isRecord(value)) throw new Error(`${context} result must be an object.`);
  return requiredString(value, 'turnId', `${context} result`);
}

function turnSandboxPolicy(
  mode: NonNullable<CodexTurnStartRequest['sandboxMode']>,
  cwd: string | undefined,
): Record<string, unknown> {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') {
    return { type: 'readOnly', networkAccess: false };
  }
  return {
    type: 'workspaceWrite',
    writableRoots: cwd === undefined ? [] : [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export class CodexAppServerClient {
  private readonly listeners = new Set<(event: CodexAppServerEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly settledIds = new Set<string>();
  private connection: CodexAppServerConnection | undefined;
  private incoming = Buffer.alloc(0);
  private connectPromise: Promise<CodexConnectionState> | undefined;
  private requestSequence = 0;
  private stopping = false;
  private initialized = false;
  private stderr = '';
  private initializeResult: CodexInitializeResult | undefined;
  private accountState: CodexAccountState | undefined;
  private stateValue: CodexConnectionState = {
    phase: 'stopped',
    initialized: false,
    userAgent: undefined,
    platformFamily: undefined,
    platformOs: undefined,
    account: undefined,
    diagnostic: undefined,
  };

  constructor(private readonly options: CodexAppServerClientOptions) {
    positiveSafeInteger(options.requestTimeoutMs, 'requestTimeoutMs');
    positiveSafeInteger(options.approvalTimeoutMs, 'approvalTimeoutMs');
    positiveSafeInteger(options.maxLineBytes, 'maxLineBytes');
    positiveSafeInteger(
      options.maxOutputDeltaChars,
      'maxOutputDeltaChars',
    );
    positiveSafeInteger(options.maxStderrChars, 'maxStderrChars');
    positiveSafeInteger(options.maxPendingRequests, 'maxPendingRequests');
    positiveSafeInteger(options.maxPendingApprovals, 'maxPendingApprovals');
  }

  get state(): CodexConnectionState {
    return this.stateValue;
  }

  get recentStderr(): string {
    return this.stderr;
  }

  onEvent(listener: (event: CodexAppServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): Promise<CodexConnectionState> {
    if (this.stateValue.phase === 'ready') {
      return Promise.resolve(this.stateValue);
    }
    if (
      this.stateValue.phase === 'unauthenticated' &&
      this.initialized &&
      this.connection !== undefined
    ) {
      return this.refreshAccount().then(() => this.stateValue);
    }
    if (this.connectPromise !== undefined) return this.connectPromise;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  async refreshAccount(): Promise<CodexAccountState> {
    this.requireInitialized();
    const account = parseAccountState(
      await this.request('account/read', { refreshToken: false }),
    );
    this.accountState = account;
    this.publishConnection(
      account.authenticated ? 'ready' : 'unauthenticated',
      account.authenticated
        ? undefined
        : 'Codex requires provider-owned OpenAI authentication.',
    );
    return account;
  }

  async startThread(
    request: CodexThreadStartRequest,
  ): Promise<CodexThreadStartResult> {
    this.requireAuthenticated();
    return parseThreadStartResult(
      await this.request('thread/start', {
        cwd: request.cwd,
        approvalPolicy: request.approvalPolicy,
        sandbox: request.sandbox,
        developerInstructions: request.developerInstructions,
        ephemeral: false,
        ...(request.model === undefined ? {} : { model: request.model }),
      }),
    );
  }

  async resumeThread(threadId: string, cwd: string): Promise<CodexThread> {
    this.requireAuthenticated();
    return parseThreadResult(
      await this.request('thread/resume', { threadId, cwd }),
      'thread/resume',
    );
  }

  async startTurn(request: CodexTurnStartRequest): Promise<CodexTurn> {
    this.requireAuthenticated();
    return parseTurnResult(
      await this.request('turn/start', {
        threadId: request.threadId,
        input: [{ type: 'text', text: request.text, text_elements: [] }],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: request.approvalPolicy }),
        ...(request.sandboxMode === undefined
          ? {}
          : {
              sandboxPolicy: turnSandboxPolicy(
                request.sandboxMode,
                request.cwd,
              ),
            }),
        ...(request.model === undefined ? {} : { model: request.model }),
      }),
      'turn/start',
    );
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<string> {
    this.requireAuthenticated();
    return parseTurnIdResult(
      await this.request('turn/steer', {
        threadId,
        expectedTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
      }),
      'turn/steer',
    );
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.requireInitialized();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async resolveApproval(
    approvalId: string,
    decision: CodexApprovalDecision,
  ): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined) {
      throw new CodexAppServerError(
        'protocol-error',
        'That Codex approval is no longer pending.',
      );
    }
    this.approvals.delete(approvalId);
    clearTimeout(approval.timer);
    await this.writeMessage({
      id: approval.wireId,
      result: { decision },
    });
    this.emit({ type: 'approval-resolved', approvalId, decision });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const approvals = [...this.approvals.values()];
    this.approvals.clear();
    for (const approval of approvals) {
      clearTimeout(approval.timer);
      try {
        await this.writeMessage({
          id: approval.wireId,
          result: { decision: 'cancel' },
        });
      } catch {
        // The owned process may already be gone. The request remains denied.
      }
      this.emit({
        type: 'approval-resolved',
        approvalId: approval.approvalId,
        decision: 'cancel',
      });
    }
    this.rejectPending(
      new CodexAppServerError('stopped', 'Codex App Server was stopped.'),
    );
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) await connection.close();
    this.initialized = false;
    this.initializeResult = undefined;
    this.accountState = undefined;
    this.incoming = Buffer.alloc(0);
    this.stopping = false;
    this.publishConnection('stopped');
  }

  private async connectInternal(): Promise<CodexConnectionState> {
    if (this.connection !== undefined) {
      await this.stop();
    }
    this.stopping = false;
    this.stderr = '';
    this.incoming = Buffer.alloc(0);
    this.publishConnection('connecting');
    try {
      const factory =
        this.options.connectionFactory ?? createCodexAppServerConnection;
      const connection = factory(this.options.executable);
      this.connection = connection;
      connection.onData((chunk) => this.receive(chunk));
      connection.onStderr((chunk) => this.receiveStderr(chunk));
      connection.onExit((code, signal) => this.processExited(code, signal));
      connection.onError((error) => this.transportFailed(error));

      const initialized = parseInitializeResult(
        await this.requestRaw(
          'initialize',
          {
            clientInfo: {
              name: 'decagram_council',
              title: 'Decagram Council',
              version: this.options.clientVersion,
            },
            capabilities: {
              experimentalApi: false,
              requestAttestation: false,
            },
          },
          true,
        ),
      );
      this.initializeResult = initialized;
      this.initialized = true;
      await this.writeMessage({ method: 'initialized' });
      const account = await this.refreshAccount();
      if (!account.authenticated) return this.stateValue;
      this.publishConnection('ready');
      return this.stateValue;
    } catch (error) {
      const failure =
        error instanceof CodexAppServerError
          ? error
          : new CodexAppServerError(
              'protocol-error',
              safeErrorMessage(error),
              error,
            );
      await this.failConnection(failure);
      throw failure;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.requireInitialized();
    return this.requestRaw(method, params, false);
  }

  private requestRaw(
    method: string,
    params: unknown,
    allowBeforeInitialize: boolean,
  ): Promise<unknown> {
    if (this.connection === undefined) {
      return Promise.reject(
        new CodexAppServerError(
          'not-connected',
          'Codex App Server is not connected.',
        ),
      );
    }
    if (!allowBeforeInitialize && !this.initialized) {
      return Promise.reject(
        new CodexAppServerError(
          'not-connected',
          'Codex App Server has not completed initialization.',
        ),
      );
    }
    const maximumPending =
      this.options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    if (this.pending.size >= maximumPending) {
      return Promise.reject(
        new CodexAppServerError(
          'provider-error',
          `Codex App Server has reached its ${maximumPending}-request safety bound.`,
        ),
      );
    }
    const id = ++this.requestSequence;
    const key = requestKey(id);
    const timeoutMs =
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.rememberSettled(key);
        reject(
          new CodexAppServerError(
            'request-timeout',
            `Codex App Server request "${method}" timed out.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(key, { method, resolve, reject, timer });
      void this.writeMessage({ id, method, params }).catch((error) => {
        const pending = this.pending.get(key);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(key);
        this.rememberSettled(key);
        pending.reject(
          new CodexAppServerError(
            'provider-error',
            `Could not write Codex App Server request "${method}": ${safeErrorMessage(error)}`,
            error,
          ),
        );
      });
    });
  }

  private receive(chunk: Uint8Array): void {
    if (this.connection === undefined) return;
    this.incoming = Buffer.concat([this.incoming, Buffer.from(chunk)]);
    const maximum = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    for (;;) {
      const newline = this.incoming.indexOf(0x0a);
      if (newline < 0) {
        if (this.incoming.length > maximum) {
          this.transportFailed(
            new CodexAppServerError(
              'protocol-error',
              `Codex App Server emitted a line larger than ${maximum} bytes.`,
            ),
          );
        }
        return;
      }
      if (newline > maximum) {
        this.transportFailed(
          new CodexAppServerError(
            'protocol-error',
            `Codex App Server emitted a line larger than ${maximum} bytes.`,
          ),
        );
        return;
      }
      let line = this.incoming.subarray(0, newline);
      this.incoming = this.incoming.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
        this.handleMessage(JSON.parse(decoded) as unknown);
      } catch (error) {
        this.transportFailed(
          error instanceof CodexAppServerError
            ? error
            : new CodexAppServerError(
                'protocol-error',
                `Malformed Codex App Server message: ${safeErrorMessage(error)}`,
              ),
        );
        return;
      }
    }
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value)) {
      throw new CodexAppServerError(
        'protocol-error',
        'Codex App Server message must be an object.',
      );
    }
    const method = value['method'];
    const hasId = typeof value['id'] === 'string' || typeof value['id'] === 'number';
    if (typeof method === 'string') {
      if (hasId) {
        this.handleServerRequest(
          value['id'] as WireRequestId,
          method,
          value['params'],
        );
      } else {
        this.handleNotification(method, value['params']);
      }
      return;
    }
    if (!hasId) {
      throw new CodexAppServerError(
        'protocol-error',
        'Codex App Server response has no request ID.',
      );
    }
    this.handleResponse(value['id'] as WireRequestId, value);
  }

  private handleResponse(
    id: WireRequestId,
    message: Record<string, unknown>,
  ): void {
    const key = requestKey(id);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      this.emit({
        type: 'protocol-warning',
        message: this.settledIds.has(key)
          ? 'Codex App Server sent a duplicate or late response.'
          : 'Codex App Server sent a response for an unknown request.',
      });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(key);
    this.rememberSettled(key);
    if ('error' in message && message['error'] !== undefined) {
      const error = message['error'];
      const providerMessage =
        isRecord(error) && typeof error['message'] === 'string'
          ? error['message']
          : `Codex App Server request "${pending.method}" failed.`;
      pending.reject(
        new CodexAppServerError('provider-error', providerMessage, error),
      );
      return;
    }
    if (!('result' in message)) {
      pending.reject(
        new CodexAppServerError(
          'protocol-error',
          `Codex App Server response for "${pending.method}" has no result.`,
        ),
      );
      return;
    }
    pending.resolve(message['result']);
  }

  private handleNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      this.emit({
        type: 'protocol-warning',
        message: `Ignored malformed "${method}" notification.`,
      });
      return;
    }
    const threadId = optionalString(params, 'threadId');
    if (method === 'thread/started') {
      const thread = parseThread(params['thread'], 'thread/started.thread');
      this.emit({
        type: 'thread-started',
        threadId: thread.id,
        payload: thread,
      });
      return;
    }
    if (method === 'thread/status/changed' && threadId !== undefined) {
      this.emit({ type: 'thread-status', threadId, payload: params['status'] });
      return;
    }
    if (
      (method === 'turn/started' || method === 'turn/completed') &&
      threadId !== undefined
    ) {
      const turn = parseTurn(params['turn'], `${method}.turn`);
      this.emit({
        type: method === 'turn/started' ? 'turn-started' : 'turn-completed',
        threadId,
        turnId: turn.id,
        payload: turn,
      });
      return;
    }
    const outputStream =
      method === 'item/agentMessage/delta'
        ? 'assistant'
        : method === 'item/commandExecution/outputDelta'
          ? 'command'
          : method === 'item/fileChange/outputDelta'
            ? 'file-change'
            : undefined;
    if (outputStream !== undefined && threadId !== undefined) {
      const turnId = optionalString(params, 'turnId');
      const itemId = optionalString(params, 'itemId');
      if (turnId === undefined || itemId === undefined) return;
      const raw = typeof params['delta'] === 'string' ? params['delta'] : '';
      const maximum =
        this.options.maxOutputDeltaChars ?? DEFAULT_MAX_OUTPUT_DELTA_CHARS;
      this.emit({
        type: 'output',
        threadId,
        turnId,
        itemId,
        stream: outputStream,
        delta: raw.slice(0, maximum),
        truncated: raw.length > maximum,
      });
      return;
    }
    if (method === 'error' && threadId !== undefined) {
      this.emit({
        type: 'provider-error',
        message: `Codex turn ${optionalString(params, 'turnId') ?? '(unknown)'} reported an error.`,
        payload: params['error'],
      });
      return;
    }
    if (method === 'account/updated') {
      void this.refreshAccount().catch((error) => {
        this.emit({
          type: 'provider-error',
          message: `Could not refresh Codex authentication state: ${safeErrorMessage(error)}`,
        });
      });
    }
  }

  private handleServerRequest(
    wireId: WireRequestId,
    method: string,
    rawParams: unknown,
  ): void {
    if (
      method !== 'item/commandExecution/requestApproval' &&
      method !== 'item/fileChange/requestApproval'
    ) {
      void this.writeMessage({
        id: wireId,
        error: {
          code: -32601,
          message: `Decagram Council does not support server request "${method}".`,
        },
      }).catch((error) => this.transportFailed(error));
      this.emit({
        type: 'protocol-warning',
        message: `Declined unsupported Codex server request "${method}".`,
      });
      return;
    }
    if (!isRecord(rawParams)) {
      void this.writeMessage({
        id: wireId,
        result: { decision: 'decline' },
      }).catch((error) => this.transportFailed(error));
      return;
    }
    if (
      [...this.approvals.values()].some(
        (approval) => requestKey(approval.wireId) === requestKey(wireId),
      )
    ) {
      void this.writeMessage({
        id: wireId,
        result: { decision: 'decline' },
      }).catch((error) => this.transportFailed(error));
      this.emit({
        type: 'protocol-warning',
        message: 'Declined a duplicate Codex approval request ID.',
      });
      return;
    }
    const maximumApprovals =
      this.options.maxPendingApprovals ?? DEFAULT_MAX_PENDING_APPROVALS;
    if (this.approvals.size >= maximumApprovals) {
      void this.writeMessage({
        id: wireId,
        result: { decision: 'decline' },
      }).catch((error) => this.transportFailed(error));
      this.emit({
        type: 'protocol-warning',
        message: `Declined Codex approval beyond the ${maximumApprovals}-request safety bound.`,
      });
      return;
    }
    let attention: CodexApprovalAttention;
    try {
      const approvalId = this.options.approvalId?.() ?? randomUUID();
      if (this.approvals.has(approvalId)) {
        throw new Error('Codex approval identity collision.');
      }
      const kind =
        method === 'item/commandExecution/requestApproval'
          ? 'command'
          : 'file-change';
      attention = {
        approvalId,
        kind,
        threadId: requiredString(rawParams, 'threadId', method),
        turnId: requiredString(rawParams, 'turnId', method),
        itemId: requiredString(rawParams, 'itemId', method),
        reason: boundedText(rawParams['reason'], 2_000),
        command:
          kind === 'command'
            ? boundedText(rawParams['command'], 8_000)
            : undefined,
        cwd:
          kind === 'command'
            ? boundedText(rawParams['cwd'], 4_096)
            : boundedText(rawParams['grantRoot'], 4_096),
        requestedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      const timer = setTimeout(() => {
        const pending = this.approvals.get(approvalId);
        if (pending === undefined) return;
        this.approvals.delete(approvalId);
        void this.writeMessage({
          id: pending.wireId,
          result: { decision: 'decline' },
        }).catch((error) => this.transportFailed(error));
        this.emit({
          type: 'approval-resolved',
          approvalId,
          decision: 'expired',
        });
      }, this.options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.approvals.set(approvalId, { approvalId, wireId, kind, timer });
    } catch {
      void this.writeMessage({
        id: wireId,
        result: { decision: 'decline' },
      }).catch((error) => this.transportFailed(error));
      return;
    }
    this.emit({ type: 'approval-requested', approval: attention });
  }

  private receiveStderr(chunk: Uint8Array): void {
    const maximum = this.options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS;
    this.stderr = `${this.stderr}${Buffer.from(chunk).toString('utf8')}`.slice(
      -maximum,
    );
  }

  private processExited(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.connection === undefined) return;
    const expected = this.stopping;
    this.connection = undefined;
    this.initialized = false;
    if (expected) return;
    const suffix = this.stderr.trim() === '' ? '' : ` ${this.stderr.trim()}`;
    const error = new CodexAppServerError(
      'process-exit',
      `Codex App Server exited (code ${String(code)}, signal ${String(signal)}).${suffix}`,
    );
    this.rejectPending(error);
    this.clearApprovals('cancel');
    this.publishConnection('failed', error.message);
  }

  private transportFailed(error: unknown): void {
    const failure =
      error instanceof CodexAppServerError
        ? error
        : new CodexAppServerError(
            'provider-error',
            safeErrorMessage(error),
            error,
          );
    void this.failConnection(failure);
  }

  private async failConnection(error: CodexAppServerError): Promise<void> {
    this.rejectPending(error);
    this.clearApprovals('cancel');
    const connection = this.connection;
    this.connection = undefined;
    this.initialized = false;
    if (connection !== undefined) {
      try {
        await connection.close();
      } catch {
        // Preserve the protocol/provider error that caused closure.
      }
    }
    this.publishConnection('failed', error.message);
  }

  private clearApprovals(decision: CodexApprovalDecision): void {
    const approvals = [...this.approvals.values()];
    this.approvals.clear();
    for (const approval of approvals) {
      clearTimeout(approval.timer);
      this.emit({
        type: 'approval-resolved',
        approvalId: approval.approvalId,
        decision,
      });
    }
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.entries()];
    this.pending.clear();
    for (const [key, request] of pending) {
      clearTimeout(request.timer);
      this.rememberSettled(key);
      request.reject(error);
    }
  }

  private rememberSettled(key: string): void {
    this.settledIds.add(key);
    while (this.settledIds.size > MAX_SETTLED_IDS) {
      const first = this.settledIds.values().next().value as string | undefined;
      if (first === undefined) break;
      this.settledIds.delete(first);
    }
  }

  private requireInitialized(): void {
    if (!this.initialized || this.connection === undefined) {
      throw new CodexAppServerError(
        'not-connected',
        'Codex App Server is not initialized.',
      );
    }
  }

  private requireAuthenticated(): void {
    this.requireInitialized();
    if (this.accountState?.authenticated !== true) {
      throw new CodexAppServerError(
        'unauthenticated',
        'Codex requires provider-owned OpenAI authentication.',
      );
    }
  }

  private writeMessage(message: unknown): Promise<void> {
    const connection = this.connection;
    if (connection === undefined) {
      return Promise.reject(
        new CodexAppServerError(
          'not-connected',
          'Codex App Server is not connected.',
        ),
      );
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      return Promise.reject(
        new CodexAppServerError(
          'protocol-error',
          `Codex request could not be serialized: ${safeErrorMessage(error)}`,
        ),
      );
    }
    return connection.write(`${serialized}\n`);
  }

  private publishConnection(
    phase: CodexConnectionState['phase'],
    diagnostic?: string,
  ): void {
    this.stateValue = {
      phase,
      initialized: this.initialized,
      userAgent: this.initializeResult?.userAgent,
      platformFamily: this.initializeResult?.platformFamily,
      platformOs: this.initializeResult?.platformOs,
      account: this.accountState,
      diagnostic,
    };
    this.emit({ type: 'connection', state: this.stateValue });
  }

  private emit(event: CodexAppServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Provider event consumers are isolated from transport correctness.
      }
    }
  }
}
