import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  GitCheckoutInspection,
  GitPort,
  GitWorktreeEntry,
} from '../git/contracts.js';
import {
  WorktreeLeaseStore,
  WorktreeLeaseStoreConflictError,
} from '../orchestration/worktrees/leaseStore.js';
import type {
  GateWorktreeRunRecord,
  GateWorktreeRunState,
  GateWorktreeRunTerminalResult,
  WorktreeLeasesFileV1,
} from '../orchestration/worktrees/types.js';
import { isValidProfileId } from '../profileIdentity.js';
import type { MissionGateKind, MissionGateStatus } from './types.js';

const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_RUN = /[\u0000-\u001f\u007f]+/g;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GATE_RUN_ID = /^gaterun_[0-9a-f]{32}$/;
const GATE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const EXECUTION_ID = /^execution_[A-Za-z0-9_-]{8,96}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 8_192;
const SAFE_GATE_ENVIRONMENT_KEYS = [
  'APPDATA',
  'ComSpec',
  'HOME',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
] as const;

export interface GateCommandDefinition {
  readonly id: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface GatePolicy {
  readonly commands: readonly GateCommandDefinition[];
  readonly testCommandIds: readonly string[];
  readonly reviewCommandIds: readonly string[];
}

export type GateCommandOutcome =
  | 'passed'
  | 'command-failed'
  | 'spawn-failed'
  | 'timeout'
  | 'aborted'
  | 'output-limit';

export interface GateCommandResult {
  readonly outcome: GateCommandOutcome;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface GateCommandRunRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type GateCommandRunner = (
  request: GateCommandRunRequest,
) => Promise<GateCommandResult>;

export interface MissionGateWorkspace {
  readonly id: string;
  readonly canonicalPath: string;
  readonly trusted: boolean;
}

export interface GateRunnerOptions {
  readonly git: GitPort;
  readonly store: WorktreeLeaseStore;
  readonly workspace: MissionGateWorkspace;
  readonly gateWorktreeRoot: string;
  readonly policy: GatePolicy;
  /**
   * Privileged, pre-vetted non-secret overrides. The command never inherits
   * provider/cloud environment variables from the Council process.
   */
  readonly safeEnv?: NodeJS.ProcessEnv | undefined;
  readonly runCommand?: GateCommandRunner | undefined;
  readonly createRunId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export interface GatePolicyPreview {
  readonly kind: MissionGateKind;
  readonly commandIds: readonly string[];
  readonly gatePolicyFingerprint: string;
}

export interface RunMissionGateRequest {
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly missionId: string;
  readonly candidateId: string;
  readonly executorExecutionId: string;
  readonly executorProfileId: string;
  readonly kind: MissionGateKind;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly expectedGatePolicyFingerprint: string;
  readonly signal?: AbortSignal | undefined;
}

export interface MissionGateRunResult {
  readonly candidateId: string;
  readonly executorExecutionId: string;
  readonly executorProfileId: string;
  readonly kind: MissionGateKind;
  readonly status: MissionGateStatus;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly commandIds: readonly string[];
  readonly gatePolicyFingerprint: string;
  readonly evidence: readonly string[];
  readonly completedAt: string;
  /**
   * Present only when a command changed the immutable checkout. Council leaves
   * that registered worktree in place for explicit diagnosis and cleanup.
   */
  readonly retainedCheckoutPath?: string | undefined;
}

export class GateRunnerError extends Error {
  override readonly name = 'GateRunnerError';
}

interface CapturedOutput {
  text: string;
  bytes: number;
}

function processResult(
  outcome: GateCommandOutcome,
  exitCode: number | null,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  startedAt: number,
): GateCommandResult {
  return {
    outcome,
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The only executable boundary used by Mission gates. Policy supplies the
 * executable and argv; Mission and renderer input can select only a gate kind.
 */
export function runGateCommand(
  request: GateCommandRunRequest,
): Promise<GateCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout: CapturedOutput = { text: '', bytes: 0 };
    const stderr: CapturedOutput = { text: '', bytes: 0 };
    let settled = false;
    let terminalOutcome:
      | Extract<GateCommandOutcome, 'timeout' | 'aborted' | 'output-limit'>
      | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const finish = (result: GateCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      request.signal?.removeEventListener('abort', abort);
      resolve(result);
    };

    const child = spawn(request.executable, [...request.argv], {
      cwd: request.cwd,
      env: { ...safeGateEnvironment(), ...request.env },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const terminate = (
      outcome: Extract<
        GateCommandOutcome,
        'timeout' | 'aborted' | 'output-limit'
      >,
    ): void => {
      if (terminalOutcome !== undefined) return;
      terminalOutcome = outcome;
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        child.kill('SIGKILL');
        finish(processResult(outcome, null, stdout, stderr, startedAt));
      }, 2_000);
      escalation.unref();
    };

    function abort(): void {
      terminate('aborted');
    }

    const capture = (target: CapturedOutput, chunk: Buffer | string): void => {
      if (terminalOutcome === 'output-limit') return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retainedBytes = stdout.bytes + stderr.bytes;
      const remaining = request.maxOutputBytes - retainedBytes;
      if (remaining > 0) {
        const retained = buffer.subarray(0, remaining);
        target.text += retained.toString('utf8');
        target.bytes += retained.byteLength;
      }
      if (buffer.byteLength > remaining) terminate('output-limit');
    };

    child.stdout.on('data', (chunk: Buffer | string) =>
      capture(stdout, chunk),
    );
    child.stderr.on('data', (chunk: Buffer | string) =>
      capture(stderr, chunk),
    );
    child.on('error', () => {
      finish(processResult('spawn-failed', null, stdout, stderr, startedAt));
    });
    child.on('close', (exitCode) => {
      if (terminalOutcome !== undefined) {
        finish(
          processResult(
            terminalOutcome,
            exitCode,
            stdout,
            stderr,
            startedAt,
          ),
        );
      } else {
        finish(
          processResult(
            exitCode === 0 ? 'passed' : 'command-failed',
            exitCode,
            stdout,
            stderr,
            startedAt,
          ),
        );
      }
    });

    if (request.signal?.aborted === true) {
      terminate('aborted');
    } else {
      request.signal?.addEventListener('abort', abort, { once: true });
    }
    timeout = setTimeout(() => terminate('timeout'), request.timeoutMs);
    timeout.unref();
  });
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(value);
  return platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function safeGateEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_GATE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function validateCommand(command: GateCommandDefinition): void {
  if (!OPAQUE_ID.test(command.id)) {
    throw new TypeError('Gate command ID must be a bounded opaque identifier.');
  }
  if (
    command.executable.trim() === '' ||
    command.executable.length > MAX_ARGUMENT_LENGTH ||
    CONTROL.test(command.executable)
  ) {
    throw new TypeError('Gate executable is empty, too long, or contains controls.');
  }
  if (command.argv.length > MAX_ARGUMENTS) {
    throw new TypeError('Gate command has too many arguments.');
  }
  for (const argument of command.argv) {
    if (
      argument.length > MAX_ARGUMENT_LENGTH ||
      CONTROL.test(argument)
    ) {
      throw new TypeError('Gate argument is too long or contains controls.');
    }
  }
  requirePositiveInteger(
    command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    `Gate command "${command.id}" timeout`,
  );
  requirePositiveInteger(
    command.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    `Gate command "${command.id}" output limit`,
  );
}

function validateCommandIds(
  ids: readonly string[],
  kind: MissionGateKind,
  commands: ReadonlyMap<string, GateCommandDefinition>,
): void {
  if (ids.length === 0) {
    throw new TypeError(`${kind} gate policy must select at least one command.`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${kind} gate policy contains duplicate command IDs.`);
  }
  for (const id of ids) {
    if (!OPAQUE_ID.test(id) || !commands.has(id)) {
      throw new TypeError(
        `${kind} gate policy references an unknown command ID.`,
      );
    }
  }
}

function policyFingerprint(policy: GatePolicy): string {
  const canonical = {
    commands: [...policy.commands]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((command) => ({
        id: command.id,
        executable: command.executable,
        argv: [...command.argv],
        timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes:
          command.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      })),
    reviewCommandIds: [...policy.reviewCommandIds],
    testCommandIds: [...policy.testCommandIds],
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function gateRequestFingerprint(
  request: RunMissionGateRequest,
  commandIds: readonly string[],
): string {
  const canonical = {
    version: 1,
    workspaceId: request.workspaceId,
    missionId: request.missionId,
    candidateId: request.candidateId,
    executorExecutionId: request.executorExecutionId,
    executorProfileId: request.executorProfileId,
    kind: request.kind,
    commitSha: request.commitSha,
    treeSha: request.treeSha,
    commandIds: [...commandIds],
    gatePolicyFingerprint: request.expectedGatePolicyFingerprint,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function evidenceText(value: string): string {
  return value.replace(CONTROL_RUN, ' ').replace(/\s+/g, ' ').trim();
}

function commandEvidence(
  commandId: string,
  result: GateCommandResult,
): string {
  const stdout = Buffer.from(result.stdout, 'utf8');
  const stderr = Buffer.from(result.stderr, 'utf8');
  const fields = [
    `command=${commandId}`,
    `outcome=${result.outcome}`,
    `exit=${result.exitCode === null ? 'none' : String(result.exitCode)}`,
    `durationMs=${String(result.durationMs)}`,
    `stdoutBytes=${String(stdout.byteLength)}`,
    `stdoutSha256=${createHash('sha256').update(stdout).digest('hex')}`,
    `stderrBytes=${String(stderr.byteLength)}`,
    `stderrSha256=${createHash('sha256').update(stderr).digest('hex')}`,
  ];
  return evidenceText(fields.join(' ')).slice(0, 4_000);
}

function exactDetachedCheckout(
  inspection: GitCheckoutInspection,
  expectedPath: string,
  commonGitDir: string,
  commit: string,
  tree: string,
  platform: NodeJS.Platform,
): boolean {
  return (
    pathIdentity(inspection.checkoutPath, platform) ===
      pathIdentity(expectedPath, platform) &&
    pathIdentity(inspection.commonGitDir, platform) ===
      pathIdentity(commonGitDir, platform) &&
    inspection.branchRef === undefined &&
    inspection.commit === commit &&
    inspection.tree === tree &&
    inspection.clean
  );
}

function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );
}

function matchingWorktrees(
  entries: readonly GitWorktreeEntry[],
  checkoutPath: string,
  platform: NodeJS.Platform,
): readonly GitWorktreeEntry[] {
  const expected = pathIdentity(checkoutPath, platform);
  return entries.filter(
    (entry) => pathIdentity(entry.path, platform) === expected,
  );
}

function mutableGateRuns(
  draft: WorktreeLeasesFileV1,
): Record<string, GateWorktreeRunRecord> {
  return draft.gateRuns as Record<string, GateWorktreeRunRecord>;
}

function withGateRunState(
  run: GateWorktreeRunRecord,
  state: GateWorktreeRunState,
  updatedAt: string,
  reason?: string | undefined,
): GateWorktreeRunRecord {
  const next: GateWorktreeRunRecord = {
    runId: run.runId,
    idempotencyKey: run.idempotencyKey,
    requestFingerprint: run.requestFingerprint,
    workspaceId: run.workspaceId,
    missionId: run.missionId,
    candidateId: run.candidateId,
    kind: run.kind,
    assignmentId: run.assignmentId,
    ownerProfileId: run.ownerProfileId,
    accessMode: 'read-only',
    repositoryRoot: run.repositoryRoot,
    commonGitDir: run.commonGitDir,
    objectFormat: run.objectFormat,
    checkoutPath: run.checkoutPath,
    commit: run.commit,
    tree: run.tree,
    commandIds: [...run.commandIds],
    gatePolicyFingerprint: run.gatePolicyFingerprint,
    state,
    createdAt: run.createdAt,
    updatedAt,
    ...(reason === undefined ? {} : { blockedReason: reason.slice(0, 2_000) }),
    ...(run.terminalResult === undefined
      ? {}
      : {
          terminalResult: {
            ...run.terminalResult,
            commandIds: [...run.terminalResult.commandIds],
            evidence: [...run.terminalResult.evidence],
          },
        }),
  };
  return next;
}

function toMissionGateResult(
  result: GateWorktreeRunTerminalResult,
): MissionGateRunResult {
  return {
    candidateId: result.candidateId,
    executorExecutionId: result.executorExecutionId,
    executorProfileId: result.executorProfileId,
    kind: result.kind,
    status: result.status,
    commitSha: result.commitSha,
    treeSha: result.treeSha,
    commandIds: [...result.commandIds],
    gatePolicyFingerprint: result.gatePolicyFingerprint,
    evidence: [...result.evidence],
    completedAt: result.completedAt,
    ...(result.retainedCheckoutPath === undefined
      ? {}
      : { retainedCheckoutPath: result.retainedCheckoutPath }),
  };
}

function errorDigest(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Runs immutable Mission gates in Council-owned detached worktrees. Neither
 * command IDs nor argv cross the runtime request boundary: the installed
 * policy is the sole authority.
 */
export class GateRunner {
  private readonly git: GitPort;
  private readonly store: WorktreeLeaseStore;
  private readonly workspace: MissionGateWorkspace;
  private readonly configuredRoot: string;
  private readonly commands: ReadonlyMap<string, GateCommandDefinition>;
  private readonly policy: GatePolicy;
  private readonly fingerprint: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly runCommand: GateCommandRunner;
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;
  private tail: Promise<void> = Promise.resolve();
  private activeRunController: AbortController | undefined;
  private closing = false;

  constructor(options: GateRunnerOptions) {
    if (!path.isAbsolute(options.gateWorktreeRoot)) {
      throw new TypeError('Gate worktree root must be absolute.');
    }
    const commands = new Map<string, GateCommandDefinition>();
    for (const command of options.policy.commands) {
      validateCommand(command);
      if (commands.has(command.id)) {
        throw new TypeError(`Duplicate gate command ID "${command.id}".`);
      }
      commands.set(command.id, {
        ...command,
        argv: [...command.argv],
      });
    }
    validateCommandIds(options.policy.testCommandIds, 'test', commands);
    validateCommandIds(options.policy.reviewCommandIds, 'review', commands);
    this.git = options.git;
    this.store = options.store;
    this.workspace = options.workspace;
    this.configuredRoot = options.gateWorktreeRoot;
    this.commands = commands;
    this.policy = {
      commands: [...commands.values()],
      testCommandIds: [...options.policy.testCommandIds],
      reviewCommandIds: [...options.policy.reviewCommandIds],
    };
    this.fingerprint = policyFingerprint(this.policy);
    this.env =
      options.safeEnv === undefined ? undefined : { ...options.safeEnv };
    this.runCommand = options.runCommand ?? runGateCommand;
    this.createRunId =
      options.createRunId ??
      (() => `gaterun_${randomUUID().replaceAll('-', '')}`);
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
  }

  preview(kind: MissionGateKind): GatePolicyPreview {
    return {
      kind,
      commandIds: [...this.commandIds(kind)],
      gatePolicyFingerprint: this.fingerprint,
    };
  }

  run(request: RunMissionGateRequest): Promise<MissionGateRunResult> {
    if (this.closing) {
      return Promise.reject(
        new GateRunnerError('Mission gate execution is shutting down.'),
      );
    }
    const operation = this.tail.then(
      () => this.runAdmitted(request),
      () => this.runAdmitted(request),
    );
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  reconcile(): Promise<readonly GateWorktreeRunRecord[]> {
    if (this.closing) {
      return Promise.reject(
        new GateRunnerError('Mission gate execution is shutting down.'),
      );
    }
    const operation = this.tail.then(
      () => this.reconcileUnlocked(),
      () => this.reconcileUnlocked(),
    );
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.activeRunController?.abort();
    await this.tail;
  }

  private async runAdmitted(
    request: RunMissionGateRequest,
  ): Promise<MissionGateRunResult> {
    if (this.closing) {
      throw new GateRunnerError('Mission gate execution is shutting down.');
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (request.signal?.aborted === true) controller.abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
    this.activeRunController = controller;
    try {
      return await this.runUnlocked({
        ...request,
        signal: controller.signal,
      });
    } finally {
      request.signal?.removeEventListener('abort', abort);
      if (this.activeRunController === controller) {
        this.activeRunController = undefined;
      }
    }
  }

  private async runUnlocked(
    request: RunMissionGateRequest,
  ): Promise<MissionGateRunResult> {
    this.assertWorkspace(request.workspaceId);
    if (!GATE_IDEMPOTENCY_KEY.test(request.idempotencyKey)) {
      throw new GateRunnerError(
        'Gate idempotency key must be a bounded opaque identifier.',
      );
    }
    if (
      !OPAQUE_ID.test(request.missionId) ||
      !OPAQUE_ID.test(request.candidateId) ||
      !EXECUTION_ID.test(request.executorExecutionId) ||
      !isValidProfileId(request.executorProfileId)
    ) {
      throw new GateRunnerError(
        'Mission, candidate, and executor ownership IDs are invalid.',
      );
    }
    if (
      !GIT_OBJECT_ID.test(request.commitSha) ||
      !GIT_OBJECT_ID.test(request.treeSha)
    ) {
      throw new GateRunnerError(
        'Gate candidate must use full lowercase commit and tree object IDs.',
      );
    }
    if (
      !SHA_256.test(request.expectedGatePolicyFingerprint) ||
      request.expectedGatePolicyFingerprint !== this.fingerprint
    ) {
      throw new GateRunnerError(
        'Gate policy changed after preview; review the current gate policy.',
      );
    }
    const commandIds = this.commandIds(request.kind);
    const requestFingerprint = gateRequestFingerprint(request, commandIds);
    const existing = await this.findIdempotentRun(request.idempotencyKey);
    if (existing !== undefined) {
      return this.replayIdempotentRun(existing, requestFingerprint);
    }
    await this.reconcileUnlocked();
    const reconciledExisting = await this.findIdempotentRun(
      request.idempotencyKey,
    );
    if (reconciledExisting !== undefined) {
      return this.replayIdempotentRun(
        reconciledExisting,
        requestFingerprint,
      );
    }

    const repository = await this.git.inspectRepository(
      this.workspace.canonicalPath,
    );
    if (
      pathIdentity(repository.repositoryRoot, this.platform) !==
      pathIdentity(this.workspace.canonicalPath, this.platform)
    ) {
      throw new GateRunnerError(
        'Trusted workspace no longer resolves to the selected repository root.',
      );
    }
    const candidate = await this.git.resolveCommit(
      repository.repositoryRoot,
      request.commitSha,
    );
    if (
      candidate.commit !== request.commitSha ||
      candidate.tree !== request.treeSha
    ) {
      throw new GateRunnerError(
        'Gate candidate commit or tree changed before checkout creation.',
      );
    }

    await mkdir(this.configuredRoot, { recursive: true });
    const root = await realpath(this.configuredRoot);
    const runId = this.createRunId();
    if (!GATE_RUN_ID.test(runId)) {
      throw new GateRunnerError('Generated gate run ID is invalid.');
    }
    const checkoutPath = path.join(
      root,
      `gate-${request.kind}-${createHash('sha256')
        .update(`${request.missionId}\0${request.candidateId}\0${runId}`)
        .digest('hex')
        .slice(0, 32)}`,
    );
    if (
      pathIdentity(path.dirname(checkoutPath), this.platform) !==
      pathIdentity(root, this.platform)
    ) {
      throw new GateRunnerError('Generated gate checkout escaped its owned root.');
    }

    const timestamp = this.now().toISOString();
    const run: GateWorktreeRunRecord = {
      runId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      workspaceId: request.workspaceId,
      missionId: request.missionId,
      candidateId: request.candidateId,
      kind: request.kind,
      assignmentId: request.executorExecutionId,
      ownerProfileId: request.executorProfileId,
      accessMode: 'read-only',
      repositoryRoot: repository.repositoryRoot,
      commonGitDir: repository.commonGitDir,
      objectFormat: repository.objectFormat,
      checkoutPath,
      commit: request.commitSha,
      tree: request.treeSha,
      commandIds: [...commandIds],
      gatePolicyFingerprint: this.fingerprint,
      state: 'provisioning',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const claim = await this.claimRunJournal(run);
    if (!claim.created) {
      return this.replayIdempotentRun(
        claim.run,
        requestFingerprint,
      );
    }

    let before: GitCheckoutInspection;
    try {
      await this.git.createDetachedWorktree({
        repository,
        checkoutPath,
        commit: request.commitSha,
      });
      before = await this.git.inspectCheckout(checkoutPath);
      if (
        !exactDetachedCheckout(
          before,
          checkoutPath,
          repository.commonGitDir,
          request.commitSha,
          request.treeSha,
          this.platform,
        )
      ) {
        await this.transitionRun(
          runId,
          ['provisioning'],
          'retained',
          'Detached checkout did not match the exact clean candidate.',
        );
        throw new GateRunnerError(
          'Detached gate checkout did not match the exact clean candidate.',
        );
      }
      await this.transitionRun(runId, ['provisioning'], 'running');
    } catch (error) {
      await this.reconcileRunBestEffort(runId);
      throw error;
    }

    const evidence: string[] = [];
    let status: MissionGateStatus = 'passed';
    for (const commandId of commandIds) {
      const command = this.commands.get(commandId)!;
      let result: GateCommandResult;
      try {
        result = await this.runCommand({
          executable: command.executable,
          argv: [...command.argv],
          cwd: before.checkoutPath,
          timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxOutputBytes:
            command.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
          ...(this.env === undefined ? {} : { env: this.env }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        evidence.push(
          `command=${commandId} outcome=runner-error errorSha256=${errorDigest(error)}`,
        );
        status = 'failed';
        break;
      }
      evidence.push(commandEvidence(commandId, result));
      if (result.outcome !== 'passed') {
        status = 'failed';
        break;
      }
    }

    const after = await this.git.inspectCheckout(checkoutPath);
    if (
      !exactDetachedCheckout(
        after,
        checkoutPath,
        repository.commonGitDir,
        request.commitSha,
        request.treeSha,
        this.platform,
      )
    ) {
      evidence.push(
        'checkout-postcondition=failed candidate checkout changed or became dirty',
      );
      const terminalResult: GateWorktreeRunTerminalResult = {
        candidateId: request.candidateId,
        executorExecutionId: request.executorExecutionId,
        executorProfileId: request.executorProfileId,
        kind: request.kind,
        status: 'failed',
        commitSha: request.commitSha,
        treeSha: request.treeSha,
        commandIds: [...commandIds],
        gatePolicyFingerprint: this.fingerprint,
        evidence: [...evidence],
        completedAt: this.now().toISOString(),
        retainedCheckoutPath: checkoutPath,
      };
      await this.completeRun(
        runId,
        ['running'],
        'retained',
        terminalResult,
        'Gate command changed or dirtied the immutable candidate checkout.',
      );
      return toMissionGateResult(terminalResult);
    }

    evidence.push(
      'checkout-postcondition=passed exact detached checkout verified for cleanup',
    );
    const terminalResult: GateWorktreeRunTerminalResult = {
      candidateId: request.candidateId,
      executorExecutionId: request.executorExecutionId,
      executorProfileId: request.executorProfileId,
      kind: request.kind,
      status,
      commitSha: request.commitSha,
      treeSha: request.treeSha,
      commandIds: [...commandIds],
      gatePolicyFingerprint: this.fingerprint,
      evidence: [...evidence],
      completedAt: this.now().toISOString(),
    };
    await this.completeRun(
      runId,
      ['running'],
      'cleanup-pending',
      terminalResult,
    );
    await this.removeExactRunCheckout(run);
    await this.transitionRun(runId, ['cleanup-pending'], 'removed');
    return toMissionGateResult(terminalResult);
  }

  private async reconcileUnlocked(): Promise<readonly GateWorktreeRunRecord[]> {
    this.assertWorkspace(this.workspace.id);
    const state = await this.store.reload();
    if (state.problem !== undefined) {
      throw new GateRunnerError(
        `Worktree journal is unavailable: ${state.problem.message}`,
      );
    }
    const runs = Object.values(state.data.gateRuns)
      .filter(
        (run) =>
          run.workspaceId === this.workspace.id &&
          run.state !== 'removed' &&
          run.state !== 'retained' &&
          run.state !== 'blocked',
      )
      .sort((left, right) => left.runId.localeCompare(right.runId));
    for (const run of runs) await this.reconcileRun(run);
    const reloaded = await this.store.reload();
    if (reloaded.problem !== undefined) {
      throw new GateRunnerError(
        `Worktree journal is unavailable: ${reloaded.problem.message}`,
      );
    }
    return Object.values(reloaded.data.gateRuns).filter(
      (run) => run.workspaceId === this.workspace.id,
    );
  }

  private async reconcileRun(run: GateWorktreeRunRecord): Promise<void> {
    const entries = await this.git.listWorktrees(run.repositoryRoot);
    const matches = matchingWorktrees(
      entries,
      run.checkoutPath,
      this.platform,
    );
    const exists = await pathExists(run.checkoutPath);
    if (matches.length === 0 && !exists) {
      if (
        run.terminalResult === undefined &&
        (run.state === 'running' || run.state === 'cleanup-pending')
      ) {
        await this.transitionRun(
          run.runId,
          [run.state],
          'blocked',
          'Gate execution ended without a durable terminal result and cannot be replayed.',
        );
      } else {
        await this.transitionRun(
          run.runId,
          [run.state],
          'removed',
        );
      }
      return;
    }
    if (matches.length !== 1 || !exists) {
      await this.transitionRun(
        run.runId,
        [run.state],
        'blocked',
        'Gate checkout is inconsistent between Git registry and filesystem.',
      );
      return;
    }

    let inspection: GitCheckoutInspection;
    try {
      inspection = await this.git.inspectCheckout(run.checkoutPath);
    } catch {
      return;
    }
    if (
      matches[0]?.detached !== true ||
      matches[0]?.branchRef !== undefined ||
      matches[0]?.head !== run.commit ||
      !exactDetachedCheckout(
        inspection,
        run.checkoutPath,
        run.commonGitDir,
        run.commit,
        run.tree,
        this.platform,
      )
    ) {
      await this.transitionRun(
        run.runId,
        [run.state],
        'retained',
        'Recovered gate checkout changed or became dirty and was retained.',
      );
      return;
    }

    if (run.state !== 'cleanup-pending') {
      await this.transitionRun(
        run.runId,
        [run.state],
        'cleanup-pending',
      );
    }
    await this.removeExactRunCheckout(run);
    if (
      run.terminalResult === undefined &&
      run.state !== 'provisioning'
    ) {
      await this.transitionRun(
        run.runId,
        ['cleanup-pending'],
        'blocked',
        'Gate execution was interrupted before its terminal result was journaled.',
      );
    } else {
      await this.transitionRun(run.runId, ['cleanup-pending'], 'removed');
    }
  }

  private async reconcileRunBestEffort(runId: string): Promise<void> {
    const state = await this.store.reload();
    if (state.problem !== undefined) return;
    const run = state.data.gateRuns[runId];
    if (
      run === undefined ||
      run.state === 'removed' ||
      run.state === 'retained' ||
      run.state === 'blocked'
    ) {
      return;
    }
    try {
      await this.reconcileRun(run);
    } catch {
      // The durable nonterminal journal remains available for restart retry.
    }
  }

  private async removeExactRunCheckout(
    run: GateWorktreeRunRecord,
  ): Promise<void> {
    const inspection = await this.git.inspectCheckout(run.checkoutPath);
    if (
      !exactDetachedCheckout(
        inspection,
        run.checkoutPath,
        run.commonGitDir,
        run.commit,
        run.tree,
        this.platform,
      )
    ) {
      await this.transitionRun(
        run.runId,
        ['cleanup-pending'],
        'retained',
        'Gate checkout changed before cleanup and was retained.',
      );
      throw new GateRunnerError(
        'Gate checkout changed before cleanup and was retained.',
      );
    }
    await this.git.removeWorktree(run.repositoryRoot, run.checkoutPath);
    const entries = await this.git.listWorktrees(run.repositoryRoot);
    if (
      matchingWorktrees(entries, run.checkoutPath, this.platform).length > 0 ||
      (await pathExists(run.checkoutPath))
    ) {
      throw new GateRunnerError(
        'Gate cleanup did not remove the exact registered checkout.',
      );
    }
  }

  private async findIdempotentRun(
    idempotencyKey: string,
  ): Promise<GateWorktreeRunRecord | undefined> {
    const state = await this.store.reload();
    if (state.problem !== undefined) {
      throw new GateRunnerError(
        `Worktree journal is unavailable: ${state.problem.message}`,
      );
    }
    return Object.values(state.data.gateRuns).find(
      (run) =>
        run.workspaceId === this.workspace.id &&
        run.idempotencyKey === idempotencyKey,
    );
  }

  private async claimRunJournal(
    run: GateWorktreeRunRecord,
  ): Promise<{
    readonly created: boolean;
    readonly run: GateWorktreeRunRecord;
  }> {
    return this.transactJournal((draft) => {
      const existing = Object.values(draft.gateRuns).find(
        (candidate) =>
          candidate.workspaceId === run.workspaceId &&
          candidate.idempotencyKey === run.idempotencyKey,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== run.requestFingerprint) {
          throw new GateRunnerError(
            'Gate idempotency key is already bound to a different request.',
          );
        }
        return { created: false, run: existing };
      }
      if (draft.gateRuns[run.runId] !== undefined) {
        throw new GateRunnerError('Generated gate run ID already exists.');
      }
      mutableGateRuns(draft)[run.runId] = run;
      return { created: true, run };
    });
  }

  private async replayIdempotentRun(
    run: GateWorktreeRunRecord,
    requestFingerprint: string,
  ): Promise<MissionGateRunResult> {
    if (run.requestFingerprint !== requestFingerprint) {
      throw new GateRunnerError(
        'Gate idempotency key is already bound to a different request.',
      );
    }
    if (run.terminalResult === undefined) {
      await this.reconcileRunBestEffort(run.runId);
      const reconciled = await this.findIdempotentRun(run.idempotencyKey);
      if (reconciled?.terminalResult !== undefined) {
        return toMissionGateResult(reconciled.terminalResult);
      }
      throw new GateRunnerError(
        'The prior gate attempt did not reach a durable terminal result and cannot be replayed safely.',
      );
    }
    if (run.state === 'cleanup-pending') {
      await this.reconcileRun(run);
    }
    const reconciled = await this.findIdempotentRun(run.idempotencyKey);
    if (
      reconciled === undefined ||
      reconciled.requestFingerprint !== requestFingerprint ||
      reconciled.terminalResult === undefined
    ) {
      throw new GateRunnerError(
        'Durable gate result changed while its cleanup was reconciled.',
      );
    }
    return toMissionGateResult(reconciled.terminalResult);
  }

  private async completeRun(
    runId: string,
    expectedStates: readonly GateWorktreeRunState[],
    nextState: GateWorktreeRunState,
    terminalResult: GateWorktreeRunTerminalResult,
    reason?: string | undefined,
  ): Promise<GateWorktreeRunRecord> {
    return this.transactJournal((draft) => {
      const current = draft.gateRuns[runId];
      if (
        current === undefined ||
        current.terminalResult !== undefined ||
        !expectedStates.includes(current.state)
      ) {
        throw new GateRunnerError(
          `Gate run "${runId}" changed before its terminal result could be journaled.`,
        );
      }
      const next: GateWorktreeRunRecord = {
        ...withGateRunState(
          current,
          nextState,
          this.now().toISOString(),
          reason,
        ),
        terminalResult: {
          ...terminalResult,
          commandIds: [...terminalResult.commandIds],
          evidence: [...terminalResult.evidence],
        },
      };
      mutableGateRuns(draft)[runId] = next;
      return next;
    });
  }

  private async transitionRun(
    runId: string,
    expectedStates: readonly GateWorktreeRunState[],
    nextState: GateWorktreeRunState,
    reason?: string | undefined,
  ): Promise<GateWorktreeRunRecord> {
    return this.transactJournal((draft) => {
      const current = draft.gateRuns[runId];
      if (
        current === undefined ||
        !expectedStates.includes(current.state)
      ) {
        throw new GateRunnerError(
          `Gate run "${runId}" changed before ${nextState} could be journaled.`,
        );
      }
      const next = withGateRunState(
        current,
        nextState,
        this.now().toISOString(),
        reason,
      );
      mutableGateRuns(draft)[runId] = next;
      return next;
    });
  }

  private async transactJournal<T>(
    mutate: (draft: WorktreeLeasesFileV1) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.store.reload();
      if (state.problem !== undefined) {
        throw new GateRunnerError(
          `Worktree journal is unavailable: ${state.problem.message}`,
        );
      }
      try {
        return await this.store.transact(state.data.revision, mutate);
      } catch (error) {
        if (
          error instanceof WorktreeLeaseStoreConflictError &&
          attempt < 2
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new GateRunnerError('Worktree journal remained concurrently busy.');
  }

  private commandIds(kind: MissionGateKind): readonly string[] {
    return kind === 'test'
      ? this.policy.testCommandIds
      : this.policy.reviewCommandIds;
  }

  private assertWorkspace(workspaceId: string): void {
    if (!this.workspace.trusted) {
      throw new GateRunnerError(
        'Mission gates require an explicitly trusted workspace.',
      );
    }
    if (workspaceId !== this.workspace.id) {
      throw new GateRunnerError('Gate request belongs to another workspace.');
    }
  }
}
