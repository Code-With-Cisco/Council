import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiagnosticJournal } from '../src/ui/diagnosticJournal.js';

describe('DiagnosticJournal', () => {
  it('bounds unsafe detail and redacts common secret forms', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'council-diagnostic-'));
    const journal = new DiagnosticJournal(directory);
    await journal.record({
      id: 'mission-deadbeef',
      occurredAt: new Date(0).toISOString(),
      operation: 'create draft',
      code: 'unexpected',
      errorName: 'Error',
      message: `authorization: Bearer secret-value api_key=second-secret sk-proj-1234567890\u0001${'x'.repeat(9000)}`,
    });
    const output = await readFile(journal.file, 'utf8');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('second-secret');
    expect(output).not.toContain('sk-proj-1234567890');
    expect(output).toContain('[redacted]');
    expect(output.length).toBeLessThan(8500);
  });
});
