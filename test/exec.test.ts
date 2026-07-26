import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: childProcess.spawn,
}));

import { runClaude } from '../src/integration/cli/exec.js';

function successfulChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.end('backgrounded');
    child.stderr.end();
    child.emit('close', 0);
  });
  return child;
}

afterEach(() => {
  childProcess.spawn.mockReset();
});

describe('Claude process execution boundary', () => {
  it('passes injection-shaped text as one argv element with shell false', async () => {
    childProcess.spawn.mockImplementation(() => successfulChild());
    const prompt =
      'Review "C:\\Program Files\\Council"; Remove-Item remains ordinary text.';

    const result = await runClaude(
      'C:\\Program Files\\Claude\\claude.exe',
      ['--bg', prompt],
      {
        cwd: 'C:\\work\\Council',
        timeoutMs: 0,
      },
    );

    expect(result.ok).toBe(true);
    expect(childProcess.spawn).toHaveBeenCalledExactlyOnceWith(
      'C:\\Program Files\\Claude\\claude.exe',
      ['--bg', prompt],
      expect.objectContaining({
        cwd: 'C:\\work\\Council',
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });
});
