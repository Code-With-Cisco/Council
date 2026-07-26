import {
  MAX_PROFILE_ID_LENGTH,
  isValidProfileId,
} from '../profileIdentity.js';

export { MAX_PROFILE_ID_LENGTH };
export const MAX_REPLY_LENGTH = 8_000;
export const MAX_COUNCIL_QUESTION_LENGTH = 20_000;

const DEFINITION_FINGERPRINT = /^[0-9a-f]{64}$/;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
const UNSAFE_MULTILINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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
