import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  MAX_PROFILE_ID_LENGTH,
  isValidProfileId,
} from '../profileIdentity.js';

export const SESSION_BINDINGS_VERSION = 1 as const;
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code' as const;

export type SessionProviderId = typeof CLAUDE_CODE_PROVIDER_ID;

/**
 * Durable ownership record for one profile's Claude-owned conversation.
 *
 * The short/full provider IDs are the ownership mechanism. The launch name and
 * cwd are retained only as evidence for reconciling the launch transaction that
 * created this record; callers must never use the other descriptive fields to
 * adopt an unrelated session.
 */
export interface SessionBindingRecord {
  readonly providerId: SessionProviderId;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly shortSessionId: string;
  readonly fullSessionId?: string | undefined;
  readonly uniqueLaunchName: string;
  readonly agentName: string;
  readonly catalogId: string;
  readonly definitionFingerprint: string;
  readonly requestedCanonicalCwd: string;
  readonly actualCanonicalCwd?: string | undefined;
  readonly createdAt: string;
  readonly lastConfirmedAt: string;
}

/**
 * Durable evidence for a launch that may have outlived its CLI acknowledgement.
 *
 * This is written before spawn and cleared atomically when the exact binding is
 * committed. It intentionally contains no inferred provider session identity.
 */
export interface PendingLaunchRecord {
  readonly providerId: SessionProviderId;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly uniqueLaunchName: string;
  readonly agentName: string;
  readonly catalogId: string;
  readonly definitionFingerprint: string;
  readonly requestedCanonicalCwd: string;
  readonly createdAt: string;
  /**
   * A provider warning proved that this transaction launched the wrong agent.
   * Such a record is cleanup-only: it must never be reconciled into a binding.
   */
  readonly disposition?: 'rejected-substitution' | undefined;
}

export interface SessionBindingsFileV1 {
  readonly version: typeof SESSION_BINDINGS_VERSION;
  readonly bindings: Readonly<Record<string, SessionBindingRecord>>;
  readonly pendingLaunches: Readonly<Record<string, PendingLaunchRecord>>;
}

export type SessionBindingStoreProblemKind = 'read' | 'parse' | 'write';

export interface SessionBindingStoreProblem {
  readonly kind: SessionBindingStoreProblemKind;
  readonly file: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface SessionBindingStoreState {
  readonly file: string;
  readonly loaded: boolean;
  readonly fileExists: boolean;
  readonly data: SessionBindingsFileV1;
  /**
   * The current disk document could not be trusted. `data` remains the
   * last-known-good value and mutations refuse to overwrite the bad document.
   */
  readonly problem: SessionBindingStoreProblem | undefined;
}

export interface ProviderSessionIdentity {
  readonly id?: string | undefined;
  readonly sessionId?: string | undefined;
}

export type AtomicBindingWriter = (file: string, text: string) => Promise<void>;

export interface SessionBindingStoreOptions {
  readonly atomicWrite?: AtomicBindingWriter | undefined;
  readonly now?: (() => Date) | undefined;
}

const TOP_LEVEL_KEYS = new Set(['version', 'bindings', 'pendingLaunches']);
const BINDING_KEYS = new Set([
  'providerId',
  'workspaceId',
  'profileId',
  'shortSessionId',
  'fullSessionId',
  'uniqueLaunchName',
  'agentName',
  'catalogId',
  'definitionFingerprint',
  'requestedCanonicalCwd',
  'actualCanonicalCwd',
  'createdAt',
  'lastConfirmedAt',
]);
const PENDING_KEYS = new Set([
  'providerId',
  'workspaceId',
  'profileId',
  'uniqueLaunchName',
  'agentName',
  'catalogId',
  'definitionFingerprint',
  'requestedCanonicalCwd',
  'createdAt',
  'disposition',
]);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA_256 = /^[0-9a-f]{64}$/i;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function emptySessionBindingsFile(): SessionBindingsFileV1 {
  return {
    version: SESSION_BINDINGS_VERSION,
    bindings: emptyRecord<SessionBindingRecord>(),
    pendingLaunches: emptyRecord<PendingLaunchRecord>(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  return value;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  location: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${location} has unexpected field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}`);
  }
}

function requiredString(
  value: unknown,
  location: string,
  options: { maxLength?: number; opaque?: boolean; fingerprint?: boolean; timestamp?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${location} must be a non-empty string`);
  }
  if (CONTROL_BYTES.test(value)) throw new Error(`${location} contains a control character`);
  if (value.length > (options.maxLength ?? 8_192)) {
    throw new Error(`${location} is too long`);
  }
  if (options.opaque === true && !OPAQUE_ID.test(value)) {
    throw new Error(`${location} is not a valid opaque identifier`);
  }
  if (options.fingerprint === true && !SHA_256.test(value)) {
    throw new Error(`${location} must be a SHA-256 fingerprint`);
  }
  if (options.timestamp === true && !Number.isFinite(Date.parse(value))) {
    throw new Error(`${location} must be a valid timestamp`);
  }
  return value;
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  location: string,
  options: { maxLength?: number; opaque?: boolean } = {},
): string | undefined {
  if (!Object.hasOwn(record, key) || record[key] === undefined) return undefined;
  return requiredString(record[key], `${location}.${key}`, options);
}

function parseProviderId(value: unknown, location: string): SessionProviderId {
  if (value !== CLAUDE_CODE_PROVIDER_ID) {
    throw new Error(`${location} must be "${CLAUDE_CODE_PROVIDER_ID}"`);
  }
  return value;
}

function parseProfileId(value: unknown, location: string): string {
  const candidate = requiredString(value, location, {
    maxLength: MAX_PROFILE_ID_LENGTH,
  });
  if (!isValidProfileId(candidate)) {
    throw new Error(`${location} is not a valid routable profile identifier`);
  }
  return candidate;
}

function parseBinding(value: unknown, location: string): SessionBindingRecord {
  const record = assertRecord(value, location);
  assertOnlyKeys(record, BINDING_KEYS, location);

  const fullSessionId = optionalString(record, 'fullSessionId', location, {
    maxLength: 512,
    opaque: true,
  });
  const actualCanonicalCwd = optionalString(record, 'actualCanonicalCwd', location);

  return {
    providerId: parseProviderId(record['providerId'], `${location}.providerId`),
    workspaceId: requiredString(record['workspaceId'], `${location}.workspaceId`, {
      maxLength: 512,
      opaque: true,
    }),
    profileId: parseProfileId(record['profileId'], `${location}.profileId`),
    shortSessionId: requiredString(record['shortSessionId'], `${location}.shortSessionId`, {
      maxLength: 512,
      opaque: true,
    }),
    ...(fullSessionId === undefined ? {} : { fullSessionId }),
    uniqueLaunchName: requiredString(record['uniqueLaunchName'], `${location}.uniqueLaunchName`, {
      maxLength: 512,
      opaque: true,
    }),
    agentName: requiredString(record['agentName'], `${location}.agentName`, { maxLength: 512 }),
    catalogId: requiredString(record['catalogId'], `${location}.catalogId`, {
      maxLength: 512,
      opaque: true,
    }),
    definitionFingerprint: requiredString(
      record['definitionFingerprint'],
      `${location}.definitionFingerprint`,
      { fingerprint: true },
    ),
    requestedCanonicalCwd: requiredString(
      record['requestedCanonicalCwd'],
      `${location}.requestedCanonicalCwd`,
    ),
    ...(actualCanonicalCwd === undefined ? {} : { actualCanonicalCwd }),
    createdAt: requiredString(record['createdAt'], `${location}.createdAt`, {
      maxLength: 128,
      timestamp: true,
    }),
    lastConfirmedAt: requiredString(record['lastConfirmedAt'], `${location}.lastConfirmedAt`, {
      maxLength: 128,
      timestamp: true,
    }),
  };
}

function parsePendingLaunch(value: unknown, location: string): PendingLaunchRecord {
  const record = assertRecord(value, location);
  assertOnlyKeys(record, PENDING_KEYS, location);
  const disposition = record['disposition'];
  if (
    disposition !== undefined &&
    disposition !== 'rejected-substitution'
  ) {
    throw new Error(
      `${location}.disposition must be "rejected-substitution" when present`,
    );
  }

  return {
    providerId: parseProviderId(record['providerId'], `${location}.providerId`),
    workspaceId: requiredString(record['workspaceId'], `${location}.workspaceId`, {
      maxLength: 512,
      opaque: true,
    }),
    profileId: parseProfileId(record['profileId'], `${location}.profileId`),
    uniqueLaunchName: requiredString(record['uniqueLaunchName'], `${location}.uniqueLaunchName`, {
      maxLength: 512,
      opaque: true,
    }),
    agentName: requiredString(record['agentName'], `${location}.agentName`, { maxLength: 512 }),
    catalogId: requiredString(record['catalogId'], `${location}.catalogId`, {
      maxLength: 512,
      opaque: true,
    }),
    definitionFingerprint: requiredString(
      record['definitionFingerprint'],
      `${location}.definitionFingerprint`,
      { fingerprint: true },
    ),
    requestedCanonicalCwd: requiredString(
      record['requestedCanonicalCwd'],
      `${location}.requestedCanonicalCwd`,
    ),
    createdAt: requiredString(record['createdAt'], `${location}.createdAt`, {
      maxLength: 128,
      timestamp: true,
    }),
    ...(disposition === undefined ? {} : { disposition }),
  };
}

function registerUnique(
  owners: Map<string, string>,
  providerId: SessionProviderId,
  value: string,
  profileId: string,
  description: string,
): void {
  const key = `${providerId}\u0000${value}`;
  const owner = owners.get(key);
  if (owner !== undefined && owner !== profileId) {
    throw new Error(`${description} "${value}" belongs to both "${owner}" and "${profileId}"`);
  }
  owners.set(key, profileId);
}

function registerUniqueLaunchName(
  owners: Map<string, string>,
  providerId: SessionProviderId,
  value: string,
  ownerDescription: string,
): void {
  const key = `${providerId}\u0000${value}`;
  const owner = owners.get(key);
  if (owner !== undefined) {
    throw new Error(`Unique launch name "${value}" belongs to both ${owner} and ${ownerDescription}`);
  }
  owners.set(key, ownerDescription);
}

/**
 * Strictly parses the complete on-disk document. Partial recovery would make
 * ownership depend on file order, so one malformed record rejects the document
 * and lets the store retain its prior known-good state.
 */
export function parseSessionBindingsFile(value: unknown): SessionBindingsFileV1 {
  const root = assertRecord(value, 'session bindings');
  assertOnlyKeys(root, TOP_LEVEL_KEYS, 'session bindings');
  if (root['version'] !== SESSION_BINDINGS_VERSION) {
    throw new Error(`session bindings version must be ${SESSION_BINDINGS_VERSION}`);
  }

  const rawBindings = assertRecord(root['bindings'], 'session bindings.bindings');
  const rawPending = assertRecord(root['pendingLaunches'], 'session bindings.pendingLaunches');
  const bindings = emptyRecord<SessionBindingRecord>();
  const pendingLaunches = emptyRecord<PendingLaunchRecord>();
  const sessionOwners = new Map<string, string>();
  const launchNameOwners = new Map<string, string>();

  for (const profileId of Object.keys(rawBindings).sort()) {
    parseProfileId(profileId, 'session bindings.bindings key');
    const binding = parseBinding(rawBindings[profileId], `session bindings.bindings.${profileId}`);
    if (binding.profileId !== profileId) {
      throw new Error(
        `session bindings.bindings.${profileId}.profileId must match its containing key`,
      );
    }
    registerUnique(
      sessionOwners,
      binding.providerId,
      binding.shortSessionId,
      profileId,
      'Provider session ID',
    );
    if (binding.fullSessionId !== undefined) {
      registerUnique(
        sessionOwners,
        binding.providerId,
        binding.fullSessionId,
        profileId,
        'Provider session ID',
      );
    }
    registerUniqueLaunchName(
      launchNameOwners,
      binding.providerId,
      binding.uniqueLaunchName,
      `binding "${profileId}"`,
    );
    bindings[profileId] = binding;
  }

  for (const profileId of Object.keys(rawPending).sort()) {
    parseProfileId(profileId, 'session bindings.pendingLaunches key');
    const pending = parsePendingLaunch(
      rawPending[profileId],
      `session bindings.pendingLaunches.${profileId}`,
    );
    if (pending.profileId !== profileId) {
      throw new Error(
        `session bindings.pendingLaunches.${profileId}.profileId must match its containing key`,
      );
    }
    registerUniqueLaunchName(
      launchNameOwners,
      pending.providerId,
      pending.uniqueLaunchName,
      `pending launch "${profileId}"`,
    );
    pendingLaunches[profileId] = pending;
  }

  return { version: SESSION_BINDINGS_VERSION, bindings, pendingLaunches };
}

function cloneBinding(binding: SessionBindingRecord): SessionBindingRecord {
  return { ...binding };
}

function clonePending(pending: PendingLaunchRecord): PendingLaunchRecord {
  return { ...pending };
}

function cloneData(data: SessionBindingsFileV1): SessionBindingsFileV1 {
  const bindings = emptyRecord<SessionBindingRecord>();
  const pendingLaunches = emptyRecord<PendingLaunchRecord>();
  for (const [profileId, binding] of Object.entries(data.bindings)) {
    bindings[profileId] = cloneBinding(binding);
  }
  for (const [profileId, pending] of Object.entries(data.pendingLaunches)) {
    pendingLaunches[profileId] = clonePending(pending);
  }
  return { version: SESSION_BINDINGS_VERSION, bindings, pendingLaunches };
}

function orderedData(data: SessionBindingsFileV1): SessionBindingsFileV1 {
  const bindings = emptyRecord<SessionBindingRecord>();
  const pendingLaunches = emptyRecord<PendingLaunchRecord>();
  for (const profileId of Object.keys(data.bindings).sort()) {
    const binding = data.bindings[profileId];
    if (binding !== undefined) bindings[profileId] = binding;
  }
  for (const profileId of Object.keys(data.pendingLaunches).sort()) {
    const pending = data.pendingLaunches[profileId];
    if (pending !== undefined) pendingLaunches[profileId] = pending;
  }
  return { version: SESSION_BINDINGS_VERSION, bindings, pendingLaunches };
}

async function defaultAtomicWrite(file: string, text: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function sameRecord(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Resolves a persisted binding only by provider identity.
 *
 * When a full ID is persisted, a short-ID match with a missing or different
 * full ID is deliberately ignored. Falling back in that case could make a
 * truncated-ID collision claim somebody else's conversation.
 */
export function resolveExactBindingSession<T extends ProviderSessionIdentity>(
  binding: SessionBindingRecord,
  sessions: readonly T[],
): T | undefined {
  if (binding.fullSessionId !== undefined) {
    const fullMatches = sessions.filter(
      (session) => session.sessionId === binding.fullSessionId,
    );
    const exactShort = fullMatches.filter(
      (session) => session.id === binding.shortSessionId,
    );
    if (exactShort.length === 1) return exactShort[0];
    if (exactShort.length > 1) return undefined;

    if (fullMatches.length === 1 && fullMatches[0]?.id === undefined) {
      return fullMatches[0];
    }
    return undefined;
  }

  const shortMatches = sessions.filter((session) => session.id === binding.shortSessionId);
  return shortMatches.length === 1 ? shortMatches[0] : undefined;
}

export class SessionBindingStoreBlockedError extends Error {
  override readonly name = 'SessionBindingStoreBlockedError';

  constructor(
    message: string,
    readonly problem: SessionBindingStoreProblem,
  ) {
    super(message);
  }
}

/**
 * App-owned durable session ownership and incomplete-launch journal.
 *
 * Every mutation re-reads the disk document while holding the in-process write
 * queue. This both preserves valid external edits and prevents a malformed edit
 * from being silently replaced with the in-memory last-known-good value.
 */
export class SessionBindingStore {
  private dataValue = emptySessionBindingsFile();
  private problemValue: SessionBindingStoreProblem | undefined;
  private loadedValue = false;
  private fileExistsValue = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly atomicWrite: AtomicBindingWriter;
  private readonly now: () => Date;

  constructor(
    readonly file: string,
    options: SessionBindingStoreOptions = {},
  ) {
    this.atomicWrite = options.atomicWrite ?? defaultAtomicWrite;
    this.now = options.now ?? (() => new Date());
  }

  get state(): SessionBindingStoreState {
    return {
      file: this.file,
      loaded: this.loadedValue,
      fileExists: this.fileExistsValue,
      data: cloneData(this.dataValue),
      problem: this.problemValue === undefined ? undefined : { ...this.problemValue },
    };
  }

  get problem(): SessionBindingStoreProblem | undefined {
    return this.problemValue === undefined ? undefined : { ...this.problemValue };
  }

  getBinding(profileId: string): SessionBindingRecord | undefined {
    const binding = this.dataValue.bindings[profileId];
    return binding === undefined ? undefined : cloneBinding(binding);
  }

  getPendingLaunch(profileId: string): PendingLaunchRecord | undefined {
    const pending = this.dataValue.pendingLaunches[profileId];
    return pending === undefined ? undefined : clonePending(pending);
  }

  load(): Promise<SessionBindingStoreState> {
    return this.enqueue(async () => {
      await this.reloadUnlocked();
      return this.state;
    });
  }

  reload(): Promise<SessionBindingStoreState> {
    return this.load();
  }

  /**
   * Creates a profile's first binding. Use `replaceBinding` for Start new so an
   * accidental second initial commit cannot silently orphan the old ownership.
   */
  setBinding(binding: SessionBindingRecord): Promise<void> {
    const captured = cloneBinding(binding);
    return this.mutate(async (draft) => {
      const existing = draft.bindings[captured.profileId];
      if (existing !== undefined && !sameRecord(existing, captured)) {
        throw new Error(
          `Profile "${captured.profileId}" already has a binding; use replaceBinding`,
        );
      }
      (draft.bindings as Record<string, SessionBindingRecord>)[captured.profileId] = captured;
      delete (draft.pendingLaunches as Record<string, PendingLaunchRecord>)[captured.profileId];
    });
  }

  /**
   * Atomically swaps ownership after Start new has produced an exact session.
   * The returned old record is descriptive only; no provider stop/delete action
   * exists in this store.
   */
  replaceBinding(
    binding: SessionBindingRecord,
    expectedPrevious?: SessionBindingRecord | undefined,
  ): Promise<SessionBindingRecord | undefined> {
    const captured = cloneBinding(binding);
    const expected =
      expectedPrevious === undefined ? undefined : cloneBinding(expectedPrevious);
    return this.mutate(async (draft) => {
      const previous = draft.bindings[captured.profileId];
      if (
        expected !== undefined &&
        (previous === undefined || !sameRecord(previous, expected))
      ) {
        throw new Error(
          `Profile "${captured.profileId}" binding changed during Start new; refusing to overwrite it`,
        );
      }
      (draft.bindings as Record<string, SessionBindingRecord>)[captured.profileId] = captured;
      delete (draft.pendingLaunches as Record<string, PendingLaunchRecord>)[captured.profileId];
      return previous === undefined ? undefined : cloneBinding(previous);
    });
  }

  clearBinding(
    profileId: string,
    expectedPrevious?: SessionBindingRecord | undefined,
  ): Promise<SessionBindingRecord | undefined> {
    const expected =
      expectedPrevious === undefined ? undefined : cloneBinding(expectedPrevious);
    return this.mutate(async (draft) => {
      const previous = draft.bindings[profileId];
      if (
        expected !== undefined &&
        (previous === undefined || !sameRecord(previous, expected))
      ) {
        throw new Error(
          `Profile "${profileId}" binding changed before it could be cleared`,
        );
      }
      delete (draft.bindings as Record<string, SessionBindingRecord>)[profileId];
      return previous === undefined ? undefined : cloneBinding(previous);
    });
  }

  setPendingLaunch(pending: PendingLaunchRecord): Promise<void> {
    const captured = clonePending(pending);
    return this.mutate(async (draft) => {
      const existing = draft.pendingLaunches[captured.profileId];
      if (existing !== undefined && !sameRecord(existing, captured)) {
        throw new Error(`Profile "${captured.profileId}" already has a pending launch`);
      }
      (draft.pendingLaunches as Record<string, PendingLaunchRecord>)[captured.profileId] =
        captured;
    });
  }

  markPendingLaunchRejected(
    profileId: string,
    expectedPrevious: PendingLaunchRecord,
  ): Promise<PendingLaunchRecord> {
    const expected = clonePending(expectedPrevious);
    return this.mutate(async (draft) => {
      const previous = draft.pendingLaunches[profileId];
      if (previous === undefined || !sameRecord(previous, expected)) {
        throw new Error(
          `Profile "${profileId}" pending launch changed before it could be rejected`,
        );
      }
      const rejected: PendingLaunchRecord = {
        ...previous,
        disposition: 'rejected-substitution',
      };
      (draft.pendingLaunches as Record<string, PendingLaunchRecord>)[profileId] =
        rejected;
      return clonePending(rejected);
    });
  }

  clearPendingLaunch(
    profileId: string,
    expectedPrevious?: PendingLaunchRecord | undefined,
  ): Promise<PendingLaunchRecord | undefined> {
    const expected =
      expectedPrevious === undefined ? undefined : clonePending(expectedPrevious);
    return this.mutate(async (draft) => {
      const previous = draft.pendingLaunches[profileId];
      if (
        expected !== undefined &&
        (previous === undefined || !sameRecord(previous, expected))
      ) {
        throw new Error(
          `Profile "${profileId}" pending launch changed before it could be cleared`,
        );
      }
      delete (draft.pendingLaunches as Record<string, PendingLaunchRecord>)[profileId];
      return previous === undefined ? undefined : clonePending(previous);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private mutate<T>(
    operation: (draft: SessionBindingsFileV1) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      await this.reloadUnlocked();
      if (this.problemValue !== undefined) {
        throw new SessionBindingStoreBlockedError(
          `Refusing to overwrite ${this.file}: ${this.problemValue.message}`,
          { ...this.problemValue },
        );
      }

      const draft = cloneData(this.dataValue);
      const result = await operation(draft);
      const validated = parseSessionBindingsFile(draft);
      const ordered = orderedData(validated);
      const text = `${JSON.stringify(ordered, null, 2)}\n`;

      try {
        await this.atomicWrite(this.file, text);
      } catch (error) {
        this.problemValue = this.makeProblem('write', error);
        throw error;
      }

      this.dataValue = ordered;
      this.fileExistsValue = true;
      this.loadedValue = true;
      this.problemValue = undefined;
      return result;
    });
  }

  private async reloadUnlocked(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
      this.fileExistsValue = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.dataValue = emptySessionBindingsFile();
        this.fileExistsValue = false;
        this.loadedValue = true;
        this.problemValue = undefined;
        return;
      }
      this.loadedValue = true;
      this.problemValue = this.makeProblem('read', error);
      return;
    }

    try {
      const parsed = parseSessionBindingsFile(JSON.parse(text) as unknown);
      this.dataValue = parsed;
      this.loadedValue = true;
      this.problemValue = undefined;
    } catch (error) {
      this.loadedValue = true;
      this.problemValue = this.makeProblem('parse', error);
    }
  }

  private makeProblem(
    kind: SessionBindingStoreProblemKind,
    error: unknown,
  ): SessionBindingStoreProblem {
    return {
      kind,
      file: this.file,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: this.now().toISOString(),
    };
  }
}
