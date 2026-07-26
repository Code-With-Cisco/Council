import { readFile as nodeReadFile } from 'node:fs/promises';
import * as path from 'node:path';
import { writeJsonAtomic } from '../../config/atomicJson.js';
import type {
  CouncilAccessMode,
  MissionInitialTaskDispatchState,
} from '../missionContracts.js';
import { isRecord } from './protocol.js';

export const CODEX_THREAD_BINDINGS_FILENAME = 'codex-thread-bindings.json';
export const CODEX_PROVIDER_ID = 'codex' as const;

export type CodexThreadBindingState =
  | 'idle'
  | 'active'
  | 'blocked'
  | 'failed';

export interface CodexThreadBindingRecord {
  readonly bindingId: string;
  readonly providerId: typeof CODEX_PROVIDER_ID;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly roleProfileId: string;
  readonly requestFingerprint: string;
  readonly accessMode: CouncilAccessMode;
  readonly threadId: string;
  readonly initialTaskDispatchState: MissionInitialTaskDispatchState;
  readonly initialTaskTurnId?: string | undefined;
  readonly activeTurnId?: string | undefined;
  readonly state: CodexThreadBindingState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PendingCodexThreadStart {
  readonly operationId: string;
  readonly providerId: typeof CODEX_PROVIDER_ID;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly roleProfileId: string;
  readonly requestFingerprint: string;
  readonly accessMode: CouncilAccessMode;
  readonly startedAt: string;
}

export interface CodexThreadBindingsFileV1 {
  readonly version: 1;
  readonly revision: number;
  readonly bindings: Readonly<Record<string, CodexThreadBindingRecord>>;
  readonly pendingStarts: Readonly<Record<string, PendingCodexThreadStart>>;
}

export type CodexThreadBindingStoreSource =
  | 'missing'
  | 'disk'
  | 'last-known-good'
  | 'safe-default';

export interface CodexThreadBindingStoreProblem {
  readonly code: 'invalid-json' | 'invalid-schema' | 'read-failed';
  readonly message: string;
}

export interface CodexThreadBindingStoreState {
  readonly data: CodexThreadBindingsFileV1;
  readonly source: CodexThreadBindingStoreSource;
  readonly writeBlocked: boolean;
  readonly problem: CodexThreadBindingStoreProblem | undefined;
}

export class CodexThreadBindingParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexThreadBindingParseError';
  }
}

export class CodexThreadBindingWriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexThreadBindingWriteBlockedError';
  }
}

export class CodexThreadBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexThreadBindingConflictError';
  }
}

export interface CodexThreadBindingStoreOptions {
  readonly readFile?: ((file: string, encoding: 'utf8') => Promise<string>) | undefined;
  readonly writeFile?: ((file: string, value: unknown) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{5,255}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,255}$/;
const RECORD_KEYS = new Set([
  'bindingId',
  'providerId',
  'workspaceId',
  'workspacePath',
  'missionId',
  'taskId',
  'assignmentId',
  'roleProfileId',
  'requestFingerprint',
  'accessMode',
  'threadId',
  'initialTaskDispatchState',
  'initialTaskTurnId',
  'activeTurnId',
  'state',
  'createdAt',
  'updatedAt',
]);
const PENDING_KEYS = new Set([
  'operationId',
  'providerId',
  'workspaceId',
  'workspacePath',
  'missionId',
  'taskId',
  'assignmentId',
  'roleProfileId',
  'requestFingerprint',
  'accessMode',
  'startedAt',
]);

function emptyFile(): CodexThreadBindingsFileV1 {
  return { version: 1, revision: 0, bindings: {}, pendingStarts: {} };
}

export function emptyCodexThreadBindingsFile(): CodexThreadBindingsFileV1 {
  return emptyFile();
}

function fail(message: string): never {
  throw new CodexThreadBindingParseError(message);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${context} contains unknown field "${key}".`);
  }
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  context: string,
  pattern: RegExp = ID_PATTERN,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string' ||
    candidate.length > 4_096 ||
    !pattern.test(candidate)
  ) {
    fail(`${context}.${field} is invalid.`);
  }
  return candidate;
}

function absolutePathField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > 32_768 ||
    !path.isAbsolute(candidate) ||
    candidate.includes('\0')
  ) {
    fail(`${context}.${field} must be an absolute path.`);
  }
  return path.normalize(candidate);
}

function timestampField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== 'string' ||
    !Number.isFinite(Date.parse(candidate)) ||
    new Date(candidate).toISOString() !== candidate
  ) {
    fail(`${context}.${field} must be a canonical ISO timestamp.`);
  }
  return candidate;
}

function accessModeField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): CouncilAccessMode {
  const candidate = value[field];
  if (candidate !== 'read-only' && candidate !== 'workspace-write') {
    fail(`${context}.${field} must be "read-only" or "workspace-write".`);
  }
  return candidate;
}

function parseBinding(
  value: unknown,
  assignmentKey: string,
): CodexThreadBindingRecord {
  const context = `bindings.${assignmentKey}`;
  if (!isRecord(value)) fail(`${context} must be an object.`);
  exactKeys(value, RECORD_KEYS, context);
  const assignmentId = stringField(value, 'assignmentId', context);
  if (assignmentId !== assignmentKey) {
    fail(`${context}.assignmentId must equal its record key.`);
  }
  if (value['providerId'] !== CODEX_PROVIDER_ID) {
    fail(`${context}.providerId must be "${CODEX_PROVIDER_ID}".`);
  }
  const state = value['state'];
  if (
    state !== 'idle' &&
    state !== 'active' &&
    state !== 'blocked' &&
    state !== 'failed'
  ) {
    fail(`${context}.state is invalid.`);
  }
  const activeTurnValue = value['activeTurnId'];
  const activeTurnId =
    activeTurnValue === undefined
      ? undefined
      : stringField(value, 'activeTurnId', context, THREAD_ID_PATTERN);
  const initialTaskDispatchState = value['initialTaskDispatchState'];
  if (
    initialTaskDispatchState !== 'not-started' &&
    initialTaskDispatchState !== 'pending' &&
    initialTaskDispatchState !== 'started'
  ) {
    fail(`${context}.initialTaskDispatchState is invalid.`);
  }
  const initialTaskTurnValue = value['initialTaskTurnId'];
  const initialTaskTurnId =
    initialTaskTurnValue === undefined
      ? undefined
      : stringField(value, 'initialTaskTurnId', context, THREAD_ID_PATTERN);
  if (
    (initialTaskDispatchState === 'started') !==
    (initialTaskTurnId !== undefined)
  ) {
    fail(
      `${context} must name initialTaskTurnId exactly when the initial task was started.`,
    );
  }
  if (state === 'active' && activeTurnId === undefined) {
    fail(`${context} must name activeTurnId while active.`);
  }
  if (state !== 'active' && activeTurnId !== undefined) {
    fail(`${context} cannot retain activeTurnId while ${state}.`);
  }
  if (state === 'active' && initialTaskDispatchState !== 'started') {
    fail(`${context} cannot be active before its initial task was started.`);
  }
  return {
    bindingId: stringField(value, 'bindingId', context),
    providerId: CODEX_PROVIDER_ID,
    workspaceId: stringField(value, 'workspaceId', context),
    workspacePath: absolutePathField(value, 'workspacePath', context),
    missionId: stringField(value, 'missionId', context),
    taskId: stringField(value, 'taskId', context),
    assignmentId,
    roleProfileId: stringField(value, 'roleProfileId', context),
    requestFingerprint: stringField(
      value,
      'requestFingerprint',
      context,
      FINGERPRINT_PATTERN,
    ),
    accessMode: accessModeField(value, 'accessMode', context),
    threadId: stringField(value, 'threadId', context, THREAD_ID_PATTERN),
    initialTaskDispatchState,
    ...(initialTaskTurnId === undefined ? {} : { initialTaskTurnId }),
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
    state,
    createdAt: timestampField(value, 'createdAt', context),
    updatedAt: timestampField(value, 'updatedAt', context),
  };
}

function parsePending(
  value: unknown,
  assignmentKey: string,
): PendingCodexThreadStart {
  const context = `pendingStarts.${assignmentKey}`;
  if (!isRecord(value)) fail(`${context} must be an object.`);
  exactKeys(value, PENDING_KEYS, context);
  const assignmentId = stringField(value, 'assignmentId', context);
  if (assignmentId !== assignmentKey) {
    fail(`${context}.assignmentId must equal its record key.`);
  }
  if (value['providerId'] !== CODEX_PROVIDER_ID) {
    fail(`${context}.providerId must be "${CODEX_PROVIDER_ID}".`);
  }
  return {
    operationId: stringField(value, 'operationId', context),
    providerId: CODEX_PROVIDER_ID,
    workspaceId: stringField(value, 'workspaceId', context),
    workspacePath: absolutePathField(value, 'workspacePath', context),
    missionId: stringField(value, 'missionId', context),
    taskId: stringField(value, 'taskId', context),
    assignmentId,
    roleProfileId: stringField(value, 'roleProfileId', context),
    requestFingerprint: stringField(
      value,
      'requestFingerprint',
      context,
      FINGERPRINT_PATTERN,
    ),
    accessMode: accessModeField(value, 'accessMode', context),
    startedAt: timestampField(value, 'startedAt', context),
  };
}

export function parseCodexThreadBindingsFile(
  value: unknown,
): CodexThreadBindingsFileV1 {
  if (!isRecord(value)) fail('Codex thread bindings must be an object.');
  exactKeys(
    value,
    new Set(['version', 'revision', 'bindings', 'pendingStarts']),
    'root',
  );
  if (value['version'] !== 1) fail('Codex thread bindings version must be 1.');
  const revision = value['revision'];
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    fail('Codex thread bindings revision must be a non-negative integer.');
  }
  if (!isRecord(value['bindings'])) fail('bindings must be an object.');
  if (!isRecord(value['pendingStarts'])) fail('pendingStarts must be an object.');
  const bindings: Record<string, CodexThreadBindingRecord> = {};
  const pendingStarts: Record<string, PendingCodexThreadStart> = {};
  const threadIds = new Set<string>();
  const bindingIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const [key, raw] of Object.entries(value['bindings'])) {
    const binding = parseBinding(raw, key);
    if (threadIds.has(binding.threadId)) {
      fail(`Codex thread "${binding.threadId}" belongs to multiple assignments.`);
    }
    if (bindingIds.has(binding.bindingId)) {
      fail(`Codex binding ID "${binding.bindingId}" is duplicated.`);
    }
    threadIds.add(binding.threadId);
    bindingIds.add(binding.bindingId);
    bindings[key] = binding;
  }
  for (const [key, raw] of Object.entries(value['pendingStarts'])) {
    if (bindings[key] !== undefined) {
      fail(`Assignment "${key}" cannot be both bound and pending.`);
    }
    const pending = parsePending(raw, key);
    if (operationIds.has(pending.operationId)) {
      fail(`Codex pending operation "${pending.operationId}" is duplicated.`);
    }
    operationIds.add(pending.operationId);
    pendingStarts[key] = pending;
  }
  return {
    version: 1,
    revision: revision as number,
    bindings,
    pendingStarts,
  };
}

function samePending(
  left: PendingCodexThreadStart,
  right: PendingCodexThreadStart,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.workspaceId === right.workspaceId &&
    left.workspacePath === right.workspacePath &&
    left.missionId === right.missionId &&
    left.taskId === right.taskId &&
    left.assignmentId === right.assignmentId &&
    left.roleProfileId === right.roleProfileId &&
    left.requestFingerprint === right.requestFingerprint &&
    left.accessMode === right.accessMode
  );
}

export class CodexThreadBindingStore {
  readonly file: string;
  private stateValue: CodexThreadBindingStoreState = {
    data: emptyFile(),
    source: 'missing',
    writeBlocked: false,
    problem: undefined,
  };
  private lastKnownGood: CodexThreadBindingsFileV1 | undefined;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    userDataDirectory: string,
    private readonly options: CodexThreadBindingStoreOptions = {},
  ) {
    this.file = path.join(userDataDirectory, CODEX_THREAD_BINDINGS_FILENAME);
  }

  get state(): CodexThreadBindingStoreState {
    return this.stateValue;
  }

  getBinding(assignmentId: string): CodexThreadBindingRecord | undefined {
    return this.stateValue.data.bindings[assignmentId];
  }

  async load(): Promise<CodexThreadBindingStoreState> {
    return this.reload();
  }

  async reload(): Promise<CodexThreadBindingStoreState> {
    const read = this.options.readFile ?? nodeReadFile;
    let raw: string;
    try {
      raw = await read(this.file, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        if (this.lastKnownGood !== undefined) {
          return this.loadFailure(
            'read-failed',
            'Codex thread bindings disappeared after a valid document was loaded.',
          );
        }
        const data = this.lastKnownGood ?? emptyFile();
        this.stateValue = {
          data,
          source: this.lastKnownGood === undefined ? 'missing' : 'last-known-good',
          writeBlocked: false,
          problem: undefined,
        };
        return this.stateValue;
      }
      return this.loadFailure(
        'read-failed',
        `Could not read Codex thread bindings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      const data = parseCodexThreadBindingsFile(JSON.parse(raw) as unknown);
      this.lastKnownGood = data;
      this.stateValue = {
        data,
        source: 'disk',
        writeBlocked: false,
        problem: undefined,
      };
      return this.stateValue;
    } catch (error) {
      const code =
        error instanceof SyntaxError ? 'invalid-json' : 'invalid-schema';
      return this.loadFailure(
        code,
        `Codex thread bindings are not authoritative: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  beginStart(
    expectedRevision: number,
    pending: PendingCodexThreadStart,
  ): Promise<PendingCodexThreadStart> {
    return this.mutate(expectedRevision, (current) => {
      const existingBinding = current.bindings[pending.assignmentId];
      if (existingBinding !== undefined) {
        throw new CodexThreadBindingConflictError(
          `Assignment "${pending.assignmentId}" already owns Codex thread "${existingBinding.threadId}".`,
        );
      }
      const existing = current.pendingStarts[pending.assignmentId];
      if (existing !== undefined) {
        if (samePending(existing, pending)) return { data: current, value: existing };
        throw new CodexThreadBindingConflictError(
          `Assignment "${pending.assignmentId}" already has a different pending Codex start.`,
        );
      }
      return {
        data: {
          ...current,
          pendingStarts: {
            ...current.pendingStarts,
            [pending.assignmentId]: pending,
          },
        },
        value: pending,
      };
    });
  }

  commitStart(
    expectedRevision: number,
    operationId: string,
    binding: CodexThreadBindingRecord,
  ): Promise<CodexThreadBindingRecord> {
    return this.mutate(expectedRevision, (current) => {
      const pending = current.pendingStarts[binding.assignmentId];
      if (pending === undefined || pending.operationId !== operationId) {
        throw new CodexThreadBindingConflictError(
          'The exact pending Codex start no longer exists.',
        );
      }
      if (
        pending.workspaceId !== binding.workspaceId ||
        pending.workspacePath !== binding.workspacePath ||
        pending.missionId !== binding.missionId ||
        pending.taskId !== binding.taskId ||
        pending.roleProfileId !== binding.roleProfileId ||
        pending.requestFingerprint !== binding.requestFingerprint ||
        pending.accessMode !== binding.accessMode
      ) {
        throw new CodexThreadBindingConflictError(
          'The Codex acknowledgement does not match the pending assignment.',
        );
      }
      if (
        Object.values(current.bindings).some(
          (candidate) =>
            candidate.threadId === binding.threadId ||
            candidate.bindingId === binding.bindingId,
        )
      ) {
        throw new CodexThreadBindingConflictError(
          'That Codex thread or binding ID already has an owner.',
        );
      }
      const pendingStarts = { ...current.pendingStarts };
      delete pendingStarts[binding.assignmentId];
      return {
        data: {
          ...current,
          bindings: {
            ...current.bindings,
            [binding.assignmentId]: binding,
          },
          pendingStarts,
        },
        value: binding,
      };
    });
  }

  updateTurn(
    expectedRevision: number,
    assignmentId: string,
    turnId: string | undefined,
    state: CodexThreadBindingState,
  ): Promise<CodexThreadBindingRecord> {
    return this.mutate(expectedRevision, (current) => {
      const binding = current.bindings[assignmentId];
      if (binding === undefined) {
        throw new CodexThreadBindingConflictError(
          `Assignment "${assignmentId}" has no exact Codex binding.`,
        );
      }
      if ((state === 'active') !== (turnId !== undefined)) {
        throw new CodexThreadBindingConflictError(
          'Only an active Codex binding may name an active turn.',
        );
      }
      if (
        state === 'active' &&
        binding.initialTaskDispatchState === 'not-started'
      ) {
        throw new CodexThreadBindingConflictError(
          'The initial Codex task dispatch must be journaled before starting a turn.',
        );
      }
      const startingInitialTask =
        state === 'active' &&
        binding.initialTaskDispatchState === 'pending';
      const updated: CodexThreadBindingRecord = {
        ...binding,
        ...(turnId === undefined ? { activeTurnId: undefined } : { activeTurnId: turnId }),
        ...(startingInitialTask
          ? {
              initialTaskDispatchState: 'started' as const,
              initialTaskTurnId: turnId,
            }
          : {}),
        state,
        updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      return {
        data: {
          ...current,
          bindings: { ...current.bindings, [assignmentId]: updated },
        },
        value: updated,
      };
    });
  }

  beginInitialTaskDispatch(
    expectedRevision: number,
    assignmentId: string,
  ): Promise<CodexThreadBindingRecord> {
    return this.mutate(expectedRevision, (current) => {
      const binding = current.bindings[assignmentId];
      if (binding === undefined) {
        throw new CodexThreadBindingConflictError(
          `Assignment "${assignmentId}" has no exact Codex binding.`,
        );
      }
      if (
        binding.state !== 'idle' ||
        binding.initialTaskDispatchState !== 'not-started'
      ) {
        throw new CodexThreadBindingConflictError(
          'The initial Codex task can only be journaled once from an idle, not-started binding.',
        );
      }
      const updated: CodexThreadBindingRecord = {
        ...binding,
        initialTaskDispatchState: 'pending',
        updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      return {
        data: {
          ...current,
          bindings: { ...current.bindings, [assignmentId]: updated },
        },
        value: updated,
      };
    });
  }

  clearPending(
    expectedRevision: number,
    assignmentId: string,
    operationId: string,
  ): Promise<void> {
    return this.mutate(expectedRevision, (current) => {
      const pending = current.pendingStarts[assignmentId];
      if (pending === undefined) return { data: current, value: undefined };
      if (pending.operationId !== operationId) {
        throw new CodexThreadBindingConflictError(
          'A different Codex start is pending for that assignment.',
        );
      }
      const pendingStarts = { ...current.pendingStarts };
      delete pendingStarts[assignmentId];
      return {
        data: { ...current, pendingStarts },
        value: undefined,
      };
    });
  }

  private loadFailure(
    code: CodexThreadBindingStoreProblem['code'],
    message: string,
  ): CodexThreadBindingStoreState {
    this.stateValue = {
      data: this.lastKnownGood ?? emptyFile(),
      source:
        this.lastKnownGood === undefined ? 'safe-default' : 'last-known-good',
      writeBlocked: true,
      problem: { code, message },
    };
    return this.stateValue;
  }

  private mutate<T>(
    expectedRevision: number,
    operation: (
      current: CodexThreadBindingsFileV1,
    ) => { readonly data: CodexThreadBindingsFileV1; readonly value: T },
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutations = this.mutations
      .then(async () => {
        await this.reload();
        if (this.stateValue.writeBlocked) {
          throw new CodexThreadBindingWriteBlockedError(
            this.stateValue.problem?.message ??
              'Codex thread binding writes are blocked.',
          );
        }
        const current = this.stateValue.data;
        if (current.revision !== expectedRevision) {
          throw new CodexThreadBindingConflictError(
            `Stale Codex thread binding revision ${expectedRevision}; current revision is ${current.revision}.`,
          );
        }
        const mutation = operation(current);
        if (mutation.data === current) {
          resolveResult(mutation.value);
          return;
        }
        const next = parseCodexThreadBindingsFile({
          ...mutation.data,
          revision: current.revision + 1,
        });
        const write =
          this.options.writeFile ??
          ((file: string, value: unknown) => writeJsonAtomic(file, value));
        await write(this.file, next);
        this.lastKnownGood = next;
        this.stateValue = {
          data: next,
          source: 'disk',
          writeBlocked: false,
          problem: undefined,
        };
        resolveResult(mutation.value);
      })
      .catch((error) => rejectResult(error));
    void result.catch(() => undefined);
    return result;
  }
}
