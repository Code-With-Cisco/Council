import { describe, expect, it } from 'vitest';
import { isReplyTuiReady } from '../src/integration/pty/attach.js';

describe('headless reply readiness', () => {
  it('requires observed terminal output followed by a quiet period', () => {
    expect(isReplyTuiReady(false, 0, 10_000)).toBe(false);
    expect(isReplyTuiReady(true, 9_700, 10_000)).toBe(false);
    expect(isReplyTuiReady(true, 9_600, 10_000)).toBe(true);
  });
});
