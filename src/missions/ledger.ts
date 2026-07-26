import { readFile as nodeReadFile } from 'node:fs/promises';
import * as path from 'node:path';
import { writeJsonAtomic } from '../config/atomicJson.js';
import { isValidProfileId } from '../profileIdentity.js';
import {
  MISSION_LEDGER_VERSION,
  type HandoffRecord,
  type IntegrationApprovalRecord,
  type IntegrationCandidateRecord,
  type MissionExecutionRecord,
  type MissionGateRecord,
  type MissionLedgerEvent,
  type MissionLedgerFileV1,
  type MissionPhase,
  type MissionRecord,
  type MissionTaskRecord,
  type MissionTaskState,
  type WorktreeLeaseRecord,
} from './types.js';

export const MISSION_LEDGER_FILENAME = 'mission-ledger.json';

export type MissionLedgerStoreProblemKind = 'read' | 'parse' | 'write';

export interface MissionLedgerStoreProblem {
  readonly kind: MissionLedgerStoreProblemKind;
  readonly file: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface MissionLedgerStoreState {
  readonly file: string;
  readonly loaded: boolean;
  readonly fileExists: boolean;
  readonly data: MissionLedgerFileV1;
  readonly problem: MissionLedgerStoreProblem | undefined;
}

export interface MutableMissionLedger {
  version: typeof MISSION_LEDGER_VERSION;
  revision: number;
  missions: Record<string, MissionRecord>;
  tasks: Record<string, MissionTaskRecord>;
  leases: Record<string, WorktreeLeaseRecord>;
  executions: Record<string, MissionExecutionRecord>;
  handoffs: Record<string, HandoffRecord>;
  candidates: Record<string, IntegrationCandidateRecord>;
  gates: Record<string, MissionGateRecord>;
  approvals: Record<string, IntegrationApprovalRecord>;
  events: MissionLedgerEvent[];
}

export interface MissionLedgerStoreOptions {
  readonly readText?: ((file: string) => Promise<string>) | undefined;
  readonly writeData?:
    | ((file: string, data: MissionLedgerFileV1) => Promise<void>)
    | undefined;
  readonly now?: (() => Date) | undefined;
}

const TOP_LEVEL_KEYS = new Set([
  'version',
  'revision',
  'missions',
  'tasks',
  'leases',
  'executions',
  'handoffs',
  'candidates',
  'gates',
  'approvals',
  'events',
]);
const MISSION_KEYS = new Set([
  'id',
  'workspaceId',
  'title',
  'objective',
  'phase',
  'taskIds',
  'createdAt',
  'updatedAt',
]);
const TASK_KEYS = new Set([
  'id',
  'missionId',
  'workspaceId',
  'title',
  'description',
  'state',
  'dependsOn',
  'assigneeProfileId',
  'worktreeLeaseId',
  'executionId',
  'handoffIds',
  'activeHandoffId',
  'createdAt',
  'updatedAt',
]);
const LEASE_KEYS = new Set([
  'id',
  'missionId',
  'taskId',
  'workspaceId',
  'branchName',
  'canonicalPath',
  'baseCommitSha',
  'baseTreeSha',
  'state',
  'createdAt',
  'updatedAt',
]);
const EXECUTION_KEYS = new Set([
  'id',
  'missionId',
  'taskId',
  'workspaceId',
  'profileId',
  'providerId',
  'providerResourceId',
  'state',
  'createdAt',
  'updatedAt',
]);
const HANDOFF_KEYS = new Set([
  'id',
  'missionId',
  'taskId',
  'workspaceId',
  'executionId',
  'leaseId',
  'baseCommitSha',
  'commitSha',
  'treeSha',
  'summary',
  'evidence',
  'risks',
  'supersedesHandoffId',
  'createdAt',
]);
const CANDIDATE_KEYS = new Set([
  'id',
  'missionId',
  'workspaceId',
  'targetRef',
  'baseCommitSha',
  'baseTreeSha',
  'commitSha',
  'treeSha',
  'orderedHandoffIds',
  'state',
  'createdAt',
  'integratedAt',
  'integrationCommitSha',
  'integrationTreeSha',
]);
const GATE_KEYS = new Set([
  'id',
  'missionId',
  'workspaceId',
  'candidateId',
  'kind',
  'status',
  'commitSha',
  'treeSha',
  'executorProfileId',
  'evidence',
  'createdAt',
]);
const APPROVAL_KEYS = new Set([
  'id',
  'missionId',
  'workspaceId',
  'candidateId',
  'testGateId',
  'reviewGateId',
  'expectedTargetCommitSha',
  'expectedTargetTreeSha',
  'previewDigest',
  'approvalRevision',
  'status',
  'createdAt',
  'decidedAt',
  'consumedAt',
  'integrationCommitSha',
  'integrationTreeSha',
]);
const EVENT_KEYS = new Set([
  'sequence',
  'kind',
  'missionId',
  'recordId',
  'occurredAt',
]);

const CONTROL = /[\u0000-\u001f\u007f]/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const ID_PATTERNS = {
  mission: /^mission_[A-Za-z0-9_-]{8,96}$/,
  task: /^task_[A-Za-z0-9_-]{8,96}$/,
  lease: /^lease_[A-Za-z0-9_-]{8,96}$/,
  execution: /^execution_[A-Za-z0-9_-]{8,96}$/,
  handoff: /^handoff_[A-Za-z0-9_-]{8,96}$/,
  candidate: /^candidate_[A-Za-z0-9_-]{8,96}$/,
  gate: /^gate_[A-Za-z0-9_-]{8,96}$/,
  approval: /^approval_[A-Za-z0-9_-]{8,96}$/,
} as const;

const MISSION_PHASES = new Set<MissionPhase>([
  'draft',
  'active',
  'blocked',
  'awaiting-approval',
  'integrating',
  'completed',
  'canceled',
]);
const TASK_STATES = new Set<MissionTaskState>([
  'draft',
  'queued',
  'running',
  'blocked',
  'handoff-ready',
  'gating',
  'approved',
  'integrated',
  'failed',
  'canceled',
]);

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function emptyMissionLedgerFile(): MissionLedgerFileV1 {
  return {
    version: MISSION_LEDGER_VERSION,
    revision: 0,
    missions: emptyRecord<MissionRecord>(),
    tasks: emptyRecord<MissionTaskRecord>(),
    leases: emptyRecord<WorktreeLeaseRecord>(),
    executions: emptyRecord<MissionExecutionRecord>(),
    handoffs: emptyRecord<HandoffRecord>(),
    candidates: emptyRecord<IntegrationCandidateRecord>(),
    gates: emptyRecord<MissionGateRecord>(),
    approvals: emptyRecord<IntegrationApprovalRecord>(),
    events: [],
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
    throw new Error(
      `${location} has unexpected field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}`,
    );
  }
}

function integer(value: unknown, location: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${location} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function text(
  value: unknown,
  location: string,
  options: {
    readonly max?: number;
    readonly opaque?: boolean;
    readonly timestamp?: boolean;
    readonly allowEmpty?: boolean;
  } = {},
): string {
  if (typeof value !== 'string') throw new Error(`${location} must be a string`);
  if (options.allowEmpty !== true && value.trim() === '') {
    throw new Error(`${location} must be non-empty`);
  }
  if (value.length > (options.max ?? 8_192)) throw new Error(`${location} is too long`);
  if (CONTROL.test(value)) throw new Error(`${location} contains a control character`);
  if (options.opaque === true && !OPAQUE.test(value)) {
    throw new Error(`${location} must be an opaque identifier`);
  }
  if (options.timestamp === true && !Number.isFinite(Date.parse(value))) {
    throw new Error(`${location} must be a valid timestamp`);
  }
  return value;
}

function optionalText(
  value: Readonly<Record<string, unknown>>,
  key: string,
  location: string,
  options: Parameters<typeof text>[2] = {},
): string | undefined {
  if (!Object.hasOwn(value, key) || value[key] === undefined) return undefined;
  return text(value[key], `${location}.${key}`, options);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  location: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${location} has an unsupported value`);
  }
  return value as T;
}

function id(
  value: unknown,
  kind: keyof typeof ID_PATTERNS,
  location: string,
): string {
  const candidate = text(value, location, { max: 128 });
  if (!ID_PATTERNS[kind].test(candidate)) {
    throw new Error(`${location} is not a valid ${kind} ID`);
  }
  return candidate;
}

function profileId(value: unknown, location: string): string {
  if (!isValidProfileId(value)) throw new Error(`${location} is not a valid profile ID`);
  return value;
}

function gitObjectId(value: unknown, location: string): string {
  const candidate = text(value, location, { max: 64 });
  if (!GIT_OBJECT_ID.test(candidate)) {
    throw new Error(`${location} must be a full lowercase Git object ID`);
  }
  return candidate;
}

function stringArray(
  value: unknown,
  location: string,
  options: { readonly maxItems?: number; readonly maxLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  if (value.length > (options.maxItems ?? 1_000)) {
    throw new Error(`${location} has too many entries`);
  }
  return value.map((entry, index) =>
    text(entry, `${location}[${index}]`, {
      max: options.maxLength ?? 8_192,
    }),
  );
}

function idArray(
  value: unknown,
  kind: keyof typeof ID_PATTERNS,
  location: string,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const values = value.map((entry, index) => id(entry, kind, `${location}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new Error(`${location} must not contain duplicate IDs`);
  }
  return values;
}

function optionalId(
  value: Readonly<Record<string, unknown>>,
  key: string,
  kind: keyof typeof ID_PATTERNS,
  location: string,
): string | undefined {
  if (!Object.hasOwn(value, key) || value[key] === undefined) return undefined;
  return id(value[key], kind, `${location}.${key}`);
}

function parseMission(value: unknown, location: string): MissionRecord {
  const raw = record(value, location);
  onlyKeys(raw, MISSION_KEYS, location);
  return {
    id: id(raw['id'], 'mission', `${location}.id`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    title: text(raw['title'], `${location}.title`, { max: 512 }),
    objective: text(raw['objective'], `${location}.objective`, { max: 20_000 }),
    phase: enumValue(raw['phase'], MISSION_PHASES, `${location}.phase`),
    taskIds: idArray(raw['taskIds'], 'task', `${location}.taskIds`),
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
    updatedAt: text(raw['updatedAt'], `${location}.updatedAt`, {
      max: 128,
      timestamp: true,
    }),
  };
}

function parseTask(value: unknown, location: string): MissionTaskRecord {
  const raw = record(value, location);
  onlyKeys(raw, TASK_KEYS, location);
  const assigneeProfileId =
    Object.hasOwn(raw, 'assigneeProfileId') && raw['assigneeProfileId'] !== undefined
      ? profileId(raw['assigneeProfileId'], `${location}.assigneeProfileId`)
      : undefined;
  const worktreeLeaseId = optionalId(
    raw,
    'worktreeLeaseId',
    'lease',
    location,
  );
  const executionId = optionalId(raw, 'executionId', 'execution', location);
  const activeHandoffId = optionalId(
    raw,
    'activeHandoffId',
    'handoff',
    location,
  );
  return {
    id: id(raw['id'], 'task', `${location}.id`),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    title: text(raw['title'], `${location}.title`, { max: 512 }),
    description: text(raw['description'], `${location}.description`, {
      max: 20_000,
    }),
    state: enumValue(raw['state'], TASK_STATES, `${location}.state`),
    dependsOn: idArray(raw['dependsOn'], 'task', `${location}.dependsOn`),
    ...(assigneeProfileId === undefined ? {} : { assigneeProfileId }),
    ...(worktreeLeaseId === undefined ? {} : { worktreeLeaseId }),
    ...(executionId === undefined ? {} : { executionId }),
    handoffIds: idArray(raw['handoffIds'], 'handoff', `${location}.handoffIds`),
    ...(activeHandoffId === undefined ? {} : { activeHandoffId }),
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
    updatedAt: text(raw['updatedAt'], `${location}.updatedAt`, {
      max: 128,
      timestamp: true,
    }),
  };
}

function parseLease(value: unknown, location: string): WorktreeLeaseRecord {
  const raw = record(value, location);
  onlyKeys(raw, LEASE_KEYS, location);
  const state = enumValue(
    raw['state'],
    new Set(['provisioning', 'ready', 'orphaned', 'released'] as const),
    `${location}.state`,
  );
  const canonicalPath = text(raw['canonicalPath'], `${location}.canonicalPath`);
  if (!path.isAbsolute(canonicalPath)) {
    throw new Error(`${location}.canonicalPath must be absolute`);
  }
  return {
    id: id(raw['id'], 'lease', `${location}.id`),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    taskId: id(raw['taskId'], 'task', `${location}.taskId`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    branchName: text(raw['branchName'], `${location}.branchName`, { max: 512 }),
    canonicalPath,
    baseCommitSha: gitObjectId(raw['baseCommitSha'], `${location}.baseCommitSha`),
    baseTreeSha: gitObjectId(raw['baseTreeSha'], `${location}.baseTreeSha`),
    state,
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
    updatedAt: text(raw['updatedAt'], `${location}.updatedAt`, {
      max: 128,
      timestamp: true,
    }),
  };
}

function parseExecution(
  value: unknown,
  location: string,
): MissionExecutionRecord {
  const raw = record(value, location);
  onlyKeys(raw, EXECUTION_KEYS, location);
  const providerResourceId = optionalText(
    raw,
    'providerResourceId',
    location,
    { max: 2_048 },
  );
  return {
    id: id(raw['id'], 'execution', `${location}.id`),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    taskId: id(raw['taskId'], 'task', `${location}.taskId`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    profileId: profileId(raw['profileId'], `${location}.profileId`),
    providerId: text(raw['providerId'], `${location}.providerId`, {
      max: 128,
      opaque: true,
    }),
    ...(providerResourceId === undefined ? {} : { providerResourceId }),
    state: enumValue(
      raw['state'],
      new Set(['starting', 'running', 'blocked', 'completed', 'failed'] as const),
      `${location}.state`,
    ),
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
    updatedAt: text(raw['updatedAt'], `${location}.updatedAt`, {
      max: 128,
      timestamp: true,
    }),
  };
}

function parseHandoff(value: unknown, location: string): HandoffRecord {
  const raw = record(value, location);
  onlyKeys(raw, HANDOFF_KEYS, location);
  const supersedesHandoffId = optionalId(
    raw,
    'supersedesHandoffId',
    'handoff',
    location,
  );
  return {
    id: id(raw['id'], 'handoff', `${location}.id`),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    taskId: id(raw['taskId'], 'task', `${location}.taskId`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    executionId: id(raw['executionId'], 'execution', `${location}.executionId`),
    leaseId: id(raw['leaseId'], 'lease', `${location}.leaseId`),
    baseCommitSha: gitObjectId(raw['baseCommitSha'], `${location}.baseCommitSha`),
    commitSha: gitObjectId(raw['commitSha'], `${location}.commitSha`),
    treeSha: gitObjectId(raw['treeSha'], `${location}.treeSha`),
    summary: text(raw['summary'], `${location}.summary`, { max: 8_000 }),
    evidence: stringArray(raw['evidence'], `${location}.evidence`, {
      maxItems: 100,
      maxLength: 2_000,
    }),
    risks: stringArray(raw['risks'], `${location}.risks`, {
      maxItems: 100,
      maxLength: 2_000,
    }),
    ...(supersedesHandoffId === undefined ? {} : { supersedesHandoffId }),
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
  };
}

function parseCandidate(
  value: unknown,
  location: string,
): IntegrationCandidateRecord {
  const raw = record(value, location);
  onlyKeys(raw, CANDIDATE_KEYS, location);
  const integratedAt = optionalText(raw, 'integratedAt', location, {
    max: 128,
    timestamp: true,
  });
  const integrationCommitSha =
    Object.hasOwn(raw, 'integrationCommitSha') &&
    raw['integrationCommitSha'] !== undefined
      ? gitObjectId(raw['integrationCommitSha'], `${location}.integrationCommitSha`)
      : undefined;
  const integrationTreeSha =
    Object.hasOwn(raw, 'integrationTreeSha') &&
    raw['integrationTreeSha'] !== undefined
      ? gitObjectId(raw['integrationTreeSha'], `${location}.integrationTreeSha`)
      : undefined;
  return {
    id: id(raw['id'], 'candidate', `${location}.id`),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    targetRef: text(raw['targetRef'], `${location}.targetRef`, { max: 512 }),
    baseCommitSha: gitObjectId(raw['baseCommitSha'], `${location}.baseCommitSha`),
    baseTreeSha: gitObjectId(raw['baseTreeSha'], `${location}.baseTreeSha`),
    commitSha: gitObjectId(raw['commitSha'], `${location}.commitSha`),
    treeSha: gitObjectId(raw['treeSha'], `${location}.treeSha`),
    orderedHandoffIds: idArray(
      raw['orderedHandoffIds'],
      'handoff',
      `${location}.orderedHandoffIds`,
    ),
    state: enumValue(
      raw['state'],
      new Set(['ready', 'integrated', 'superseded'] as const),
      `${location}.state`,
    ),
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
    ...(integratedAt === undefined ? {} : { integratedAt }),
    ...(integrationCommitSha === undefined ? {} : { integrationCommitSha }),
    ...(integrationTreeSha === undefined ? {} : { integrationTreeSha }),
  };
}

function parseGate(value: unknown, location: string): MissionGateRecord {
  const raw = record(value, location);
  onlyKeys(raw, GATE_KEYS, location);
  return {
    id: id(raw['id'], 'gate', `${location}.id`),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    candidateId: id(raw['candidateId'], 'candidate', `${location}.candidateId`),
    kind: enumValue(
      raw['kind'],
      new Set(['test', 'review'] as const),
      `${location}.kind`,
    ),
    status: enumValue(
      raw['status'],
      new Set(['passed', 'failed'] as const),
      `${location}.status`,
    ),
    commitSha: gitObjectId(raw['commitSha'], `${location}.commitSha`),
    treeSha: gitObjectId(raw['treeSha'], `${location}.treeSha`),
    executorProfileId: profileId(
      raw['executorProfileId'],
      `${location}.executorProfileId`,
    ),
    evidence: stringArray(raw['evidence'], `${location}.evidence`, {
      maxItems: 200,
      maxLength: 4_000,
    }),
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
  };
}

function parseApproval(
  value: unknown,
  location: string,
): IntegrationApprovalRecord {
  const raw = record(value, location);
  onlyKeys(raw, APPROVAL_KEYS, location);
  const decidedAt = optionalText(raw, 'decidedAt', location, {
    max: 128,
    timestamp: true,
  });
  const consumedAt = optionalText(raw, 'consumedAt', location, {
    max: 128,
    timestamp: true,
  });
  const integrationCommitSha =
    Object.hasOwn(raw, 'integrationCommitSha') &&
    raw['integrationCommitSha'] !== undefined
      ? gitObjectId(raw['integrationCommitSha'], `${location}.integrationCommitSha`)
      : undefined;
  const integrationTreeSha =
    Object.hasOwn(raw, 'integrationTreeSha') &&
    raw['integrationTreeSha'] !== undefined
      ? gitObjectId(raw['integrationTreeSha'], `${location}.integrationTreeSha`)
      : undefined;
  return {
    id: id(raw['id'], 'approval', `${location}.id`),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    workspaceId: text(raw['workspaceId'], `${location}.workspaceId`, {
      max: 512,
      opaque: true,
    }),
    candidateId: id(raw['candidateId'], 'candidate', `${location}.candidateId`),
    testGateId: id(raw['testGateId'], 'gate', `${location}.testGateId`),
    reviewGateId: id(raw['reviewGateId'], 'gate', `${location}.reviewGateId`),
    expectedTargetCommitSha: gitObjectId(
      raw['expectedTargetCommitSha'],
      `${location}.expectedTargetCommitSha`,
    ),
    expectedTargetTreeSha: gitObjectId(
      raw['expectedTargetTreeSha'],
      `${location}.expectedTargetTreeSha`,
    ),
    previewDigest: (() => {
      const digest = text(raw['previewDigest'], `${location}.previewDigest`, {
        max: 64,
      });
      if (!SHA_256.test(digest)) {
        throw new Error(`${location}.previewDigest must be a SHA-256 digest`);
      }
      return digest;
    })(),
    approvalRevision: integer(
      raw['approvalRevision'],
      `${location}.approvalRevision`,
      1,
    ),
    status: enumValue(
      raw['status'],
      new Set([
        'pending',
        'approved',
        'rejected',
        'consumed',
        'expired',
      ] as const),
      `${location}.status`,
    ),
    createdAt: text(raw['createdAt'], `${location}.createdAt`, {
      max: 128,
      timestamp: true,
    }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(integrationCommitSha === undefined ? {} : { integrationCommitSha }),
    ...(integrationTreeSha === undefined ? {} : { integrationTreeSha }),
  };
}

function parseEvent(
  value: unknown,
  index: number,
  location: string,
): MissionLedgerEvent {
  const raw = record(value, location);
  onlyKeys(raw, EVENT_KEYS, location);
  const sequence = integer(raw['sequence'], `${location}.sequence`, 1);
  if (sequence !== index + 1) {
    throw new Error(`${location}.sequence must be ${index + 1}`);
  }
  return {
    sequence,
    kind: enumValue(
      raw['kind'],
      new Set([
        'mission-created',
        'squad-started',
        'handoff-recorded',
        'candidate-created',
        'gate-recorded',
        'integration-previewed',
        'integration-approved',
        'integration-rejected',
        'integration-consumed',
        'integration-expired',
      ] as const),
      `${location}.kind`,
    ),
    missionId: id(raw['missionId'], 'mission', `${location}.missionId`),
    recordId: text(raw['recordId'], `${location}.recordId`, { max: 128 }),
    occurredAt: text(raw['occurredAt'], `${location}.occurredAt`, {
      max: 128,
      timestamp: true,
    }),
  };
}

function parseMap<T>(
  value: unknown,
  location: string,
  parse: (entry: unknown, entryLocation: string) => T & { readonly id: string },
): Record<string, T> {
  const raw = record(value, location);
  const result = emptyRecord<T>();
  for (const key of Object.keys(raw).sort()) {
    const parsed = parse(raw[key], `${location}.${key}`);
    if (parsed.id !== key) {
      throw new Error(`${location}.${key}.id must match its containing key`);
    }
    result[key] = parsed;
  }
  return result;
}

function requireMission(
  data: MissionLedgerFileV1,
  missionId: string,
  workspaceId: string,
  location: string,
): MissionRecord {
  const mission = data.missions[missionId];
  if (mission === undefined) throw new Error(`${location} references a missing mission`);
  if (mission.workspaceId !== workspaceId) {
    throw new Error(`${location} does not share its mission workspace`);
  }
  return mission;
}

function validateTaskGraph(data: MissionLedgerFileV1): void {
  for (const mission of Object.values(data.missions)) {
    const actual = Object.values(data.tasks)
      .filter((task) => task.missionId === mission.id)
      .map((task) => task.id)
      .sort();
    const declared = [...mission.taskIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) {
      throw new Error(`mission "${mission.id}" taskIds must exactly index its tasks`);
    }
  }

  for (const task of Object.values(data.tasks)) {
    const mission = requireMission(
      data,
      task.missionId,
      task.workspaceId,
      `task "${task.id}"`,
    );
    if (!mission.taskIds.includes(task.id)) {
      throw new Error(`task "${task.id}" is not indexed by its mission`);
    }
    for (const dependencyId of task.dependsOn) {
      const dependency = data.tasks[dependencyId];
      if (dependency === undefined || dependency.missionId !== task.missionId) {
        throw new Error(`task "${task.id}" has a missing or cross-mission dependency`);
      }
      if (dependencyId === task.id) {
        throw new Error(`task "${task.id}" cannot depend on itself`);
      }
    }

    if (task.state === 'draft') {
      if (
        task.assigneeProfileId !== undefined ||
        task.worktreeLeaseId !== undefined ||
        task.executionId !== undefined ||
        task.handoffIds.length > 0 ||
        task.activeHandoffId !== undefined
      ) {
        throw new Error(`draft task "${task.id}" cannot own runtime artifacts`);
      }
    }
    if (task.state === 'queued' && task.assigneeProfileId === undefined) {
      throw new Error(`queued task "${task.id}" requires an assignee`);
    }
    if (
      ['running', 'handoff-ready', 'gating', 'approved', 'integrated'].includes(
        task.state,
      ) &&
      (task.assigneeProfileId === undefined || task.executionId === undefined)
    ) {
      throw new Error(`${task.state} task "${task.id}" requires an exact execution`);
    }
    if (
      ['handoff-ready', 'gating', 'approved', 'integrated'].includes(task.state) &&
      task.activeHandoffId === undefined
    ) {
      throw new Error(`${task.state} task "${task.id}" requires an active handoff`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`task dependency cycle includes "${taskId}"`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of data.tasks[taskId]?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of Object.keys(data.tasks)) visit(taskId);
}

function validateReferences(data: MissionLedgerFileV1): void {
  validateTaskGraph(data);

  for (const lease of Object.values(data.leases)) {
    requireMission(data, lease.missionId, lease.workspaceId, `lease "${lease.id}"`);
    const task = data.tasks[lease.taskId];
    if (
      task === undefined ||
      task.missionId !== lease.missionId ||
      task.worktreeLeaseId !== lease.id
    ) {
      throw new Error(`lease "${lease.id}" is not exactly owned by its task`);
    }
  }

  for (const execution of Object.values(data.executions)) {
    requireMission(
      data,
      execution.missionId,
      execution.workspaceId,
      `execution "${execution.id}"`,
    );
    const task = data.tasks[execution.taskId];
    if (
      task === undefined ||
      task.missionId !== execution.missionId ||
      task.executionId !== execution.id ||
      task.assigneeProfileId !== execution.profileId
    ) {
      throw new Error(`execution "${execution.id}" is not exactly owned by its task`);
    }
    if (
      (execution.state === 'running' || execution.state === 'completed') &&
      execution.providerResourceId === undefined
    ) {
      throw new Error(
        `${execution.state} execution "${execution.id}" requires an exact provider resource`,
      );
    }
  }

  for (const handoff of Object.values(data.handoffs)) {
    requireMission(
      data,
      handoff.missionId,
      handoff.workspaceId,
      `handoff "${handoff.id}"`,
    );
    const task = data.tasks[handoff.taskId];
    const execution = data.executions[handoff.executionId];
    const lease = data.leases[handoff.leaseId];
    if (
      task === undefined ||
      task.missionId !== handoff.missionId ||
      !task.handoffIds.includes(handoff.id) ||
      execution?.taskId !== task.id ||
      lease?.taskId !== task.id ||
      lease.baseCommitSha !== handoff.baseCommitSha
    ) {
      throw new Error(`handoff "${handoff.id}" has inconsistent task ownership`);
    }
    if (
      handoff.supersedesHandoffId !== undefined &&
      data.handoffs[handoff.supersedesHandoffId]?.taskId !== task.id
    ) {
      throw new Error(`handoff "${handoff.id}" supersedes a different or missing task handoff`);
    }
    if (
      task.activeHandoffId !== undefined &&
      !task.handoffIds.includes(task.activeHandoffId)
    ) {
      throw new Error(`task "${task.id}" active handoff is not in its handoff history`);
    }
  }

  for (const candidate of Object.values(data.candidates)) {
    requireMission(
      data,
      candidate.missionId,
      candidate.workspaceId,
      `candidate "${candidate.id}"`,
    );
    if (candidate.orderedHandoffIds.length === 0) {
      throw new Error(`candidate "${candidate.id}" requires at least one handoff`);
    }
    for (const handoffId of candidate.orderedHandoffIds) {
      if (data.handoffs[handoffId]?.missionId !== candidate.missionId) {
        throw new Error(`candidate "${candidate.id}" references a foreign handoff`);
      }
    }
    const hasCompleteIntegration =
      candidate.integratedAt !== undefined &&
      candidate.integrationCommitSha !== undefined &&
      candidate.integrationTreeSha !== undefined;
    if (candidate.state === 'integrated' ? !hasCompleteIntegration : hasCompleteIntegration) {
      throw new Error(`candidate "${candidate.id}" has inconsistent integration fields`);
    }
  }

  for (const gate of Object.values(data.gates)) {
    requireMission(data, gate.missionId, gate.workspaceId, `gate "${gate.id}"`);
    const candidate = data.candidates[gate.candidateId];
    if (
      candidate === undefined ||
      candidate.missionId !== gate.missionId ||
      candidate.commitSha !== gate.commitSha ||
      candidate.treeSha !== gate.treeSha
    ) {
      throw new Error(`gate "${gate.id}" is not bound to its exact candidate commit and tree`);
    }
  }

  for (const approval of Object.values(data.approvals)) {
    requireMission(
      data,
      approval.missionId,
      approval.workspaceId,
      `approval "${approval.id}"`,
    );
    const candidate = data.candidates[approval.candidateId];
    const testGate = data.gates[approval.testGateId];
    const reviewGate = data.gates[approval.reviewGateId];
    if (
      candidate === undefined ||
      candidate.missionId !== approval.missionId ||
      testGate?.candidateId !== candidate.id ||
      testGate.kind !== 'test' ||
      testGate.status !== 'passed' ||
      reviewGate?.candidateId !== candidate.id ||
      reviewGate.kind !== 'review' ||
      reviewGate.status !== 'passed'
    ) {
      throw new Error(`approval "${approval.id}" requires passed Test and Review gates`);
    }
    if (testGate.executorProfileId === reviewGate.executorProfileId) {
      throw new Error(`approval "${approval.id}" requires independent gate executors`);
    }
    if (
      testGate.commitSha !== candidate.commitSha ||
      testGate.treeSha !== candidate.treeSha ||
      reviewGate.commitSha !== candidate.commitSha ||
      reviewGate.treeSha !== candidate.treeSha
    ) {
      throw new Error(`approval "${approval.id}" gates do not cover the exact candidate`);
    }
    if (
      approval.expectedTargetCommitSha !== candidate.baseCommitSha ||
      approval.expectedTargetTreeSha !== candidate.baseTreeSha
    ) {
      throw new Error(`approval "${approval.id}" does not bind the candidate base`);
    }
    if (approval.approvalRevision > data.revision) {
      throw new Error(`approval "${approval.id}" references a future ledger revision`);
    }
    const hasDecision = approval.decidedAt !== undefined;
    const hasConsumption =
      approval.consumedAt !== undefined &&
      approval.integrationCommitSha !== undefined &&
      approval.integrationTreeSha !== undefined;
    if (approval.status === 'pending' && (hasDecision || hasConsumption)) {
      throw new Error(`pending approval "${approval.id}" cannot have a decision`);
    }
    if (approval.status === 'approved' && (!hasDecision || hasConsumption)) {
      throw new Error(`approved approval "${approval.id}" has inconsistent journal fields`);
    }
    if (
      (approval.status === 'rejected' || approval.status === 'expired') &&
      (!hasDecision || hasConsumption)
    ) {
      throw new Error(`${approval.status} approval "${approval.id}" has inconsistent fields`);
    }
    if (approval.status === 'consumed' && (!hasDecision || !hasConsumption)) {
      throw new Error(`consumed approval "${approval.id}" lacks integration evidence`);
    }
  }

  for (const event of data.events) {
    if (data.missions[event.missionId] === undefined) {
      throw new Error(`event ${event.sequence} references a missing mission`);
    }
  }
}

/**
 * Parses the complete ledger all-or-nothing. Partial recovery would make
 * authorization depend on object iteration order, so malformed data remains
 * visible only as a store problem while the last-known-good state is retained.
 */
export function parseMissionLedgerFile(value: unknown): MissionLedgerFileV1 {
  const raw = record(value, 'mission ledger');
  onlyKeys(raw, TOP_LEVEL_KEYS, 'mission ledger');
  if (raw['version'] !== MISSION_LEDGER_VERSION) {
    throw new Error(`mission ledger version must be ${MISSION_LEDGER_VERSION}`);
  }
  const revision = integer(raw['revision'], 'mission ledger.revision');
  const missions = parseMap(raw['missions'], 'mission ledger.missions', parseMission);
  const tasks = parseMap(raw['tasks'], 'mission ledger.tasks', parseTask);
  const leases = parseMap(raw['leases'], 'mission ledger.leases', parseLease);
  const executions = parseMap(
    raw['executions'],
    'mission ledger.executions',
    parseExecution,
  );
  const handoffs = parseMap(raw['handoffs'], 'mission ledger.handoffs', parseHandoff);
  const candidates = parseMap(
    raw['candidates'],
    'mission ledger.candidates',
    parseCandidate,
  );
  const gates = parseMap(raw['gates'], 'mission ledger.gates', parseGate);
  const approvals = parseMap(
    raw['approvals'],
    'mission ledger.approvals',
    parseApproval,
  );
  if (!Array.isArray(raw['events'])) throw new Error('mission ledger.events must be an array');
  const events = raw['events'].map((entry, index) =>
    parseEvent(entry, index, `mission ledger.events[${index}]`),
  );
  const parsed: MissionLedgerFileV1 = {
    version: MISSION_LEDGER_VERSION,
    revision,
    missions,
    tasks,
    leases,
    executions,
    handoffs,
    candidates,
    gates,
    approvals,
    events,
  };
  validateReferences(parsed);
  return parsed;
}

function cloneMutable(data: MissionLedgerFileV1): MutableMissionLedger {
  return structuredClone(data) as MutableMissionLedger;
}

function cloneData(data: MissionLedgerFileV1): MissionLedgerFileV1 {
  return structuredClone(data) as MissionLedgerFileV1;
}

function orderedRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  const result = emptyRecord<T>();
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function orderedData(data: MissionLedgerFileV1): MissionLedgerFileV1 {
  return {
    version: MISSION_LEDGER_VERSION,
    revision: data.revision,
    missions: orderedRecord(data.missions),
    tasks: orderedRecord(data.tasks),
    leases: orderedRecord(data.leases),
    executions: orderedRecord(data.executions),
    handoffs: orderedRecord(data.handoffs),
    candidates: orderedRecord(data.candidates),
    gates: orderedRecord(data.gates),
    approvals: orderedRecord(data.approvals),
    events: [...data.events],
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export class MissionLedgerStoreBlockedError extends Error {
  override readonly name = 'MissionLedgerStoreBlockedError';

  constructor(readonly problem: MissionLedgerStoreProblem) {
    super(`Refusing to overwrite ${problem.file}: ${problem.message}`);
  }
}

export class MissionLedgerRevisionError extends Error {
  override readonly name = 'MissionLedgerRevisionError';

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Mission ledger changed: expected revision ${expectedRevision}, current revision is ${actualRevision}`,
    );
  }
}

export class MissionLedgerStore {
  private dataValue = emptyMissionLedgerFile();
  private problemValue: MissionLedgerStoreProblem | undefined;
  private loadedValue = false;
  private fileExistsValue = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly readText: (file: string) => Promise<string>;
  private readonly writeData: (
    file: string,
    data: MissionLedgerFileV1,
  ) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    readonly file: string,
    options: MissionLedgerStoreOptions = {},
  ) {
    if (!path.isAbsolute(file)) {
      throw new TypeError('Mission ledger path must be absolute.');
    }
    this.readText = options.readText ?? ((target) => nodeReadFile(target, 'utf8'));
    this.writeData =
      options.writeData ?? ((target, data) => writeJsonAtomic(target, data));
    this.now = options.now ?? (() => new Date());
  }

  get state(): MissionLedgerStoreState {
    return {
      file: this.file,
      loaded: this.loadedValue,
      fileExists: this.fileExistsValue,
      data: cloneData(this.dataValue),
      problem:
        this.problemValue === undefined ? undefined : { ...this.problemValue },
    };
  }

  get problem(): MissionLedgerStoreProblem | undefined {
    return this.problemValue === undefined ? undefined : { ...this.problemValue };
  }

  load(): Promise<MissionLedgerStoreState> {
    return this.enqueue(async () => {
      await this.reloadUnlocked();
      return this.state;
    });
  }

  reload(): Promise<MissionLedgerStoreState> {
    return this.load();
  }

  transact<T>(
    expectedRevision: number,
    operation: (draft: MutableMissionLedger) => T | Promise<T>,
  ): Promise<{ readonly value: T; readonly revision: number }> {
    return this.enqueue(async () => {
      await this.reloadUnlocked();
      if (this.problemValue !== undefined) {
        throw new MissionLedgerStoreBlockedError({ ...this.problemValue });
      }
      if (this.dataValue.revision !== expectedRevision) {
        throw new MissionLedgerRevisionError(
          expectedRevision,
          this.dataValue.revision,
        );
      }

      const draft = cloneMutable(this.dataValue);
      const value = await operation(draft);
      draft.version = MISSION_LEDGER_VERSION;
      draft.revision = expectedRevision + 1;
      const parsed = orderedData(parseMissionLedgerFile(draft));

      try {
        await this.writeData(this.file, parsed);
      } catch (error) {
        this.problemValue = this.makeProblem('write', error);
        throw error;
      }

      this.dataValue = parsed;
      this.fileExistsValue = true;
      this.loadedValue = true;
      this.problemValue = undefined;
      return { value, revision: parsed.revision };
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
    let source: string;
    try {
      source = await this.readText(this.file);
      this.fileExistsValue = true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.dataValue = emptyMissionLedgerFile();
        this.problemValue = undefined;
        this.loadedValue = true;
        this.fileExistsValue = false;
        return;
      }
      this.problemValue = this.makeProblem('read', error);
      this.loadedValue = true;
      return;
    }

    try {
      this.dataValue = parseMissionLedgerFile(JSON.parse(source) as unknown);
      this.problemValue = undefined;
      this.loadedValue = true;
    } catch (error) {
      this.problemValue = this.makeProblem('parse', error);
      this.loadedValue = true;
    }
  }

  private makeProblem(
    kind: MissionLedgerStoreProblemKind,
    error: unknown,
  ): MissionLedgerStoreProblem {
    return {
      kind,
      file: this.file,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: this.now().toISOString(),
    };
  }
}
