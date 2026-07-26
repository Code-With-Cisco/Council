import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { writeJsonAtomic } from '../../config/atomicJson.js';
import { isFullGitObjectId } from '../../git/client.js';
import { isValidProfileId } from '../../profileIdentity.js';
import {
  WORKTREE_LEASES_VERSION,
  type GateWorktreeRunRecord,
  type GateWorktreeRunState,
  type GateWorktreeRunTerminalResult,
  type PendingWorktreeOperation,
  type WorktreeLeaseRecord,
  type WorktreeLeasesFileV1,
  type WorktreeLeaseState,
  type WorktreeLeaseStoreProblem,
  type WorktreeLeaseStoreProblemKind,
  type WorktreeLeaseStoreState,
} from './types.js';

const ROOT_KEYS = new Set([
  'version',
  'revision',
  'leases',
  'pendingOperations',
  'gateRuns',
]);
const LEASE_KEYS = new Set([
  'leaseId',
  'workspaceId',
  'missionId',
  'taskId',
  'assignmentId',
  'ownerProfileId',
  'accessMode',
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
const GATE_RUN_KEYS = new Set([
  'runId',
  'idempotencyKey',
  'requestFingerprint',
  'workspaceId',
  'missionId',
  'candidateId',
  'kind',
  'assignmentId',
  'ownerProfileId',
  'accessMode',
  'repositoryRoot',
  'commonGitDir',
  'objectFormat',
  'checkoutPath',
  'commit',
  'tree',
  'commandIds',
  'gatePolicyFingerprint',
  'state',
  'createdAt',
  'updatedAt',
  'blockedReason',
  'terminalResult',
]);
const GATE_RESULT_KEYS = new Set([
  'candidateId',
  'executorExecutionId',
  'executorProfileId',
  'kind',
  'status',
  'commitSha',
  'treeSha',
  'commandIds',
  'gatePolicyFingerprint',
  'evidence',
  'completedAt',
  'retainedCheckoutPath',
]);
const LEASE_ID = /^lease_[0-9a-f]{32}$/;
const OPERATION_ID = /^leaseop_[0-9a-f]{32}$/;
const GATE_RUN_ID = /^gaterun_[0-9a-f]{32}$/;
const GATE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const EXECUTION_ID = /^execution_[A-Za-z0-9_-]{8,96}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const MAX_GATE_EVIDENCE_ENTRIES = 512;
const MAX_GATE_EVIDENCE_ENTRY_LENGTH = 4_000;
const MAX_GATE_EVIDENCE_BYTES = 256 * 1024;
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
const GATE_RUN_STATES = new Set<GateWorktreeRunState>([
  'provisioning',
  'running',
  'cleanup-pending',
  'retained',
  'blocked',
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
    gateRuns: emptyRecord<GateWorktreeRunRecord>(),
  };
}

function cloneData(data: WorktreeLeasesFileV1): WorktreeLeasesFileV1 {
  const leases = emptyRecord<WorktreeLeaseRecord>();
  const pendingOperations = emptyRecord<PendingWorktreeOperation>();
  const gateRuns = emptyRecord<GateWorktreeRunRecord>();
  for (const [key, lease] of Object.entries(data.leases)) leases[key] = { ...lease };
  for (const [key, pending] of Object.entries(data.pendingOperations)) {
    pendingOperations[key] = { ...pending };
  }
  for (const [key, run] of Object.entries(data.gateRuns)) {
    gateRuns[key] = {
      ...run,
      commandIds: [...run.commandIds],
      ...(run.terminalResult === undefined
        ? {}
        : {
            terminalResult: {
              ...run.terminalResult,
              commandIds: [...run.terminalResult.commandIds],
              evidence: [...run.terminalResult.evidence],
            },
          }),
    };
  }
  return {
    version: WORKTREE_LEASES_VERSION,
    revision: data.revision,
    leases,
    pendingOperations,
    gateRuns,
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
    accessMode: (() => {
      if (raw['accessMode'] !== 'workspace-write') {
        throw new Error(`${location}.accessMode must be workspace-write`);
      }
      return 'workspace-write' as const;
    })(),
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

function parseCommandIds(
  value: unknown,
  location: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256
  ) {
    throw new Error(
      `${location} must be a non-empty bounded array`,
    );
  }
  const commandIds = value.map((entry, index) => {
    const id = string(entry, `${location}[${index}]`, 128);
    if (!COMMAND_ID.test(id)) {
      throw new Error(`${location}[${index}] is invalid`);
    }
    return id;
  });
  if (new Set(commandIds).size !== commandIds.length) {
    throw new Error(`${location} contains duplicate IDs`);
  }
  return commandIds;
}

function exactStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseGateTerminalResult(
  value: unknown,
  location: string,
  run: {
    readonly candidateId: string;
    readonly assignmentId: string;
    readonly ownerProfileId: string;
    readonly kind: 'test' | 'review';
    readonly format: 'sha1' | 'sha256';
    readonly checkoutPath: string;
    readonly commit: string;
    readonly tree: string;
    readonly commandIds: readonly string[];
    readonly gatePolicyFingerprint: string;
    readonly state: GateWorktreeRunState;
  },
): GateWorktreeRunTerminalResult {
  const raw = record(value, location);
  onlyKeys(raw, GATE_RESULT_KEYS, location);
  const candidateId = string(raw['candidateId'], `${location}.candidateId`, 512);
  const executorExecutionId = string(
    raw['executorExecutionId'],
    `${location}.executorExecutionId`,
    512,
  );
  const executorProfileId = string(
    raw['executorProfileId'],
    `${location}.executorProfileId`,
    512,
  );
  const kind = raw['kind'];
  if (kind !== 'test' && kind !== 'review') {
    throw new Error(`${location}.kind is unsupported`);
  }
  const status = raw['status'];
  if (status !== 'passed' && status !== 'failed') {
    throw new Error(`${location}.status is unsupported`);
  }
  const commitSha = objectId(
    raw['commitSha'],
    `${location}.commitSha`,
    run.format,
  );
  const treeSha = objectId(
    raw['treeSha'],
    `${location}.treeSha`,
    run.format,
  );
  const commandIds = parseCommandIds(
    raw['commandIds'],
    `${location}.commandIds`,
  );
  const gatePolicyFingerprint = string(
    raw['gatePolicyFingerprint'],
    `${location}.gatePolicyFingerprint`,
    64,
  );
  if (!SHA_256.test(gatePolicyFingerprint)) {
    throw new Error(
      `${location}.gatePolicyFingerprint must be a SHA-256 digest`,
    );
  }
  if (
    !Array.isArray(raw['evidence']) ||
    raw['evidence'].length === 0 ||
    raw['evidence'].length > MAX_GATE_EVIDENCE_ENTRIES
  ) {
    throw new Error(`${location}.evidence must be a non-empty bounded array`);
  }
  let evidenceBytes = 0;
  const evidence = raw['evidence'].map((entry, index) => {
    const parsed = string(
      entry,
      `${location}.evidence[${index}]`,
      MAX_GATE_EVIDENCE_ENTRY_LENGTH,
    );
    evidenceBytes += Buffer.byteLength(parsed, 'utf8');
    return parsed;
  });
  if (evidenceBytes > MAX_GATE_EVIDENCE_BYTES) {
    throw new Error(`${location}.evidence exceeds its total byte limit`);
  }
  const completedAt = timestamp(raw['completedAt'], `${location}.completedAt`);
  const retainedCheckoutPath =
    Object.hasOwn(raw, 'retainedCheckoutPath') &&
    raw['retainedCheckoutPath'] !== undefined
      ? absolutePath(
          raw['retainedCheckoutPath'],
          `${location}.retainedCheckoutPath`,
        )
      : undefined;
  if (
    candidateId !== run.candidateId ||
    executorExecutionId !== run.assignmentId ||
    executorProfileId !== run.ownerProfileId ||
    kind !== run.kind ||
    commitSha !== run.commit ||
    treeSha !== run.tree ||
    !exactStringArray(commandIds, run.commandIds) ||
    gatePolicyFingerprint !== run.gatePolicyFingerprint
  ) {
    throw new Error(`${location} does not match its exact gate run identity`);
  }
  if (
    retainedCheckoutPath !== undefined &&
    (retainedCheckoutPath !== run.checkoutPath ||
      run.state !== 'retained' ||
      status !== 'failed')
  ) {
    throw new Error(
      `${location}.retainedCheckoutPath does not match a retained failed run`,
    );
  }
  return {
    candidateId,
    executorExecutionId,
    executorProfileId,
    kind,
    status,
    commitSha,
    treeSha,
    commandIds,
    gatePolicyFingerprint,
    evidence,
    completedAt,
    ...(retainedCheckoutPath === undefined ? {} : { retainedCheckoutPath }),
  };
}

function parseGateRun(
  value: unknown,
  key: string,
): GateWorktreeRunRecord {
  const location = `worktree leases.gateRuns.${key}`;
  const raw = record(value, location);
  onlyKeys(raw, GATE_RUN_KEYS, location);
  const runId = string(raw['runId'], `${location}.runId`, 64);
  if (!GATE_RUN_ID.test(runId) || runId !== key) {
    throw new Error(`${location}.runId must match its generated key`);
  }
  const idempotencyKey = string(
    raw['idempotencyKey'],
    `${location}.idempotencyKey`,
    128,
  );
  if (!GATE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error(
      `${location}.idempotencyKey must be a bounded opaque identifier`,
    );
  }
  const requestFingerprint = string(
    raw['requestFingerprint'],
    `${location}.requestFingerprint`,
    64,
  );
  if (!SHA_256.test(requestFingerprint)) {
    throw new Error(
      `${location}.requestFingerprint must be a SHA-256 digest`,
    );
  }
  const workspaceId = string(
    raw['workspaceId'],
    `${location}.workspaceId`,
    512,
  );
  const missionId = string(raw['missionId'], `${location}.missionId`, 512);
  const candidateId = string(
    raw['candidateId'],
    `${location}.candidateId`,
    512,
  );
  if (
    !OPAQUE_ID.test(workspaceId) ||
    !OPAQUE_ID.test(missionId) ||
    !OPAQUE_ID.test(candidateId)
  ) {
    throw new Error(
      `${location} workspace, mission, and candidate IDs must be opaque`,
    );
  }
  const kind = raw['kind'];
  if (kind !== 'test' && kind !== 'review') {
    throw new Error(`${location}.kind is unsupported`);
  }
  const assignmentId = string(
    raw['assignmentId'],
    `${location}.assignmentId`,
    512,
  );
  const ownerProfileId = string(
    raw['ownerProfileId'],
    `${location}.ownerProfileId`,
    512,
  );
  if (!EXECUTION_ID.test(assignmentId) || !isValidProfileId(ownerProfileId)) {
    throw new Error(
      `${location} assignment and owner profile IDs must be exact Mission identities`,
    );
  }
  if (raw['accessMode'] !== 'read-only') {
    throw new Error(`${location}.accessMode must be read-only`);
  }
  const format = raw['objectFormat'];
  if (format !== 'sha1' && format !== 'sha256') {
    throw new Error(`${location}.objectFormat must be sha1 or sha256`);
  }
  const state = raw['state'];
  if (
    typeof state !== 'string' ||
    !GATE_RUN_STATES.has(state as GateWorktreeRunState)
  ) {
    throw new Error(`${location}.state is unsupported`);
  }
  const commandIds = parseCommandIds(
    raw['commandIds'],
    `${location}.commandIds`,
  );
  const gatePolicyFingerprint = string(
    raw['gatePolicyFingerprint'],
    `${location}.gatePolicyFingerprint`,
    64,
  );
  if (!SHA_256.test(gatePolicyFingerprint)) {
    throw new Error(
      `${location}.gatePolicyFingerprint must be a SHA-256 digest`,
    );
  }
  const blockedReason = optionalString(raw, 'blockedReason', location, 2_000);
  if (
    (state === 'blocked' || state === 'retained') &&
    blockedReason === undefined
  ) {
    throw new Error(
      `${location}.blockedReason is required for ${state} state`,
    );
  }
  const repositoryRoot = absolutePath(
    raw['repositoryRoot'],
    `${location}.repositoryRoot`,
  );
  const commonGitDir = absolutePath(
    raw['commonGitDir'],
    `${location}.commonGitDir`,
  );
  const checkoutPath = absolutePath(
    raw['checkoutPath'],
    `${location}.checkoutPath`,
  );
  const commit = objectId(raw['commit'], `${location}.commit`, format);
  const tree = objectId(raw['tree'], `${location}.tree`, format);
  const terminalResult =
    Object.hasOwn(raw, 'terminalResult') && raw['terminalResult'] !== undefined
      ? parseGateTerminalResult(
          raw['terminalResult'],
          `${location}.terminalResult`,
          {
            candidateId,
            assignmentId,
            ownerProfileId,
            kind,
            format,
            checkoutPath,
            commit,
            tree,
            commandIds,
            gatePolicyFingerprint,
            state: state as GateWorktreeRunState,
          },
        )
      : undefined;
  if (
    terminalResult !== undefined &&
    (state === 'provisioning' || state === 'running')
  ) {
    throw new Error(
      `${location}.terminalResult cannot be stored before terminal state`,
    );
  }
  return {
    runId,
    idempotencyKey,
    requestFingerprint,
    workspaceId,
    missionId,
    candidateId,
    kind,
    assignmentId,
    ownerProfileId,
    accessMode: 'read-only',
    repositoryRoot,
    commonGitDir,
    objectFormat: format,
    checkoutPath,
    commit,
    tree,
    commandIds,
    gatePolicyFingerprint,
    state: state as GateWorktreeRunState,
    createdAt: timestamp(raw['createdAt'], `${location}.createdAt`),
    updatedAt: timestamp(raw['updatedAt'], `${location}.updatedAt`),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(terminalResult === undefined ? {} : { terminalResult }),
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
  const rawGateRuns = record(raw['gateRuns'], 'worktree leases.gateRuns');
  const gateRuns = emptyRecord<GateWorktreeRunRecord>();
  const gateIdempotencyOwners = new Map<string, string>();
  for (const key of Object.keys(rawGateRuns).sort()) {
    const run = parseGateRun(rawGateRuns[key], key);
    const idempotencyIdentity = `${run.workspaceId}\0${run.idempotencyKey}`;
    const idempotencyOwner = gateIdempotencyOwners.get(idempotencyIdentity);
    if (idempotencyOwner !== undefined) {
      throw new Error(
        `Gate idempotency key belongs to both ${idempotencyOwner} and ${key}`,
      );
    }
    gateIdempotencyOwners.set(idempotencyIdentity, key);
    if (run.state !== 'removed') {
      const pathKey = pathIdentity(run.checkoutPath, platform);
      const pathOwner = pathOwners.get(pathKey);
      if (pathOwner !== undefined) {
        throw new Error(
          `Checkout path belongs to both ${pathOwner} and gate run ${key}`,
        );
      }
      pathOwners.set(pathKey, key);
      const assignmentKey = `${run.workspaceId}\0${run.assignmentId}`;
      const assignmentOwner = assignmentOwners.get(assignmentKey);
      if (assignmentOwner !== undefined) {
        throw new Error(
          `Assignment has both worktree owners ${assignmentOwner} and ${key}`,
        );
      }
      assignmentOwners.set(assignmentKey, key);
    }
    gateRuns[key] = run;
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
    gateRuns,
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
