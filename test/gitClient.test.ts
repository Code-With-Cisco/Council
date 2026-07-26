import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeGitPort } from '../src/git/client.js';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

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
});
