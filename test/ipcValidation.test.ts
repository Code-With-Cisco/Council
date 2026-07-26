import { describe, expect, it } from 'vitest';
import {
  MAX_COUNCIL_QUESTION_LENGTH,
  MAX_MISSION_OBJECTIVE_LENGTH,
  MAX_PROFILE_ID_LENGTH,
  MAX_REPLY_LENGTH,
  validateCouncilQuestion,
  validateCreateCandidateInput,
  validateCreateMissionInput,
  validateMissionDigest,
  validatePreviewIntegrationInput,
  validatePreviewSquadInput,
  validateRecordGateInput,
  validateRecordHandoffInput,
  validateProfileId,
  validateReplyText,
  validateRetryMissionExecutionInput,
} from '../src/ui/ipcValidation.js';

describe('IPC privileged-boundary validation', () => {
  it('accepts only bounded opaque profile IDs', () => {
    expect(validateProfileId('profile-12345678')).toBe('profile-12345678');
    expect(validateProfileId('raw-provider-session')).toBeUndefined();
    expect(validateProfileId('profile-short')).toBeUndefined();
    expect(validateProfileId(`profile-${'a'.repeat(MAX_PROFILE_ID_LENGTH)}`)).toBeUndefined();
    expect(validateProfileId(123)).toBeUndefined();
  });

  it('keeps one-line reply values bounded and control-free', () => {
    expect(validateReplyText('ordinary answer')).toBe('ordinary answer');
    expect(validateReplyText('line one\nline two')).toBeUndefined();
    expect(validateReplyText(`x${'\u0000'}y`)).toBeUndefined();
    expect(validateReplyText('x'.repeat(MAX_REPLY_LENGTH + 1))).toBeUndefined();
  });

  it('allows useful multiline Council questions but rejects control bytes and oversize', () => {
    expect(validateCouncilQuestion('Compare:\n- A\n- B')).toBe('Compare:\n- A\n- B');
    expect(validateCouncilQuestion(`bad\u0000question`)).toBeUndefined();
    expect(validateCouncilQuestion('x'.repeat(MAX_COUNCIL_QUESTION_LENGTH + 1))).toBeUndefined();
  });

  it('accepts bounded Mission prose and rejects renderer-supplied authority fields', () => {
    const input = {
      expectedRevision: 4,
      title: 'Ship provider-neutral missions',
      objective: 'Coordinate exact handoffs.\nPreserve Milestone 1.',
      tasks: [{ title: 'Implement UI', description: 'Use the typed port.' }],
    };
    expect(validateCreateMissionInput(input)).toEqual(input);
    expect(
      validateCreateMissionInput({ ...input, cwd: '/tmp/escape' }),
    ).toBeUndefined();
    expect(
      validateCreateMissionInput({
        ...input,
        objective: 'x'.repeat(MAX_MISSION_OBJECTIVE_LENGTH + 1),
      }),
    ).toBeUndefined();
  });

  it('requires opaque IDs, explicit providers, exact fingerprints, and unique assignments', () => {
    const selection = {
      taskId: 'task_123',
      profileId: 'profile-12345678',
      providerId: 'codex',
      expectedDefinitionFingerprint: 'a'.repeat(64),
      writeCapable: true,
    };
    const testSelection = {
      ...selection,
      taskId: 'task_test123',
      profileId: 'profile-test0001',
      providerId: 'claude-code' as const,
      expectedDefinitionFingerprint: 'b'.repeat(64),
      writeCapable: false,
    };
    const reviewSelection = {
      ...selection,
      taskId: 'task_review123',
      profileId: 'profile-review01',
      expectedDefinitionFingerprint: 'c'.repeat(64),
      writeCapable: false,
    };
    const input = {
      missionId: 'mission_123',
      expectedRevision: 5,
      selections: [selection, testSelection, reviewSelection],
      gateAssignments: {
        testProfileId: testSelection.profileId,
        reviewProfileId: reviewSelection.profileId,
      },
    };
    expect(validatePreviewSquadInput(input)).toEqual(input);
    expect(
      validatePreviewSquadInput({
        ...input,
        selections: [
          { ...selection, providerId: 'raw-cli' },
          testSelection,
          reviewSelection,
        ],
      }),
    ).toBeUndefined();
    expect(
      validatePreviewSquadInput({
        ...input,
        selections: [
          { ...selection, argv: ['--dangerous'] },
          testSelection,
          reviewSelection,
        ],
      }),
    ).toBeUndefined();
    expect(
      validatePreviewSquadInput({
        ...input,
        selections: [
          selection,
          { ...selection },
          testSelection,
          reviewSelection,
        ],
      }),
    ).toBeUndefined();
    expect(
      validatePreviewSquadInput({
        ...input,
        gateAssignments: {
          testProfileId: testSelection.profileId,
          reviewProfileId: testSelection.profileId,
        },
      }),
    ).toBeUndefined();
    expect(
      validatePreviewSquadInput({
        ...input,
        gateAssignments: {
          testProfileId: selection.profileId,
          reviewProfileId: reviewSelection.profileId,
        },
      }),
    ).toBeUndefined();
  });

  it('allows only a bounded integration identity or a SHA-256 preview digest', () => {
    const input = {
      missionId: 'mission_123',
      candidateId: 'candidate_456',
      expectedRevision: 8,
    };
    expect(validatePreviewIntegrationInput(input)).toEqual(input);
    expect(
      validatePreviewIntegrationInput({
        ...input,
        targetRef: 'refs/heads/main',
      }),
    ).toBeUndefined();
    expect(validateMissionDigest('f'.repeat(64))).toBe('f'.repeat(64));
    expect(validateMissionDigest('deadbeef')).toBeUndefined();
  });

  it('accepts exact handoff claims but no renderer-supplied filesystem authority', () => {
    const input = {
      expectedRevision: 9,
      taskId: 'task_123',
      executionId: 'execution_123',
      claimedCommitSha: 'a'.repeat(40),
      claimedTreeSha: 'b'.repeat(40),
      summary: 'Implemented and verified.',
      evidence: ['focused tests passed'],
      risks: [],
    };
    expect(validateRecordHandoffInput(input)).toEqual(input);
    expect(
      validateRecordHandoffInput({ ...input, cwd: '/tmp/worktree' }),
    ).toBeUndefined();
    expect(
      validateRecordHandoffInput({
        ...input,
        claimedCommitSha: 'not-full',
      }),
    ).toBeUndefined();
  });

  it('retries only an opaque execution at an exact non-negative revision', () => {
    const input = {
      expectedRevision: 12,
      executionId: 'execution_123',
    };
    expect(validateRetryMissionExecutionInput(input)).toEqual(input);
    expect(
      validateRetryMissionExecutionInput({
        ...input,
        providerId: 'codex',
      }),
    ).toBeUndefined();
    expect(
      validateRetryMissionExecutionInput({
        ...input,
        cwd: '/tmp/untrusted',
      }),
    ).toBeUndefined();
    expect(
      validateRetryMissionExecutionInput({
        ...input,
        executionId: 'native-provider-id',
      }),
    ).toBeUndefined();
    expect(
      validateRetryMissionExecutionInput({
        ...input,
        expectedRevision: -1,
      }),
    ).toBeUndefined();
  });

  it('builds candidates only from ordered opaque handoffs and never a renderer target ref', () => {
    const input = {
      expectedRevision: 10,
      missionId: 'mission_123',
      orderedHandoffIds: ['handoff_123', 'handoff_456'],
    };
    expect(validateCreateCandidateInput(input)).toEqual(input);
    expect(
      validateCreateCandidateInput({
        ...input,
        targetRef: 'refs/heads/main',
      }),
    ).toBeUndefined();
    expect(
      validateCreateCandidateInput({
        ...input,
        orderedHandoffIds: ['handoff_123', 'handoff_123'],
      }),
    ).toBeUndefined();
  });

  it('lets the renderer choose a gate plan but never self-certify its result or evidence', () => {
    const input = {
      expectedRevision: 11,
      candidateId: 'candidate_123',
      kind: 'test',
      commandIds: ['typecheck', 'unit:test'],
      gatePolicyFingerprint: 'c'.repeat(64),
      executorProfileId: 'profile-12345678',
    };
    expect(validateRecordGateInput(input)).toEqual(input);
    expect(
      validateRecordGateInput({
        ...input,
        status: 'passed',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        evidence: ['renderer says it passed'],
      }),
    ).toBeUndefined();
    expect(
      validateRecordGateInput({ ...input, commandIds: ['npm test; rm'] }),
    ).toBeUndefined();
  });
});
