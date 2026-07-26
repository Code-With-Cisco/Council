import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeGitPort } from '../src/git/client.js';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function repositoryWithCandidate(): Promise<{
  directory: string;
  repositoryRoot: string;
  git: NodeGitPort;
  repository: Awaited<ReturnType<NodeGitPort['inspectRepository']>>;
  candidate: Awaited<ReturnType<NodeGitPort['resolveCommit']>>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'council-git-candidate-'));
  temporaryDirectories.push(directory);
  const repositoryRoot = path.join(directory, 'repository');
  await mkdir(repositoryRoot, { recursive: true });
  await execute('git', ['init', '-b', 'main'], { cwd: repositoryRoot });
  await writeFile(path.join(repositoryRoot, 'result.txt'), 'base\n', 'utf8');
  await execute('git', ['add', 'result.txt'], { cwd: repositoryRoot });
  const identityArgs = [
    '-c',
    'user.name=Council Test',
    '-c',
    'user.email=council-test@example.invalid',
  ];
  await execute('git', [...identityArgs, 'commit', '-m', 'base'], {
    cwd: repositoryRoot,
  });
  await execute('git', ['switch', '-c', 'candidate'], { cwd: repositoryRoot });
  await writeFile(path.join(repositoryRoot, 'result.txt'), 'candidate\n', 'utf8');
  await execute('git', ['add', 'result.txt'], { cwd: repositoryRoot });
  await execute('git', [...identityArgs, 'commit', '-m', 'candidate'], {
    cwd: repositoryRoot,
  });
  const candidateText = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
  });
  await execute('git', ['switch', 'main'], { cwd: repositoryRoot });
  const git = new NodeGitPort({ timeoutMs: 10_000 });
  const repository = await git.inspectRepository(repositoryRoot);
  const candidate = await git.resolveCommit(
    repositoryRoot,
    candidateText.stdout.trim(),
  );
  return { directory, repositoryRoot, git, repository, candidate };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('semantic Git port', () => {
  it('inspects the canonical repository and native object format', async () => {
    const git = new NodeGitPort({ timeoutMs: 10_000 });
    const identity = await git.inspectRepository(process.cwd());

    expect(identity.repositoryRoot).toBe(process.cwd());
    expect(['sha1', 'sha256']).toContain(identity.objectFormat);
    expect(identity.headCommit).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    expect(identity.headTree).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    expect(await git.resolveCommit(process.cwd(), identity.headCommit)).toEqual({
      commit: identity.headCommit,
      tree: identity.headTree,
    });
  });

  it('refuses to silently widen trust from a repository subdirectory', async () => {
    const git = new NodeGitPort({ timeoutMs: 10_000 });

    await expect(
      git.inspectRepository(path.join(process.cwd(), 'src')),
    ).rejects.toMatchObject({
      kind: 'workspace-not-root',
    });
  });

  it('lists the selected checkout through NUL porcelain', async () => {
    const git = new NodeGitPort({ timeoutMs: 10_000 });
    const entries = await git.listWorktrees(process.cwd());

    expect(entries.some((entry) => entry.path === process.cwd())).toBe(true);
  });

  it('rejects option-shaped and arbitrary revisions before invoking Git', async () => {
    const git = new NodeGitPort({ timeoutMs: 10_000 });

    await expect(
      git.resolveCommit(process.cwd(), '--all'),
    ).rejects.toMatchObject({
      kind: 'invalid-input',
    });
  });

  it('creates, verifies, and non-force removes a generated Council writer worktree', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'council-git-port-'));
    temporaryDirectories.push(directory);
    const repositoryRoot = path.join(directory, 'repo with spaces');
    await mkdir(repositoryRoot, { recursive: true });
    await execute('git', ['init', '-b', 'main'], { cwd: repositoryRoot });
    await writeFile(path.join(repositoryRoot, 'README.md'), 'fixture\n', 'utf8');
    await execute('git', ['add', 'README.md'], { cwd: repositoryRoot });
    await execute(
      'git',
      [
        '-c',
        'user.name=Council Test',
        '-c',
        'user.email=council-test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { cwd: repositoryRoot },
    );
    const git = new NodeGitPort({ timeoutMs: 10_000 });
    const repository = await git.inspectRepository(repositoryRoot);
    const checkoutPath = path.join(directory, 'leases', 'writer checkout');
    await mkdir(path.dirname(checkoutPath), { recursive: true });
    const branchRef = 'refs/heads/council/fixture/lease0001';

    await git.createWriterWorktree({
      repository,
      checkoutPath,
      branchRef,
      baseCommit: repository.headCommit,
    });

    const checkout = await git.inspectCheckout(checkoutPath);
    expect(checkout).toMatchObject({
      branchRef,
      commit: repository.headCommit,
      tree: repository.headTree,
      clean: true,
    });
    expect(
      (await git.listWorktrees(repositoryRoot)).find(
        (entry) => entry.path === checkout.checkoutPath,
      ),
    ).toMatchObject({
      branchRef,
      head: repository.headCommit,
    });

    await git.removeWorktree(repositoryRoot, checkoutPath);
    await expect(access(checkoutPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git.tryResolveCommit(repositoryRoot, branchRef)).toEqual({
      commit: repository.headCommit,
      tree: repository.headTree,
    });
  });

  it('creates an exact clean detached gate worktree', async () => {
    const { directory, repositoryRoot, git, repository, candidate } =
      await repositoryWithCandidate();
    const checkoutPath = path.join(directory, 'gate worktrees', 'test gate');
    await mkdir(path.dirname(checkoutPath), { recursive: true });

    await git.createDetachedWorktree({
      repository,
      checkoutPath,
      commit: candidate.commit,
    });

    expect(await git.inspectCheckout(checkoutPath)).toMatchObject({
      branchRef: undefined,
      commit: candidate.commit,
      tree: candidate.tree,
      clean: true,
    });
    expect(
      (await git.listWorktrees(repositoryRoot)).find(
        (entry) => entry.head === candidate.commit && entry.detached,
      ),
    ).toBeDefined();
  });

  it('pins an immutable Council handoff ref idempotently and rejects retargeting', async () => {
    const { repositoryRoot, git, repository, candidate } =
      await repositoryWithCandidate();
    const ref = 'refs/council/handoffs/handoff_0001';

    await git.pinCouncilHandoffRef({
      repositoryRoot,
      objectFormat: repository.objectFormat,
      ref,
      commit: candidate.commit,
    });
    await git.pinCouncilHandoffRef({
      repositoryRoot,
      objectFormat: repository.objectFormat,
      ref,
      commit: candidate.commit,
    });

    expect(await git.resolveCommit(repositoryRoot, ref)).toEqual(candidate);
    await expect(
      git.pinCouncilHandoffRef({
        repositoryRoot,
        objectFormat: repository.objectFormat,
        ref,
        commit: repository.headCommit,
      }),
    ).rejects.toThrow(/already points to another commit/);
    await expect(
      git.pinCouncilHandoffRef({
        repositoryRoot,
        objectFormat: repository.objectFormat,
        ref: 'refs/heads/main',
        commit: candidate.commit,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-input' });
  });

  it('CAS fast-forwards only the exact clean target and synchronizes its checkout', async () => {
    const { repositoryRoot, git, repository, candidate } =
      await repositoryWithCandidate();
    const request = {
      checkoutPath: repositoryRoot,
      branchRef: 'refs/heads/main',
      expectedCommit: repository.headCommit,
      expectedTree: repository.headTree,
      nextCommit: candidate.commit,
      nextTree: candidate.tree,
    };

    const integrated = await git.fastForwardCheckout(request);

    expect(integrated).toMatchObject({
      branchRef: 'refs/heads/main',
      commit: candidate.commit,
      tree: candidate.tree,
      clean: true,
    });
    expect(await readFile(path.join(repositoryRoot, 'result.txt'), 'utf8')).toBe(
      'candidate\n',
    );
    // Reconciliation after an uncertain acknowledgement is idempotent when the
    // ref and checkout already equal the exact approved result.
    expect(await git.fastForwardCheckout(request)).toMatchObject({
      commit: candidate.commit,
      tree: candidate.tree,
      clean: true,
    });
  });

  it('refuses dirty, stale, and non-fast-forward integration inputs', async () => {
    const { repositoryRoot, git, repository, candidate } =
      await repositoryWithCandidate();
    await writeFile(path.join(repositoryRoot, 'untracked.txt'), 'do not overwrite\n');
    const request = {
      checkoutPath: repositoryRoot,
      branchRef: 'refs/heads/main',
      expectedCommit: repository.headCommit,
      expectedTree: repository.headTree,
      nextCommit: candidate.commit,
      nextTree: candidate.tree,
    };

    await expect(git.fastForwardCheckout(request)).rejects.toThrow(
      /dirty or no longer matches/,
    );
    expect(
      (await git.resolveCommit(repositoryRoot, 'refs/heads/main')).commit,
    ).toBe(repository.headCommit);
    await rm(path.join(repositoryRoot, 'untracked.txt'));
    await expect(
      git.fastForwardCheckout({
        ...request,
        expectedTree: 'f'.repeat(repository.objectFormat === 'sha1' ? 40 : 64),
      }),
    ).rejects.toThrow(/identity no longer matches/);
    await expect(
      git.fastForwardCheckout({
        ...request,
        expectedCommit: candidate.commit,
        expectedTree: candidate.tree,
        nextCommit: repository.headCommit,
        nextTree: repository.headTree,
      }),
    ).rejects.toThrow(/not a fast-forward/);
  });
});
