import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { writeJsonAtomic } from '../../config/atomicJson.js';
import { isFullGitObjectId } from '../../git/client.js';
import {
  WORKTREE_LEASES_VERSION,
  type PendingWorktreeOperation,
  type WorktreeLeaseRecord,
  type WorktreeLeasesFileV1,
  type WorktreeLeaseState,
  type WorktreeLeaseStoreProblem,
  type WorktreeLeaseStoreProblemKind,
  type WorktreeLeaseStoreState,
} from './types.js';

const ROOT_KEYS = new Set(['version', 'revision', 'leases', 'pendingOperations']);
const LEASE_KEYS = new Set([
  'leaseId',
  'workspaceId',
  'missionId',
  'taskId',
  'assignmentId',
  'ownerProfileId',
  'repositoryRoot',
  'commonGitDir',
  'objectFormat',
  'checkoutPath',
  'branchRef',
  'baseCommit',
  'baseTree',
  'state',
  'createdAt',
  'updatedAt',
  'lastVerifiedHead',
  'lastVerifiedTree',
  'blockedReason',
]);
const PENDING_KEYS = new Set([
  'operationId',
  'kind',
  'leaseId',
  'expectedBranchRef',
  'expectedCheckoutPath',
  'expectedHead',
  'createdAt',
]);
const LEASE_ID = /^lease_[0-9a-f]{32}$/;
const OPERATION_ID = /^leaseop_[0-9a-f]{32}$/;
const COUNCIL_BRANCH = /^refs\/heads\/council\/[a-z0-9][a-z0-9/-]*$/;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
const STATES = new Set<WorktreeLeaseState>([
  'provisioning',
  'active',
  'retained',
  'blocked',
  'cleanup-pending',
  'removed',
]);

export type WorktreeLeaseAtomicWriter = (
  file: string,
  value: WorktreeLeasesFileV1,
) => Promise<void>;

export interface WorktreeLeaseStoreOptions {
  readonly readText?: ((file: string) => Promise<string>) | undefined;
  readonly writeState?: WorktreeLeaseAtomicWriter | undefined;
  readonly now?: (() => Date) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function emptyWorktreeLeasesFile(): WorktreeLeasesFileV1 {
  return {
    version: WORKTREE_LEASES_VERSION,
    revision: 0,
    leases: emptyRecord<WorktreeLeaseRecord>(),
    pendingOperations: emptyRecord<PendingWorktreeOperation>(),
  };
}

function cloneData(data: WorktreeLeasesFileV1): WorktreeLeasesFileV1 {
  const leases = emptyRecord<WorktreeLeaseRecord>();
  const pendingOperations = emptyRecord<PendingWorktreeOperation>();
  for (const [key, lease] of Object.entries(data.leases)) leases[key] = { ...lease };
  for (const [key, pending] of Object.entries(data.pendingOperations)) {
    pendingOperations[key] = { ...pending };
  }
  return {
    version: WORKTREE_LEASES_VERSION,
    revision: data.revision,
    leases,
    pendingOperations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  return value;
}

function onlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  location: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${location} has unsupported fields: ${unexpected.join(', ')}`);
  }
}

function string(
  value: unknown,
  location: string,
  maxLength = 4_096,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${location} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new Error(`${location} is too long`);
  if (CONTROL_BYTES.test(value)) throw new Error(`${location} contains a control character`);
  return value;
}

function timestamp(value: unknown, location: string): string {
  const result = string(value, location, 128);
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error(`${location} must be a valid timestamp`);
  }
  return result;
}

function absolutePath(value: unknown, location: string): string {
  const result = string(value, location);
  if (!path.isAbsolute(result)) throw new Error(`${location} must be absolute`);
  return result;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  location: string,
  maxLength = 4_096,
): string | undefined {
  if (!Object.hasOwn(value, key) || value[key] === undefined) return undefined;
  return string(value[key], `${location}.${key}`, maxLength);
}

function objectId(
  value: unknown,
  location: string,
  format: 'sha1' | 'sha256',
): string {
  const result = string(value, location, 64);
  if (!isFullGitObjectId(result, format)) {
    throw new Error(`${location} must be a full ${format} object ID`);
  }
  return result;
}

function parseLease(value: unknown, key: string): WorktreeLeaseRecord {
  const location = `worktree leases.leases.${key}`;
  const raw = record(value, location);
  onlyKeys(raw, LEASE_KEYS, location);
  const leaseId = string(raw['leaseId'], `${location}.leaseId`, 64);
  if (!LEASE_ID.test(leaseId) || leaseId !== key) {
    throw new Error(`${location}.leaseId must match its generated key`);
  }
  const format = raw['objectFormat'];
  if (format !== 'sha1' && format !== 'sha256') {
    throw new Error(`${location}.objectFormat must be sha1 or sha256`);
  }
  const state = raw['state'];
  if (typeof state !== 'string' || !STATES.has(state as WorktreeLeaseState)) {
    throw new Error(`${location}.state is unsupported`);
  }
  const branchRef = string(raw['branchRef'], `${location}.branchRef`, 512);
  if (
    !COUNCIL_BRANCH.test(branchRef) ||
    branchRef.includes('..') ||
    branchRef.includes('//') ||
    branchRef.endsWith('/')
  ) {
    throw new Error(`${location}.branchRef is not a generated Council branch`);
  }
  const lastVerifiedHead = optionalString(raw, 'lastVerifiedHead', location, 64);
  const lastVerifiedTree = optionalString(raw, 'lastVerifiedTree', location, 64);
  if ((lastVerifiedHead === undefined) !== (lastVerifiedTree === undefined)) {
    throw new Error(`${location} must store verified head and tree together`);
  }
  const blockedReason = optionalString(raw, 'blockedReason', location, 2_000);
  if (state === 'blocked' && blockedReason === undefined) {
    throw new Error(`${location}.blockedReason is required for a blocked lease`);
  }
  return {
    leaseId,
    workspaceId: string(raw['workspaceId'], `${location}.workspaceId`, 512),
    missionId: string(raw['missionId'], `${location}.missionId`, 512),
    taskId: string(raw['taskId'], `${location}.taskId`, 512),
    assignmentId: string(raw['assignmentId'], `${location}.assignmentId`, 512),
    ownerProfileId: string(raw['ownerProfileId'], `${location}.ownerProfileId`, 512),
    repositoryRoot: absolutePath(raw['repositoryRoot'], `${location}.repositoryRoot`),
    commonGitDir: absolutePath(raw['commonGitDir'], `${location}.commonGitDir`),
    objectFormat: format,
    checkoutPath: absolutePath(raw['checkoutPath'], `${location}.checkoutPath`),
    branchRef,
    baseCommit: objectId(raw['baseCommit'], `${location}.baseCommit`, format),
    baseTree: objectId(raw['baseTree'], `${location}.baseTree`, format),
    state: state as WorktreeLeaseState,
    createdAt: timestamp(raw['createdAt'], `${location}.createdAt`),
    updatedAt: timestamp(raw['updatedAt'], `${location}.updatedAt`),
    ...(lastVerifiedHead === undefined
      ? {}
      : {
          lastVerifiedHead: objectId(
            lastVerifiedHead,
            `${location}.lastVerifiedHead`,
            format,
          ),
          lastVerifiedTree: objectId(
            lastVerifiedTree!,
            `${location}.lastVerifiedTree`,
            format,
          ),
        }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
  };
}

function parsePending(
  value: unknown,
  key: string,
  leases: Readonly<Record<string, WorktreeLeaseRecord>>,
): PendingWorktreeOperation {
  const location = `worktree leases.pendingOperations.${key}`;
  const raw = record(value, location);
  onlyKeys(raw, PENDING_KEYS, location);
  const operationId = string(raw['operationId'], `${location}.operationId`, 64);
  if (!OPERATION_ID.test(operationId) || operationId !== key) {
    throw new Error(`${location}.operationId must match its generated key`);
  }
  const kind = raw['kind'];
  if (kind !== 'provision' && kind !== 'cleanup') {
    throw new Error(`${location}.kind is unsupported`);
  }
  const leaseId = string(raw['leaseId'], `${location}.leaseId`, 64);
  const lease = leases[leaseId];
  if (lease === undefined) throw new Error(`${location} references an unknown lease`);
  const expectedBranchRef = string(
    raw['expectedBranchRef'],
    `${location}.expectedBranchRef`,
    512,
  );
  const expectedCheckoutPath = absolutePath(
    raw['expectedCheckoutPath'],
    `${location}.expectedCheckoutPath`,
  );
  const expectedHead = objectId(
    raw['expectedHead'],
    `${location}.expectedHead`,
    lease.objectFormat,
  );
  if (
    expectedBranchRef !== lease.branchRef ||
    expectedCheckoutPath !== lease.checkoutPath
  ) {
    throw new Error(`${location} does not match its lease identity`);
  }
  if (kind === 'provision' && lease.state !== 'provisioning') {
    throw new Error(`${location} provision operation requires a provisioning lease`);
  }
  if (kind === 'cleanup' && lease.state !== 'cleanup-pending') {
    throw new Error(`${location} cleanup operation requires a cleanup-pending lease`);
  }
  return {
    operationId,
    kind,
    leaseId,
    expectedBranchRef,
    expectedCheckoutPath,
    expectedHead,
    createdAt: timestamp(raw['createdAt'], `${location}.createdAt`),
  };
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(value);
  return platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

export function parseWorktreeLeasesFile(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): WorktreeLeasesFileV1 {
  const raw = record(value, 'worktree leases');
  onlyKeys(raw, ROOT_KEYS, 'worktree leases');
  if (raw['version'] !== WORKTREE_LEASES_VERSION) {
    throw new Error(`worktree leases version must be ${WORKTREE_LEASES_VERSION}`);
  }
  if (!Number.isSafeInteger(raw['revision']) || (raw['revision'] as number) < 0) {
    throw new Error('worktree leases.revision must be a non-negative safe integer');
  }
  const rawLeases = record(raw['leases'], 'worktree leases.leases');
  const leases = emptyRecord<WorktreeLeaseRecord>();
  const pathOwners = new Map<string, string>();
  const branchOwners = new Map<string, string>();
  const assignmentOwners = new Map<string, string>();
  for (const key of Object.keys(rawLeases).sort()) {
    const lease = parseLease(rawLeases[key], key);
    if (lease.state !== 'removed') {
      const pathKey = pathIdentity(lease.checkoutPath, platform);
      const pathOwner = pathOwners.get(pathKey);
      if (pathOwner !== undefined) {
        throw new Error(`Checkout path belongs to both ${pathOwner} and ${key}`);
      }
      pathOwners.set(pathKey, key);
      const branchOwner = branchOwners.get(lease.branchRef);
      if (branchOwner !== undefined) {
        throw new Error(`Council branch belongs to both ${branchOwner} and ${key}`);
      }
      branchOwners.set(lease.branchRef, key);
      const assignmentKey = `${lease.workspaceId}\0${lease.assignmentId}`;
      const assignmentOwner = assignmentOwners.get(assignmentKey);
      if (assignmentOwner !== undefined) {
        throw new Error(`Assignment has both lease ${assignmentOwner} and ${key}`);
      }
      assignmentOwners.set(assignmentKey, key);
    }
    leases[key] = lease;
  }
  const rawPending = record(
    raw['pendingOperations'],
    'worktree leases.pendingOperations',
  );
  const pendingOperations = emptyRecord<PendingWorktreeOperation>();
  const pendingLeaseOwners = new Map<string, string>();
  for (const key of Object.keys(rawPending).sort()) {
    const pending = parsePending(rawPending[key], key, leases);
    const existing = pendingLeaseOwners.get(pending.leaseId);
    if (existing !== undefined) {
      throw new Error(`Lease has both pending operations ${existing} and ${key}`);
    }
    pendingLeaseOwners.set(pending.leaseId, key);
    pendingOperations[key] = pending;
  }
  return {
    version: WORKTREE_LEASES_VERSION,
    revision: raw['revision'] as number,
    leases,
    pendingOperations,
  };
}

export class WorktreeLeaseStoreBlockedError extends Error {
  override readonly name = 'WorktreeLeaseStoreBlockedError';

  constructor(readonly problem: WorktreeLeaseStoreProblem) {
    super(`Refusing to overwrite ${problem.file}: ${problem.message}`);
  }
}

export class WorktreeLeaseStoreConflictError extends Error {
  override readonly name = 'WorktreeLeaseStoreConflictError';

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Worktree lease revision changed from ${expectedRevision} to ${actualRevision}.`,
    );
  }
}

export class WorktreeLeaseStore {
  private dataValue = emptyWorktreeLeasesFile();
  private problemValue: WorktreeLeaseStoreProblem | undefined;
  private loadedValue = false;
  private fileExistsValue = false;
  private hasKnownGoodValue = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly readText: (file: string) => Promise<string>;
  private readonly writeState: WorktreeLeaseAtomicWriter;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;

  constructor(
    readonly file: string,
    options: WorktreeLeaseStoreOptions = {},
  ) {
    if (!path.isAbsolute(file)) {
      throw new TypeError('Worktree lease store path must be absolute.');
    }
    this.readText = options.readText ?? ((target) => readFile(target, 'utf8'));
    this.writeState =
      options.writeState ?? ((target, state) => writeJsonAtomic(target, state));
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
  }

  get state(): WorktreeLeaseStoreState {
    return {
      file: this.file,
      loaded: this.loadedValue,
      fileExists: this.fileExistsValue,
      data: cloneData(this.dataValue),
      problem:
        this.problemValue === undefined ? undefined : { ...this.problemValue },
    };
  }

  get problem(): WorktreeLeaseStoreProblem | undefined {
    return this.problemValue === undefined ? undefined : { ...this.problemValue };
  }

  getLease(leaseId: string): WorktreeLeaseRecord | undefined {
    const lease = this.dataValue.leases[leaseId];
    return lease === undefined ? undefined : { ...lease };
  }

  load(): Promise<WorktreeLeaseStoreState> {
    return this.enqueue(async () => {
      await this.reloadUnlocked();
      return this.state;
    });
  }

  reload(): Promise<WorktreeLeaseStoreState> {
    return this.load();
  }

  transact<T>(
    expectedRevision: number,
    operation: (draft: WorktreeLeasesFileV1) => T,
  ): Promise<T> {
    return this.enqueue(async () => {
      await this.reloadUnlocked();
      if (this.problemValue !== undefined) {
        throw new WorktreeLeaseStoreBlockedError({ ...this.problemValue });
      }
      if (this.dataValue.revision !== expectedRevision) {
        throw new WorktreeLeaseStoreConflictError(
          expectedRevision,
          this.dataValue.revision,
        );
      }
      const draft = cloneData(this.dataValue);
      const result = operation(draft);
      const incremented: WorktreeLeasesFileV1 = {
        ...draft,
        version: WORKTREE_LEASES_VERSION,
        revision: expectedRevision + 1,
      };
      const validated = parseWorktreeLeasesFile(incremented, this.platform);
      try {
        await this.writeState(this.file, validated);
      } catch (error) {
        this.problemValue = this.makeProblem('write', error);
        throw error;
      }
      this.dataValue = validated;
      this.loadedValue = true;
      this.fileExistsValue = true;
      this.hasKnownGoodValue = true;
      this.problemValue = undefined;
      return result;
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

  private async reloadUnlocked(): Promise<void> {
    let text: string;
    try {
      text = await this.readText(this.file);
      this.fileExistsValue = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.hasKnownGoodValue && this.fileExistsValue) {
          this.problemValue = this.makeProblem(
            'read',
            new Error('The worktree lease file disappeared after it was loaded.'),
          );
          return;
        }
        this.dataValue = emptyWorktreeLeasesFile();
        this.loadedValue = true;
        this.fileExistsValue = false;
        this.hasKnownGoodValue = true;
        this.problemValue = undefined;
        return;
      }
      this.loadedValue = true;
      this.problemValue = this.makeProblem('read', error);
      return;
    }
    try {
      this.dataValue = parseWorktreeLeasesFile(
        JSON.parse(text) as unknown,
        this.platform,
      );
      this.loadedValue = true;
      this.hasKnownGoodValue = true;
      this.problemValue = undefined;
    } catch (error) {
      this.loadedValue = true;
      this.problemValue = this.makeProblem('parse', error);
    }
  }

  private makeProblem(
    kind: WorktreeLeaseStoreProblemKind,
    error: unknown,
  ): WorktreeLeaseStoreProblem {
    return {
      kind,
      file: this.file,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: this.now().toISOString(),
    };
  }
}
