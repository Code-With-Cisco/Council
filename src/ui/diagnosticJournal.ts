import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_MESSAGE_LENGTH = 8_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SECRET = /(?:\b(?:sk-ant|sk-proj|sess|key)-[A-Za-z0-9_-]{8,}\b|\b(?:authorization:\s*bearer|api[_-]?key\s*[=:])\s*[^\s,;]+)/gi;

export interface DiagnosticJournalEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly operation: string;
  readonly code: string;
  readonly errorName: string;
  readonly message: string;
}

function bounded(value: string): string {
  return value
    .replace(CONTROL, '?')
    .replace(SECRET, '[redacted]')
    .slice(0, MAX_MESSAGE_LENGTH);
}

/** Bounded local-only diagnostics. Nothing in this file is sent to the renderer. */
export class DiagnosticJournal {
  readonly file: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(userData: string) {
    this.file = path.join(userData, 'diagnostics', 'mission-errors.jsonl');
  }

  record(entry: DiagnosticJournalEntry): Promise<void> {
    const safe: DiagnosticJournalEntry = {
      ...entry,
      operation: bounded(entry.operation),
      code: bounded(entry.code),
      errorName: bounded(entry.errorName),
      message: bounded(entry.message),
    };
    this.tail = this.tail.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const size = await stat(this.file).then((value) => value.size).catch(() => 0);
      if (size >= MAX_FILE_BYTES) {
        const previous = `${this.file}.previous`;
        await unlink(previous).catch(() => undefined);
        await rename(this.file, previous);
      }
      await appendFile(this.file, `${JSON.stringify(safe)}\n`, 'utf8');
    }).catch(() => undefined);
    return this.tail;
  }
}
