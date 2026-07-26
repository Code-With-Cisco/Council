import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CreateWriterWorktreeRequest,
  GitCheckoutInspection,
  GitCommitIdentity,
  GitObjectFormat,
  GitPort,
  GitProcessFailure,
  GitRepositoryIdentity,
  GitWorktreeEntry,
} from './contracts.js';
import { GitOperationError } from './contracts.js';
import { parseStatusPorcelain, parseWorktreePorcelain } from './parse.js';
import {
  DEFAULT_GIT_OUTPUT_LIMIT_BYTES,
  DEFAULT_GIT_TIMEOUT_MS,
  runGitProcess,
  type GitProcessOptions,
} from './process.js';

export interface NodeGitPortOptions {
  readonly executable?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COUNCIL_BRANCH = /^refs\/heads\/council\/[a-z0-9][a-z0-9/-]*$/;

function message(result: GitProcessFailure): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return detail === '' ? result.message : detail.slice(0, 2_000);
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(value);
  return platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function assertOid(value: string, operation: string): void {
  if (!OID.test(value)) {
    throw new GitOperationError(
      'malformed-output',
      operation,
      `Git returned an invalid full object ID: ${value}`,
    );
  }
}

function validateRevision(revision: string): void {
  if (
    revision !== 'HEAD' &&
    !OID.test(revision) &&
    !COUNCIL_BRANCH.test(revision)
  ) {
    throw new GitOperationError(
      'invalid-input',
      'resolve-commit',
      'Revision is not an authorized full object ID or Council ref.',
    );
  }
}

function branchName(branchRef: string): string {
  if (
    !COUNCIL_BRANCH.test(branchRef) ||
    branchRef.includes('..') ||
    branchRef.includes('//') ||
    branchRef.endsWith('/')
  ) {
    throw new GitOperationError(
      'invalid-input',
      'create-worktree',
      'Writer branch is not in the generated Council namespace.',
    );
  }
  return branchRef.slice('refs/heads/'.length);
}

export class NodeGitPort implements GitPort {
  private readonly executable: string;
  private readonly platform: NodeJS.Platform;
  private readonly processOptions: Omit<GitProcessOptions, 'cwd'>;

  constructor(options: NodeGitPortOptions = {}) {
    this.executable = options.executable ?? (process.platform === 'win32' ? 'git.exe' : 'git');
    this.platform = options.platform ?? process.platform;
    this.processOptions = {
      env: options.env,
      timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      maxOutputBytes:
        options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT_BYTES,
    };
  }

  async inspectRepository(workspaceRoot: string): Promise<GitRepositoryIdentity> {
    if (!path.isAbsolute(workspaceRoot)) {
      throw new GitOperationError(
        'invalid-input',
        'inspect-repository',
        'Workspace root must be absolute.',
      );
    }
    const selected = await realpath(workspaceRoot);
    const topLevelText = await this.success(
      selected,
      ['rev-parse', '--show-toplevel'],
      'inspect-repository',
    );
    const repositoryRoot = await realpath(topLevelText.trim());
    if (
      pathIdentity(selected, this.platform) !==
      pathIdentity(repositoryRoot, this.platform)
    ) {
      throw new GitOperationError(
        'workspace-not-root',
        'inspect-repository',
        'The trusted workspace must be the Git repository root.',
      );
    }
    const bare = (
      await this.success(
        repositoryRoot,
        ['rev-parse', '--is-bare-repository'],
        'inspect-repository',
      )
    ).trim();
    if (bare !== 'false') {
      throw new GitOperationError(
        'not-repository',
        'inspect-repository',
        'Bare repositories cannot receive Council worktree leases.',
      );
    }
    const commonText = (
      await this.success(
        repositoryRoot,
        ['rev-parse', '--git-common-dir'],
        'inspect-repository',
      )
    ).trim();
    const commonGitDir = await realpath(
      path.isAbsolute(commonText)
        ? commonText
        : path.resolve(repositoryRoot, commonText),
    );
    const formatText = (
      await this.success(
        repositoryRoot,
        ['rev-parse', '--show-object-format'],
        'inspect-repository',
      )
    ).trim();
    if (formatText !== 'sha1' && formatText !== 'sha256') {
      throw new GitOperationError(
        'unsupported-object-format',
        'inspect-repository',
        `Unsupported Git object format "${formatText}".`,
      );
    }
    const head = await this.resolveCommit(repositoryRoot, 'HEAD');
    return {
      repositoryRoot,
      commonGitDir,
      objectFormat: formatText,
      headCommit: head.commit,
      headTree: head.tree,
    };
  }

  async resolveCommit(
    checkoutPath: string,
    revision: string,
  ): Promise<GitCommitIdentity> {
    validateRevision(revision);
    const commit = (
      await this.success(
        checkoutPath,
        ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
        'resolve-commit',
      )
    ).trim();
    const tree = (
      await this.success(
        checkoutPath,
        ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`],
        'resolve-commit',
      )
    ).trim();
    assertOid(commit, 'resolve-commit');
    assertOid(tree, 'resolve-commit');
    return { commit, tree };
  }

  async tryResolveCommit(
    checkoutPath: string,
    revision: string,
  ): Promise<GitCommitIdentity | undefined> {
    validateRevision(revision);
    const result = await runGitProcess(
      this.executable,
      ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
      { cwd: checkoutPath, ...this.processOptions },
    );
    if (!result.ok) {
      if (result.kind === 'command-failed' && result.exitCode === 128) return undefined;
      throw this.error('resolve-commit', result);
    }
    const commit = result.stdout.trim();
    assertOid(commit, 'resolve-commit');
    return this.resolveCommit(checkoutPath, commit);
  }

  async inspectCheckout(checkoutPath: string): Promise<GitCheckoutInspection> {
    const canonicalCheckout = await realpath(checkoutPath);
    const identity = await this.resolveCommit(canonicalCheckout, 'HEAD');
    const commonText = (
      await this.success(
        canonicalCheckout,
        ['rev-parse', '--git-common-dir'],
        'inspect-checkout',
      )
    ).trim();
    const commonGitDir = await realpath(
      path.isAbsolute(commonText)
        ? commonText
        : path.resolve(canonicalCheckout, commonText),
    );
    const branchResult = await runGitProcess(
      this.executable,
      ['symbolic-ref', '-q', 'HEAD'],
      { cwd: canonicalCheckout, ...this.processOptions },
    );
    let branchRef: string | undefined;
    if (branchResult.ok) {
      branchRef = branchResult.stdout.trim();
    } else if (
      branchResult.kind !== 'command-failed' ||
      branchResult.exitCode !== 1
    ) {
      throw this.error('inspect-checkout', branchResult);
    }
    const statusText = await this.success(
      canonicalCheckout,
      ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
      'inspect-checkout',
    );
    const statusEntries = parseStatusPorcelain(statusText);
    return {
      checkoutPath: canonicalCheckout,
      commonGitDir,
      branchRef,
      commit: identity.commit,
      tree: identity.tree,
      clean: statusEntries.length === 0,
      statusEntries,
    };
  }

  async listWorktrees(repositoryRoot: string): Promise<readonly GitWorktreeEntry[]> {
    const text = await this.success(
      repositoryRoot,
      ['worktree', 'list', '--porcelain', '-z'],
      'list-worktrees',
    );
    try {
      return parseWorktreePorcelain(text);
    } catch (error) {
      throw new GitOperationError(
        'malformed-output',
        'list-worktrees',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async createWriterWorktree(request: CreateWriterWorktreeRequest): Promise<void> {
    const name = branchName(request.branchRef);
    assertOid(request.baseCommit, 'create-worktree');
    await this.success(
      request.repository.repositoryRoot,
      ['worktree', 'add', '-b', name, request.checkoutPath, request.baseCommit],
      'create-worktree',
    );
  }

  async createExistingBranchWorktree(
    request: CreateWriterWorktreeRequest,
  ): Promise<void> {
    const name = branchName(request.branchRef);
    assertOid(request.baseCommit, 'create-worktree');
    await this.success(
      request.repository.repositoryRoot,
      ['worktree', 'add', request.checkoutPath, name],
      'create-worktree',
    );
  }

  async removeWorktree(
    repositoryRoot: string,
    checkoutPath: string,
  ): Promise<void> {
    await this.success(
      repositoryRoot,
      ['worktree', 'remove', checkoutPath],
      'remove-worktree',
    );
  }

  async isAncestor(
    repositoryRoot: string,
    ancestorCommit: string,
    descendantCommit: string,
  ): Promise<boolean> {
    assertOid(ancestorCommit, 'is-ancestor');
    assertOid(descendantCommit, 'is-ancestor');
    const result = await runGitProcess(
      this.executable,
      ['merge-base', '--is-ancestor', ancestorCommit, descendantCommit],
      { cwd: repositoryRoot, ...this.processOptions },
    );
    if (result.ok) return true;
    if (result.kind === 'command-failed' && result.exitCode === 1) return false;
    throw this.error('is-ancestor', result);
  }

  private async success(
    cwd: string,
    argv: readonly string[],
    operation: string,
  ): Promise<string> {
    const result = await runGitProcess(this.executable, argv, {
      cwd,
      ...this.processOptions,
    });
    if (!result.ok) throw this.error(operation, result);
    return result.stdout;
  }

  private error(operation: string, result: GitProcessFailure): GitOperationError {
    return new GitOperationError(
      result.kind,
      operation,
      message(result),
      result,
    );
  }
}

export function isFullGitObjectId(
  value: string,
  format?: GitObjectFormat | undefined,
): boolean {
  const length = format === 'sha1' ? 40 : format === 'sha256' ? 64 : undefined;
  return (
    /^[0-9a-f]+$/.test(value) &&
    (length === undefined ? value.length === 40 || value.length === 64 : value.length === length)
  );
}
