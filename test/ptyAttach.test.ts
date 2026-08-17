import { describe, expect, it } from 'vitest';
import {
  describePtySpawnError,
  isReplyTuiReady,
} from '../src/integration/pty/attach.js';

describe('headless reply readiness', () => {
  it('requires observed terminal output followed by a quiet period', () => {
    expect(isReplyTuiReady(false, 0, 10_000)).toBe(false);
    expect(isReplyTuiReady(true, 9_700, 10_000)).toBe(false);
    expect(isReplyTuiReady(true, 9_600, 10_000)).toBe(true);
  });

  it('turns the opaque Windows PTY file error into an actionable unsent-message failure', () => {
    const message = describePtySpawnError(new Error('File not found.'));
    expect(message).toContain('bound repository');
    expect(message).toContain('message was not sent');
  });
});
