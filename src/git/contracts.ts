export type GitObjectFormat = 'sha1' | 'sha256';

export type GitProcessFailureKind =
  | 'spawn-failed'
  | 'timeout'
  | 'aborted'
  | 'output-limit'
  | 'command-failed';

export interface GitProcessSuccess {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
  readonly durationMs: number;
}

export interface GitProcessFailure {
  readonly ok: false;
  readonly kind: GitProcessFailureKind;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export type GitProcessResult = GitProcessSuccess | GitProcessFailure;

export interface GitRepositoryIdentity {
  readonly repositoryRoot: string;
  readonly commonGitDir: string;
  readonly objectFormat: GitObjectFormat;
  readonly headCommit: string;
  readonly headTree: string;
}

export interface GitCommitIdentity {
  readonly commit: string;
  readonly tree: string;
}

export interface GitCheckoutInspection extends GitCommitIdentity {
  readonly checkoutPath: string;
  readonly commonGitDir: string;
  readonly branchRef: string | undefined;
  readonly clean: boolean;
  readonly statusEntries: readonly string[];
}

export interface GitWorktreeEntry {
  readonly path: string;
  readonly head: string | undefined;
  readonly branchRef: string | undefined;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly lockedReason: string | undefined;
  readonly prunableReason: string | undefined;
}

export interface CreateWriterWorktreeRequest {
  readonly repository: GitRepositoryIdentity;
  readonly checkoutPath: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}

export interface CreateDetachedWorktreeRequest {
  readonly repository: GitRepositoryIdentity;
  readonly checkoutPath: string;
  readonly commit: string;
}

export interface PinCouncilHandoffRefRequest {
  readonly repositoryRoot: string;
  readonly objectFormat: GitObjectFormat;
  readonly ref: string;
  readonly commit: string;
}

export interface FastForwardCheckoutRequest {
  readonly checkoutPath: string;
  readonly branchRef: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly nextCommit: string;
  readonly nextTree: string;
}

/**
 * Semantic Git authority used by orchestration.
 *
 * There is deliberately no arbitrary argv method on this interface. Renderer
 * and mission inputs can select opaque records, but they cannot manufacture a
 * Git command.
 */
export interface GitPort {
  inspectRepository(workspaceRoot: string): Promise<GitRepositoryIdentity>;
  resolveCommit(checkoutPath: string, revision: string): Promise<GitCommitIdentity>;
  tryResolveCommit(
    checkoutPath: string,
    revision: string,
  ): Promise<GitCommitIdentity | undefined>;
  inspectCheckout(checkoutPath: string): Promise<GitCheckoutInspection>;
  listWorktrees(repositoryRoot: string): Promise<readonly GitWorktreeEntry[]>;
  createWriterWorktree(request: CreateWriterWorktreeRequest): Promise<void>;
  createExistingBranchWorktree(request: CreateWriterWorktreeRequest): Promise<void>;
  createDetachedWorktree(request: CreateDetachedWorktreeRequest): Promise<void>;
  pinCouncilHandoffRef(request: PinCouncilHandoffRefRequest): Promise<void>;
  fastForwardCheckout(
    request: FastForwardCheckoutRequest,
  ): Promise<GitCheckoutInspection>;
  removeWorktree(repositoryRoot: string, checkoutPath: string): Promise<void>;
  isAncestor(
    repositoryRoot: string,
    ancestorCommit: string,
    descendantCommit: string,
  ): Promise<boolean>;
}

export type GitOperationErrorKind =
  | GitProcessFailureKind
  | 'invalid-input'
  | 'malformed-output'
  | 'not-repository'
  | 'workspace-not-root'
  | 'unsupported-object-format';

export class GitOperationError extends Error {
  override readonly name = 'GitOperationError';

  constructor(
    readonly kind: GitOperationErrorKind,
    readonly operation: string,
    message: string,
    readonly result?: GitProcessFailure | undefined,
  ) {
    super(message);
  }
}
