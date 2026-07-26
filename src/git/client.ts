import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CreateDetachedWorktreeRequest,
  CreateWriterWorktreeRequest,
  FastForwardCheckoutRequest,
  GitCheckoutInspection,
  GitCommitIdentity,
  GitObjectFormat,
  GitPort,
  GitProcessFailure,
  GitRepositoryIdentity,
  GitWorktreeEntry,
  PinCouncilHandoffRefRequest,
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
  /** Council-owned empty directory used to suppress repository Git hooks. */
  readonly hooksPath?: string | undefined;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COUNCIL_BRANCH = /^refs\/heads\/council\/[a-z0-9][a-z0-9/-]*$/;
const LOCAL_BRANCH = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const COUNCIL_HANDOFF_REF =
  /^refs\/council\/handoffs\/[a-z0-9][a-z0-9_/-]*$/;

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
    !isSafeRef(revision, LOCAL_BRANCH) &&
    !isSafeRef(revision, COUNCIL_HANDOFF_REF)
  ) {
    throw new GitOperationError(
      'invalid-input',
      'resolve-commit',
      'Revision is not an authorized full object ID or Council ref.',
    );
  }
}

function isSafeRef(value: string, shape: RegExp): boolean {
  if (
    !shape.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('\\')
  ) {
    return false;
  }
  return value
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.endsWith('.lock'),
    );
}

function branchName(branchRef: string): string {
  if (
    !isSafeRef(branchRef, COUNCIL_BRANCH)
  ) {
    throw new GitOperationError(
      'invalid-input',
      'create-worktree',
      'Writer branch is not in the generated Council namespace.',
    );
  }
  return branchRef.slice('refs/heads/'.length);
}

function validateLocalBranchRef(branchRef: string): void {
  if (!isSafeRef(branchRef, LOCAL_BRANCH)) {
    throw new GitOperationError(
      'invalid-input',
      'fast-forward-checkout',
      'Target is not a safe full local branch ref.',
    );
  }
}

function validateHandoffRef(ref: string): void {
  if (!isSafeRef(ref, COUNCIL_HANDOFF_REF)) {
    throw new GitOperationError(
      'invalid-input',
      'pin-handoff-ref',
      'Handoff ref is not in the immutable Council handoff namespace.',
    );
  }
}

export class NodeGitPort implements GitPort {
  private readonly executable: string;
  private readonly platform: NodeJS.Platform;
  private readonly processOptions: Omit<GitProcessOptions, 'cwd'>;
  private readonly gitPrefix: readonly string[];

  constructor(options: NodeGitPortOptions = {}) {
    this.executable = options.executable ?? (process.platform === 'win32' ? 'git.exe' : 'git');
    this.platform = options.platform ?? process.platform;
    this.processOptions = {
      env: options.env,
      timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      maxOutputBytes:
        options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT_BYTES,
    };
    if (
      options.hooksPath !== undefined &&
      !path.isAbsolute(options.hooksPath)
    ) {
      throw new TypeError('Council Git hooks path must be absolute.');
    }
    this.gitPrefix =
      options.hooksPath === undefined
        ? []
        : ['-c', `core.hooksPath=${options.hooksPath}`];
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
      [
        ...this.gitPrefix,
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${revision}^{commit}`,
      ],
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
      [...this.gitPrefix, 'symbolic-ref', '-q', 'HEAD'],
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

  async createDetachedWorktree(
    request: CreateDetachedWorktreeRequest,
  ): Promise<void> {
    if (!path.isAbsolute(request.checkoutPath)) {
      throw new GitOperationError(
        'invalid-input',
        'create-detached-worktree',
        'Detached worktree path must be absolute.',
      );
    }
    if (!isFullGitObjectId(request.commit, request.repository.objectFormat)) {
      throw new GitOperationError(
        'invalid-input',
        'create-detached-worktree',
        `Detached worktree commit must be a full ${request.repository.objectFormat} object ID.`,
      );
    }
    const expected = await this.resolveCommit(
      request.repository.repositoryRoot,
      request.commit,
    );
    if (expected.commit !== request.commit) {
      throw new GitOperationError(
        'invalid-input',
        'create-detached-worktree',
        'Detached worktree commit did not resolve exactly.',
      );
    }
    await this.success(
      request.repository.repositoryRoot,
      ['worktree', 'add', '--detach', request.checkoutPath, request.commit],
      'create-detached-worktree',
    );

    const inspection = await this.inspectCheckout(request.checkoutPath);
    const registered = (await this.listWorktrees(
      request.repository.repositoryRoot,
    )).filter(
      (entry) =>
        pathIdentity(entry.path, this.platform) ===
        pathIdentity(inspection.checkoutPath, this.platform),
    );
    if (
      registered.length !== 1 ||
      registered[0]?.detached !== true ||
      registered[0]?.branchRef !== undefined ||
      registered[0]?.head !== request.commit ||
      inspection.branchRef !== undefined ||
      inspection.commit !== request.commit ||
      inspection.tree !== expected.tree ||
      !inspection.clean ||
      pathIdentity(inspection.commonGitDir, this.platform) !==
        pathIdentity(request.repository.commonGitDir, this.platform)
    ) {
      throw new GitOperationError(
        'malformed-output',
        'create-detached-worktree',
        'Git created a worktree that did not match the exact detached commit request.',
      );
    }
  }

  async pinCouncilHandoffRef(
    request: PinCouncilHandoffRefRequest,
  ): Promise<void> {
    validateHandoffRef(request.ref);
    if (!isFullGitObjectId(request.commit, request.objectFormat)) {
      throw new GitOperationError(
        'invalid-input',
        'pin-handoff-ref',
        `Handoff commit must be a full ${request.objectFormat} object ID.`,
      );
    }
    const commit = await this.resolveCommit(
      request.repositoryRoot,
      request.commit,
    );
    if (commit.commit !== request.commit) {
      throw new GitOperationError(
        'invalid-input',
        'pin-handoff-ref',
        'Handoff commit did not resolve exactly.',
      );
    }
    const existing = await this.tryResolveCommit(
      request.repositoryRoot,
      request.ref,
    );
    if (existing !== undefined) {
      if (existing.commit === request.commit) return;
      throw new GitOperationError(
        'invalid-input',
        'pin-handoff-ref',
        'Immutable Council handoff ref already points to another commit.',
      );
    }

    let updateError: unknown;
    try {
      await this.success(
        request.repositoryRoot,
        [
          'update-ref',
          request.ref,
          request.commit,
          '0'.repeat(request.objectFormat === 'sha1' ? 40 : 64),
        ],
        'pin-handoff-ref',
      );
    } catch (error) {
      updateError = error;
    }
    const reconciled = await this.tryResolveCommit(
      request.repositoryRoot,
      request.ref,
    );
    if (reconciled?.commit === request.commit) return;
    if (reconciled !== undefined) {
      throw new GitOperationError(
        'invalid-input',
        'pin-handoff-ref',
        'Immutable Council handoff ref raced to another commit.',
      );
    }
    if (updateError instanceof Error) throw updateError;
    throw new GitOperationError(
      'malformed-output',
      'pin-handoff-ref',
      'Git reported handoff pin success but the exact ref is absent.',
    );
  }

  async fastForwardCheckout(
    request: FastForwardCheckoutRequest,
  ): Promise<GitCheckoutInspection> {
    validateLocalBranchRef(request.branchRef);
    const format: GitObjectFormat =
      request.expectedCommit.length === 40 ? 'sha1' : 'sha256';
    for (const [name, value] of [
      ['expected commit', request.expectedCommit],
      ['expected tree', request.expectedTree],
      ['next commit', request.nextCommit],
      ['next tree', request.nextTree],
    ] as const) {
      if (!isFullGitObjectId(value, format)) {
        throw new GitOperationError(
          'invalid-input',
          'fast-forward-checkout',
          `${name} must be a full ${format} object ID.`,
        );
      }
    }
    const expected = await this.resolveCommit(
      request.checkoutPath,
      request.expectedCommit,
    );
    const next = await this.resolveCommit(
      request.checkoutPath,
      request.nextCommit,
    );
    if (
      expected.commit !== request.expectedCommit ||
      expected.tree !== request.expectedTree ||
      next.commit !== request.nextCommit ||
      next.tree !== request.nextTree
    ) {
      throw new GitOperationError(
        'invalid-input',
        'fast-forward-checkout',
        'Approved commit or tree identity no longer matches the repository.',
      );
    }
    if (
      !(await this.isAncestor(
        request.checkoutPath,
        request.expectedCommit,
        request.nextCommit,
      ))
    ) {
      throw new GitOperationError(
        'invalid-input',
        'fast-forward-checkout',
        'Approved integration is not a fast-forward from the exact target.',
      );
    }

    const before = await this.inspectCheckout(request.checkoutPath);
    if (before.branchRef !== request.branchRef) {
      throw new GitOperationError(
        'invalid-input',
        'fast-forward-checkout',
        'The expected target branch is not checked out.',
      );
    }
    const currentRef = await this.tryResolveCommit(
      request.checkoutPath,
      request.branchRef,
    );
    if (currentRef === undefined) {
      throw new GitOperationError(
        'invalid-input',
        'fast-forward-checkout',
        'The exact target branch no longer exists.',
      );
    }

    if (currentRef.commit === request.expectedCommit) {
      if (
        before.commit !== request.expectedCommit ||
        before.tree !== request.expectedTree ||
        !before.clean
      ) {
        throw new GitOperationError(
          'invalid-input',
          'fast-forward-checkout',
          'Target checkout is dirty or no longer matches the approved target.',
        );
      }
      let updateError: unknown;
      try {
        await this.success(
          request.checkoutPath,
          [
            'update-ref',
            request.branchRef,
            request.nextCommit,
            request.expectedCommit,
          ],
          'fast-forward-checkout',
        );
      } catch (error) {
        updateError = error;
      }
      const reconciled = await this.tryResolveCommit(
        request.checkoutPath,
        request.branchRef,
      );
      if (reconciled?.commit === request.expectedCommit) {
        if (updateError instanceof Error) throw updateError;
        throw new GitOperationError(
          'malformed-output',
          'fast-forward-checkout',
          'Git reported a ref update but the target did not advance.',
        );
      }
      if (reconciled?.commit !== request.nextCommit) {
        throw new GitOperationError(
          'invalid-input',
          'fast-forward-checkout',
          'Target branch drifted to an unapproved commit during integration.',
        );
      }
    } else if (currentRef.commit !== request.nextCommit) {
      throw new GitOperationError(
        'invalid-input',
        'fast-forward-checkout',
        'Target branch drifted from both the approved old and new commits.',
      );
    }

    await this.success(
      request.checkoutPath,
      [
        'read-tree',
        '-m',
        '-u',
        request.expectedCommit,
        request.nextCommit,
      ],
      'fast-forward-checkout-sync',
    );
    const after = await this.inspectCheckout(request.checkoutPath);
    if (
      after.branchRef !== request.branchRef ||
      after.commit !== request.nextCommit ||
      after.tree !== request.nextTree ||
      !after.clean
    ) {
      throw new GitOperationError(
        'malformed-output',
        'fast-forward-checkout-sync',
        'Target ref advanced, but its checkout did not synchronize to the exact clean approved tree.',
      );
    }
    return after;
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
      [
        ...this.gitPrefix,
        'merge-base',
        '--is-ancestor',
        ancestorCommit,
        descendantCommit,
      ],
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
    const result = await runGitProcess(
      this.executable,
      [...this.gitPrefix, ...argv],
      {
      // The optional prefix is privileged configuration, never renderer input.
        cwd,
        ...this.processOptions,
      },
    );
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
