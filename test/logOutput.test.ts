import { describe, expect, it } from 'vitest';
import { sanitizeTerminalOutput } from '../src/ui/logOutput.js';

describe('renderer-safe terminal output', () => {
  it('strips ANSI, OSC titles, cursor commands, and unsafe controls', () => {
    expect(
      sanitizeTerminalOutput(
        '\u001b[31mred\u001b[0m\r\n\u001b]0;secret title\u0007next\u001b[2J\u0000',
      ),
    ).toBe('red\nnext');
  });

  it('retains a bounded tail instead of an unbounded transcript', () => {
    const result = sanitizeTerminalOutput(`first\n${'x'.repeat(150 * 1024)}`);
    expect(result).toContain('Earlier output omitted');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(129 * 1024);
    expect(result).not.toContain('first');
  });
});
