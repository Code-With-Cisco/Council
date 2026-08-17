import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePathExecutable } from '../src/integration/cli/locate.js';

describe('Claude PATH resolution', () => {
  it('stabilizes a PATH-discovered command as an absolute executable path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'council-claude-path-'));
    const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const expected = path.join(directory, executable);
    await writeFile(expected, 'test executable');
    const env = process.platform === 'win32'
      ? { Path: directory }
      : { PATH: directory };

    expect(await resolvePathExecutable(executable, env)).toBe(expected);
  });
});
