import {
  MAX_PROFILE_ID_LENGTH,
  isValidProfileId,
} from '../profileIdentity.js';
import type {
  UiCreateCandidateInput,
  UiCreateMissionInput,
  UiPreviewIntegrationInput,
  UiPreviewSquadInput,
  UiRecordGateInput,
  UiRecordHandoffInput,
  UiRetryMissionExecutionInput,
  UiSquadSelection,
} from './missionUi.js';

export { MAX_PROFILE_ID_LENGTH };
export const MAX_REPLY_LENGTH = 8_000;
export const MAX_INITIAL_MESSAGE_LENGTH = 20_000;
export const MAX_COUNCIL_QUESTION_LENGTH = 20_000;
export const MAX_MISSION_TITLE_LENGTH = 512;
export const MAX_MISSION_OBJECTIVE_LENGTH = 20_000;
export const MAX_MISSION_TASKS = 64;
export const MAX_MISSION_EVIDENCE_ITEMS = 32;
export const MAX_MISSION_EVIDENCE_LENGTH = 2_000;

const DEFINITION_FINGERPRINT = /^[0-9a-f]{64}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const MISSION_ID = /^mission[_-][A-Za-z0-9_-]{1,500}$/;
const TASK_ID = /^task[_-][A-Za-z0-9_-]{1,500}$/;
const CANDIDATE_ID = /^candidate[_-][A-Za-z0-9_-]{1,500}$/;
const EXECUTION_ID = /^execution[_-][A-Za-z0-9_-]{1,500}$/;
const HANDOFF_ID = /^handoff[_-][A-Za-z0-9_-]{1,500}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GATE_COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
const UNSAFE_MULTILINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function revision(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function boundedText(
  value: unknown,
  maxLength: number,
  multiline: boolean,
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > maxLength ||
    (multiline ? UNSAFE_MULTILINE_CONTROL : ANY_CONTROL).test(value)
  ) {
    return undefined;
  }
  return value;
}

function boundedTextList(
  value: unknown,
  maxItems = MAX_MISSION_EVIDENCE_ITEMS,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const values: string[] = [];
  for (const item of value) {
    const text = boundedText(item, MAX_MISSION_EVIDENCE_LENGTH, true);
    if (text === undefined) return undefined;
    values.push(text);
  }
  return values;
}

export function validateProfileId(value: unknown): string | undefined {
  return isValidProfileId(value) ? value : undefined;
}

export function validateDefinitionFingerprint(
  value: unknown,
): string | undefined {
  return typeof value === 'string' && DEFINITION_FINGERPRINT.test(value)
    ? value
    : undefined;
}

export function validateReplyText(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > MAX_REPLY_LENGTH ||
    ANY_CONTROL.test(value)
  ) {
    return undefined;
  }
  return value;
}

export function validateInitialMessage(value: unknown): string | undefined {
  return boundedText(value, MAX_INITIAL_MESSAGE_LENGTH, true);
}

export function validateCouncilQuestion(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > MAX_COUNCIL_QUESTION_LENGTH ||
    UNSAFE_MULTILINE_CONTROL.test(value)
  ) {
    return undefined;
  }
  return value;
}

export function validateMissionDigest(value: unknown): string | undefined {
  return typeof value === 'string' && SHA_256.test(value) ? value : undefined;
}

export function validateCreateMissionInput(
  value: unknown,
): UiCreateMissionInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(['expectedRevision', 'title', 'objective', 'tasks']),
    )
  ) {
    return undefined;
  }
  const expectedRevision = revision(value['expectedRevision']);
  const title = boundedText(
    value['title'],
    MAX_MISSION_TITLE_LENGTH,
    false,
  );
  const objective = boundedText(
    value['objective'],
    MAX_MISSION_OBJECTIVE_LENGTH,
    true,
  );
  const rawTasks = value['tasks'];
  if (
    expectedRevision === undefined ||
    title === undefined ||
    objective === undefined ||
    !Array.isArray(rawTasks) ||
    rawTasks.length === 0 ||
    rawTasks.length > MAX_MISSION_TASKS
  ) {
    return undefined;
  }
  const tasks: { title: string; description: string }[] = [];
  for (const rawTask of rawTasks) {
    if (
      !isRecord(rawTask) ||
      !hasOnlyKeys(rawTask, new Set(['title', 'description']))
    ) {
      return undefined;
    }
    const taskTitle = boundedText(
      rawTask['title'],
      MAX_MISSION_TITLE_LENGTH,
      false,
    );
    const description = boundedText(
      rawTask['description'],
      MAX_MISSION_OBJECTIVE_LENGTH,
      true,
    );
    if (taskTitle === undefined || description === undefined) return undefined;
    tasks.push({ title: taskTitle, description });
  }
  return { expectedRevision, title, objective, tasks };
}

function validateSquadSelection(value: unknown): UiSquadSelection | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        'taskId',
        'profileId',
        'providerId',
        'expectedDefinitionFingerprint',
        'writeCapable',
      ]),
    )
  ) {
    return undefined;
  }
  const taskId =
    typeof value['taskId'] === 'string' && TASK_ID.test(value['taskId'])
      ? value['taskId']
      : undefined;
  const profileId = validateProfileId(value['profileId']);
  const providerId =
    value['providerId'] === 'claude-code' || value['providerId'] === 'codex'
      ? value['providerId']
      : undefined;
  const expectedDefinitionFingerprint = validateDefinitionFingerprint(
    value['expectedDefinitionFingerprint'],
  );
  if (
    taskId === undefined ||
    profileId === undefined ||
    providerId === undefined ||
    expectedDefinitionFingerprint === undefined ||
    typeof value['writeCapable'] !== 'boolean'
  ) {
    return undefined;
  }
  return {
    taskId,
    profileId,
    providerId,
    expectedDefinitionFingerprint,
    writeCapable: value['writeCapable'],
  };
}

export function validatePreviewSquadInput(
  value: unknown,
): UiPreviewSquadInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        'missionId',
        'expectedRevision',
        'selections',
        'gateAssignments',
      ]),
    )
  ) {
    return undefined;
  }
  const missionId =
    typeof value['missionId'] === 'string' &&
    MISSION_ID.test(value['missionId'])
      ? value['missionId']
      : undefined;
  const expectedRevision = revision(value['expectedRevision']);
  const rawSelections = value['selections'];
  if (
    missionId === undefined ||
    expectedRevision === undefined ||
    !Array.isArray(rawSelections) ||
    rawSelections.length === 0 ||
    rawSelections.length > MAX_MISSION_TASKS
  ) {
    return undefined;
  }
  const selections: UiSquadSelection[] = [];
  for (const rawSelection of rawSelections) {
    const selection = validateSquadSelection(rawSelection);
    if (selection === undefined) return undefined;
    selections.push(selection);
  }
  if (
    new Set(selections.map((selection) => selection.taskId)).size !==
      selections.length ||
    new Set(selections.map((selection) => selection.profileId)).size !==
      selections.length
  ) {
    return undefined;
  }
  const rawGateAssignments = value['gateAssignments'];
  if (
    !isRecord(rawGateAssignments) ||
    !hasOnlyKeys(
      rawGateAssignments,
      new Set(['testProfileId', 'reviewProfileId']),
    )
  ) {
    return undefined;
  }
  const testProfileId = validateProfileId(
    rawGateAssignments['testProfileId'],
  );
  const reviewProfileId = validateProfileId(
    rawGateAssignments['reviewProfileId'],
  );
  if (
    testProfileId === undefined ||
    reviewProfileId === undefined ||
    testProfileId === reviewProfileId
  ) {
    return undefined;
  }
  const selectionByProfile = new Map(
    selections.map((selection) => [selection.profileId, selection]),
  );
  if (
    selectionByProfile.get(testProfileId)?.writeCapable !== false ||
    selectionByProfile.get(reviewProfileId)?.writeCapable !== false
  ) {
    return undefined;
  }
  return {
    missionId,
    expectedRevision,
    selections,
    gateAssignments: { testProfileId, reviewProfileId },
  };
}

export function validatePreviewIntegrationInput(
  value: unknown,
): UiPreviewIntegrationInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(['missionId', 'candidateId', 'expectedRevision']),
    )
  ) {
    return undefined;
  }
  const missionId =
    typeof value['missionId'] === 'string' &&
    MISSION_ID.test(value['missionId'])
      ? value['missionId']
      : undefined;
  const candidateId =
    typeof value['candidateId'] === 'string' &&
    CANDIDATE_ID.test(value['candidateId'])
      ? value['candidateId']
      : undefined;
  const expectedRevision = revision(value['expectedRevision']);
  return missionId === undefined ||
    candidateId === undefined ||
    expectedRevision === undefined
    ? undefined
    : { missionId, candidateId, expectedRevision };
}

export function validateRecordHandoffInput(
  value: unknown,
): UiRecordHandoffInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        'expectedRevision',
        'taskId',
        'executionId',
        'claimedCommitSha',
        'claimedTreeSha',
        'summary',
        'evidence',
        'risks',
        'supersedesHandoffId',
      ]),
    )
  ) {
    return undefined;
  }
  const expectedRevision = revision(value['expectedRevision']);
  const taskId =
    typeof value['taskId'] === 'string' && TASK_ID.test(value['taskId'])
      ? value['taskId']
      : undefined;
  const executionId =
    typeof value['executionId'] === 'string' &&
    EXECUTION_ID.test(value['executionId'])
      ? value['executionId']
      : undefined;
  const claimedCommitSha =
    typeof value['claimedCommitSha'] === 'string' &&
    GIT_OBJECT_ID.test(value['claimedCommitSha'])
      ? value['claimedCommitSha']
      : undefined;
  const claimedTreeSha =
    typeof value['claimedTreeSha'] === 'string' &&
    GIT_OBJECT_ID.test(value['claimedTreeSha'])
      ? value['claimedTreeSha']
      : undefined;
  const summary = boundedText(value['summary'], 8_000, true);
  const evidence = boundedTextList(value['evidence']);
  const risks = boundedTextList(value['risks']);
  const rawSupersedes = value['supersedesHandoffId'];
  const supersedesHandoffId =
    rawSupersedes === undefined
      ? undefined
      : typeof rawSupersedes === 'string' && HANDOFF_ID.test(rawSupersedes)
        ? rawSupersedes
        : null;
  if (
    expectedRevision === undefined ||
    taskId === undefined ||
    executionId === undefined ||
    claimedCommitSha === undefined ||
    claimedTreeSha === undefined ||
    summary === undefined ||
    evidence === undefined ||
    risks === undefined ||
    supersedesHandoffId === null
  ) {
    return undefined;
  }
  return {
    expectedRevision,
    taskId,
    executionId,
    claimedCommitSha,
    claimedTreeSha,
    summary,
    evidence,
    risks,
    ...(supersedesHandoffId === undefined ? {} : { supersedesHandoffId }),
  };
}

export function validateRetryMissionExecutionInput(
  value: unknown,
): UiRetryMissionExecutionInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['expectedRevision', 'executionId']))
  ) {
    return undefined;
  }
  const expectedRevision = revision(value['expectedRevision']);
  const executionId =
    typeof value['executionId'] === 'string' &&
    EXECUTION_ID.test(value['executionId'])
      ? value['executionId']
      : undefined;
  return expectedRevision === undefined || executionId === undefined
    ? undefined
    : { expectedRevision, executionId };
}

export function validateCreateCandidateInput(
  value: unknown,
): UiCreateCandidateInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(['expectedRevision', 'missionId', 'orderedHandoffIds']),
    )
  ) {
    return undefined;
  }
  const expectedRevision = revision(value['expectedRevision']);
  const missionId =
    typeof value['missionId'] === 'string' &&
    MISSION_ID.test(value['missionId'])
      ? value['missionId']
      : undefined;
  const rawHandoffs = value['orderedHandoffIds'];
  if (
    expectedRevision === undefined ||
    missionId === undefined ||
    !Array.isArray(rawHandoffs) ||
    rawHandoffs.length === 0 ||
    rawHandoffs.length > MAX_MISSION_TASKS ||
    rawHandoffs.some(
      (handoffId) =>
        typeof handoffId !== 'string' || !HANDOFF_ID.test(handoffId),
    ) ||
    new Set(rawHandoffs).size !== rawHandoffs.length
  ) {
    return undefined;
  }
  return {
    expectedRevision,
    missionId,
    orderedHandoffIds: rawHandoffs,
  };
}

export function validateRecordGateInput(
  value: unknown,
): UiRecordGateInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        'expectedRevision',
        'candidateId',
        'kind',
        'commandIds',
        'gatePolicyFingerprint',
        'executorProfileId',
      ]),
    )
  ) {
    return undefined;
  }
  const expectedRevision = revision(value['expectedRevision']);
  const candidateId =
    typeof value['candidateId'] === 'string' &&
    CANDIDATE_ID.test(value['candidateId'])
      ? value['candidateId']
      : undefined;
  const kind =
    value['kind'] === 'test' || value['kind'] === 'review'
      ? value['kind']
      : undefined;
  const commandIds =
    Array.isArray(value['commandIds']) &&
    value['commandIds'].length <= MAX_MISSION_EVIDENCE_ITEMS &&
    value['commandIds'].every(
      (commandId) =>
        typeof commandId === 'string' && GATE_COMMAND_ID.test(commandId),
    ) &&
    new Set(value['commandIds']).size === value['commandIds'].length
      ? value['commandIds']
      : undefined;
  const gatePolicyFingerprint = validateMissionDigest(
    value['gatePolicyFingerprint'],
  );
  const executorProfileId = validateProfileId(value['executorProfileId']);
  if (
    expectedRevision === undefined ||
    candidateId === undefined ||
    kind === undefined ||
    commandIds === undefined ||
    (kind === 'test' && commandIds.length === 0) ||
    gatePolicyFingerprint === undefined ||
    executorProfileId === undefined
  ) {
    return undefined;
  }
  return {
    expectedRevision,
    candidateId,
    kind,
    commandIds,
    gatePolicyFingerprint,
    executorProfileId,
  };
}
