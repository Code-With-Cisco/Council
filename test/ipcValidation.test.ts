import { describe, expect, it } from 'vitest';
import {
  MAX_COUNCIL_QUESTION_LENGTH,
  MAX_PROFILE_ID_LENGTH,
  MAX_REPLY_LENGTH,
  validateCouncilQuestion,
  validateProfileId,
  validateReplyText,
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
});
