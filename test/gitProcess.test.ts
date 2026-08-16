import { EventEmitter } from 'node:events';
import * as nodePath from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: childProcess.spawn,
}));

import { runGitProcess } from '../src/git/process.js';
import { parseWorktreePorcelain } from '../src/git/parse.js';

function child(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const result = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  result.stdout = new PassThrough();
  result.stderr = new PassThrough();
  result.kill = vi.fn(() => {
    queueMicrotask(() => result.emit('close', null));
    return true;
  });
  return result;
}

afterEach(() => {
  childProcess.spawn.mockReset();
});

describe('bounded Git process boundary', () => {
  it('passes injection-shaped paths as argv with shell disabled and prompts disabled', async () => {
    const processChild = child();
    childProcess.spawn.mockReturnValue(processChild);
    queueMicrotask(() => {
      processChild.stdout.end('ok');
      processChild.stderr.end();
      processChild.emit('close', 0);
    });
    const checkout = 'C:\\Council data\\lease & literal';

    const result = await runGitProcess(
      'C:\\Program Files\\Git\\bin\\git.exe',
      ['worktree', 'remove', checkout],
      { cwd: '/Council repo', timeoutMs: 10_000 },
    );

    expect(result.ok).toBe(true);
    expect(childProcess.spawn).toHaveBeenCalledExactlyOnceWith(
      'C:\\Program Files\\Git\\bin\\git.exe',
      ['worktree', 'remove', checkout],
      expect.objectContaining({
        cwd: '/Council repo',
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
        }),
      }),
    );
  });

  it('bounds combined output and reports an uncertain output-limit result', async () => {
    const processChild = child();
    childProcess.spawn.mockReturnValue(processChild);
    queueMicrotask(() => {
      processChild.stdout.write('0123456789');
    });

    const result = await runGitProcess('git', ['status'], {
      cwd: '/work/repo',
      timeoutMs: 10_000,
      maxOutputBytes: 5,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'output-limit',
      stdout: '01234',
    });
    expect(processChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('parses NUL-delimited worktree paths without line splitting', () => {
    const pathWithNewline = '/work/Council\nlease';
    const parsed = parseWorktreePorcelain(
      `worktree ${pathWithNewline}\0HEAD ${'a'.repeat(40)}\0branch refs/heads/council/ws/lease\0\0`,
    );

    // The parser converts Git's forward-slash paths to the native separator, so
    // the expectation is normalised too. What this test is really about is the
    // embedded newline surviving: NUL framing must not split the record.
    expect(parsed).toEqual([
      {
        path: nodePath.normalize(pathWithNewline),
        head: 'a'.repeat(40),
        branchRef: 'refs/heads/council/ws/lease',
        detached: false,
        bare: false,
        lockedReason: undefined,
        prunableReason: undefined,
      },
    ]);
    expect(parsed[0]?.path).toContain('\n');
  });
});
