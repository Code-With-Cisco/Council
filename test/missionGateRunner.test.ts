import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeGitPort } from '../src/git/client.js';
import {
  GateRunner,
  GateRunnerError,
  type GatePolicy,
} from '../src/missions/gateRunner.js';
import { WorktreeLeaseStore } from '../src/orchestration/worktrees/leaseStore.js';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env['COUNCIL_GATE_SECRET'];
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(policy?: GatePolicy) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'council-mission-gate-'),
  );
  temporaryDirectories.push(directory);
  const selectedRepositoryRoot = path.join(directory, 'repository');
  await mkdir(selectedRepositoryRoot, { recursive: true });
  const repositoryRoot = await realpath(selectedRepositoryRoot);
  await execute('git', ['init', '-b', 'main'], { cwd: repositoryRoot });
  await writeFile(path.join(repositoryRoot, 'result.txt'), 'base\n', 'utf8');
  await execute('git', ['add', 'result.txt'], { cwd: repositoryRoot });
  const identity = [
    '-c',
    'user.name=Council Test',
    '-c',
    'user.email=council-test@example.invalid',
  ];
  await execute('git', [...identity, 'commit', '-m', 'base'], {
    cwd: repositoryRoot,
  });
  await execute('git', ['switch', '-c', 'candidate'], {
    cwd: repositoryRoot,
  });
  await writeFile(
    path.join(repositoryRoot, 'result.txt'),
    'candidate\n',
    'utf8',
  );
  await execute('git', ['add', 'result.txt'], { cwd: repositoryRoot });
  await execute('git', [...identity, 'commit', '-m', 'candidate'], {
    cwd: repositoryRoot,
  });
  const candidateText = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
  });
  await execute('git', ['switch', 'main'], { cwd: repositoryRoot });

  const git = new NodeGitPort({ timeoutMs: 10_000 });
  const candidate = await git.resolveCommit(
    repositoryRoot,
    candidateText.stdout.trim(),
  );
  const store = new WorktreeLeaseStore(
    path.join(directory, 'worktree-leases.json'),
  );
  await store.load();
  const selectedPolicy: GatePolicy = policy ?? {
    commands: [
      {
        id: 'test.safe-env',
        executable: process.execPath,
        argv: [
          '-e',
          "process.stdout.write(process.env.COUNCIL_GATE_SECRET ?? 'absent')",
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
      {
        id: 'review.noop',
        executable: process.execPath,
        argv: ['-e', "process.stdout.write('reviewed')"],
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ],
    testCommandIds: ['test.safe-env'],
    reviewCommandIds: ['review.noop'],
  };
  const options = {
    git,
    store,
    workspace: {
      id: 'workspace-test',
      canonicalPath: repositoryRoot,
      trusted: true,
    },
    gateWorktreeRoot: path.join(directory, 'gate-worktrees'),
    policy: selectedPolicy,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  } as const;
  return { directory, repositoryRoot, git, store, candidate, options };
}

function request(
  candidate: { readonly commit: string; readonly tree: string },
  fingerprint: string,
  idempotencyKey = 'gate-request-12345678',
) {
  return {
    idempotencyKey,
    workspaceId: 'workspace-test',
    missionId: 'mission_12345678',
    candidateId: 'candidate_12345678',
    executorExecutionId: 'execution_12345678',
    executorProfileId: 'profile-tester001',
    kind: 'test' as const,
    commitSha: candidate.commit,
    treeSha: candidate.tree,
    expectedGatePolicyFingerprint: fingerprint,
  };
}

describe('Mission GateRunner', () => {
  it('runs only policy-selected argv in an exact detached checkout and journals cleanup', async () => {
    const f = await fixture();
    process.env['COUNCIL_GATE_SECRET'] = 'must-not-cross-gate-boundary';
    const runner = new GateRunner({
      ...f.options,
      createRunId: () => `gaterun_${'1'.repeat(32)}`,
    });
    const preview = runner.preview('test');

    const result = await runner.run(
      request(f.candidate, preview.gatePolicyFingerprint),
    );

    expect(result).toMatchObject({
      status: 'passed',
      commandIds: ['test.safe-env'],
      commitSha: f.candidate.commit,
      treeSha: f.candidate.tree,
      gatePolicyFingerprint: preview.gatePolicyFingerprint,
    });
    expect(result.evidence.join(' ')).toContain('stdoutBytes=6');
    expect(result.evidence.join(' ')).not.toContain('absent');
    expect(result.evidence.join(' ')).not.toContain(
      'must-not-cross-gate-boundary',
    );
    const journal = f.store.state.data.gateRuns[`gaterun_${'1'.repeat(32)}`];
    expect(journal).toMatchObject({
      state: 'removed',
      idempotencyKey: 'gate-request-12345678',
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      commit: f.candidate.commit,
      tree: f.candidate.tree,
      commandIds: ['test.safe-env'],
      gatePolicyFingerprint: preview.gatePolicyFingerprint,
      assignmentId: 'execution_12345678',
      ownerProfileId: 'profile-tester001',
      accessMode: 'read-only',
      terminalResult: {
        status: 'passed',
        candidateId: 'candidate_12345678',
        executorExecutionId: 'execution_12345678',
        executorProfileId: 'profile-tester001',
        commitSha: f.candidate.commit,
        treeSha: f.candidate.tree,
        completedAt: '2026-07-26T12:00:00.000Z',
      },
    });
    await expect(access(journal!.checkoutPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed and retains a gate checkout changed by an allowlisted command', async () => {
    const mutatingPolicy: GatePolicy = {
      commands: [
        {
          id: 'test.mutates',
          executable: process.execPath,
          argv: [
            '-e',
            "require('node:fs').writeFileSync('unexpected.txt','changed')",
          ],
        },
        {
          id: 'review.noop',
          executable: process.execPath,
          argv: ['-e', 'process.exit(0)'],
        },
      ],
      testCommandIds: ['test.mutates'],
      reviewCommandIds: ['review.noop'],
    };
    const f = await fixture(mutatingPolicy);
    const runId = `gaterun_${'2'.repeat(32)}`;
    const runner = new GateRunner({
      ...f.options,
      createRunId: () => runId,
    });

    const result = await runner.run(
      request(
        f.candidate,
        runner.preview('test').gatePolicyFingerprint,
      ),
    );

    expect(result.status).toBe('failed');
    expect(result.retainedCheckoutPath).toBe(
      f.store.state.data.gateRuns[runId]?.checkoutPath,
    );
    expect(f.store.state.data.gateRuns[runId]).toMatchObject({
      state: 'retained',
      blockedReason:
        'Gate command changed or dirtied the immutable candidate checkout.',
    });
    await expect(access(result.retainedCheckoutPath!)).resolves.toBeUndefined();
  });

  it('keeps a failed cleanup journal and reconciles the exact checkout after restart', async () => {
    const f = await fixture();
    const runId = `gaterun_${'3'.repeat(32)}`;
    const remove = vi
      .spyOn(f.git, 'removeWorktree')
      .mockRejectedValueOnce(new Error('simulated cleanup interruption'));
    const first = new GateRunner({
      ...f.options,
      createRunId: () => runId,
    });

    await expect(
      first.run(
        request(
          f.candidate,
          first.preview('test').gatePolicyFingerprint,
        ),
      ),
    ).rejects.toThrow('simulated cleanup interruption');
    expect(f.store.state.data.gateRuns[runId]?.state).toBe('cleanup-pending');
    const storedResult =
      f.store.state.data.gateRuns[runId]!.terminalResult;
    expect(storedResult).toMatchObject({
      status: 'passed',
      commitSha: f.candidate.commit,
      treeSha: f.candidate.tree,
    });
    const checkoutPath = f.store.state.data.gateRuns[runId]!.checkoutPath;
    await expect(access(checkoutPath)).resolves.toBeUndefined();

    remove.mockRestore();
    const runCommand = vi.fn(async () => ({
      outcome: 'passed' as const,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
    }));
    const restarted = new GateRunner({
      ...f.options,
      runCommand,
      createRunId: () => `gaterun_${'4'.repeat(32)}`,
    });
    const replayed = await restarted.run(
      request(
        f.candidate,
        restarted.preview('test').gatePolicyFingerprint,
      ),
    );

    expect(f.store.state.data.gateRuns[runId]?.state).toBe('removed');
    await expect(access(checkoutPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runCommand).not.toHaveBeenCalled();
    expect(replayed).toEqual(storedResult);
  });

  it('returns the exact durable result on same-key replay without rerunning commands', async () => {
    const f = await fixture();
    const runCommand = vi.fn(async () => ({
      outcome: 'passed' as const,
      exitCode: 0,
      stdout: 'bounded',
      stderr: '',
      durationMs: 7,
    }));
    const createRunId = vi.fn(() => `gaterun_${'7'.repeat(32)}`);
    const runner = new GateRunner({
      ...f.options,
      runCommand,
      createRunId,
    });
    const gateRequest = request(
      f.candidate,
      runner.preview('test').gatePolicyFingerprint,
      'gate-replay-12345678',
    );

    const first = await runner.run(gateRequest);
    const replayed = await runner.run(gateRequest);

    expect(replayed).toEqual(first);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(createRunId).toHaveBeenCalledOnce();
    expect(Object.keys(f.store.state.data.gateRuns)).toEqual([
      `gaterun_${'7'.repeat(32)}`,
    ]);
  });

  it('fails closed when an idempotency key is replayed with different exact input', async () => {
    const f = await fixture();
    const runCommand = vi.fn(async () => ({
      outcome: 'passed' as const,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
    }));
    const runner = new GateRunner({
      ...f.options,
      runCommand,
      createRunId: () => `gaterun_${'8'.repeat(32)}`,
    });
    const gateRequest = request(
      f.candidate,
      runner.preview('test').gatePolicyFingerprint,
      'gate-conflict-12345678',
    );
    await runner.run(gateRequest);

    await expect(
      runner.run({
        ...gateRequest,
        candidateId: 'candidate_different',
      }),
    ).rejects.toThrow('already bound to a different request');
    expect(runCommand).toHaveBeenCalledOnce();
    expect(Object.keys(f.store.state.data.gateRuns)).toHaveLength(1);
  });

  it('rejects an invalid caller idempotency key before journaling or execution', async () => {
    const f = await fixture();
    const runCommand = vi.fn();
    const runner = new GateRunner({
      ...f.options,
      runCommand,
      createRunId: () => `gaterun_${'9'.repeat(32)}`,
    });

    await expect(
      runner.run(
        request(
          f.candidate,
          runner.preview('test').gatePolicyFingerprint,
          'short',
        ),
      ),
    ).rejects.toThrow('idempotency key');
    expect(runCommand).not.toHaveBeenCalled();
    expect(f.store.state.data.gateRuns).toEqual({});
  });

  it('rejects a stale policy fingerprint before creating a journal or worktree', async () => {
    const f = await fixture();
    const runner = new GateRunner({
      ...f.options,
      createRunId: () => `gaterun_${'5'.repeat(32)}`,
    });

    await expect(
      runner.run(request(f.candidate, '0'.repeat(64))),
    ).rejects.toBeInstanceOf(GateRunnerError);
    expect(f.store.state.data.gateRuns).toEqual({});
  });

  it('aborts an active owned command, drains cleanup, and closes admission on shutdown', async () => {
    const f = await fixture();
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const runCommand = vi.fn(
      async (gateRequest: {
        readonly signal?: AbortSignal | undefined;
      }) =>
        new Promise<{
          readonly outcome: 'aborted';
          readonly exitCode: null;
          readonly stdout: string;
          readonly stderr: string;
          readonly durationMs: number;
        }>((resolve) => {
          announceStarted();
          const finish = (): void =>
            resolve({
              outcome: 'aborted',
              exitCode: null,
              stdout: '',
              stderr: '',
              durationMs: 1,
            });
          if (gateRequest.signal?.aborted === true) finish();
          else gateRequest.signal?.addEventListener('abort', finish, {
            once: true,
          });
        }),
    );
    const runner = new GateRunner({
      ...f.options,
      runCommand,
      createRunId: () => `gaterun_${'6'.repeat(32)}`,
    });
    const gateRequest = request(
      f.candidate,
      runner.preview('test').gatePolicyFingerprint,
    );

    const inFlight = runner.run(gateRequest);
    await started;
    await runner.shutdown();

    await expect(inFlight).resolves.toMatchObject({ status: 'failed' });
    expect(f.store.state.data.gateRuns[`gaterun_${'6'.repeat(32)}`]).toMatchObject({
      state: 'removed',
    });
    await expect(runner.run(gateRequest)).rejects.toThrow('shutting down');
  });
});
