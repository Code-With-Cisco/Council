export const MAX_PROFILE_ID_LENGTH = 160;

const PROFILE_ID = /^profile-[A-Za-z0-9_-]{8,}$/;

export type GeneratedProfileKind = 'virtual' | 'internal';

export function isValidProfileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PROFILE_ID_LENGTH &&
    PROFILE_ID.test(value)
  );
}

export function generatedProfileKind(
  value: string,
): GeneratedProfileKind | undefined {
  if (value.startsWith('profile-virtual-')) return 'virtual';
  if (value.startsWith('profile-internal-')) return 'internal';
  return undefined;
}
