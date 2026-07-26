import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type {
  MissionAgentProviderAdapter,
  MissionConversation,
  MissionApprovalDecision,
  MissionProviderFailureKind,
  MissionProviderEvent,
  MissionProviderResult,
  MissionProviderStatus,
  MissionRoleAssignment,
  MissionTurn,
} from '../missionContracts.js';
import {
  CodexAppServerClient,
  CodexAppServerError,
} from './appServerClient.js';
import {
  CODEX_PROVIDER_ID,
  CodexThreadBindingConflictError,
  CodexThreadBindingStore,
  type CodexThreadBindingRecord,
  type PendingCodexThreadStart,
} from './threadBindings.js';
import type { CodexAppServerEvent } from './protocol.js';

export interface CodexMissionProviderAdapterOptions {
  readonly client: CodexAppServerClient;
  readonly bindings: CodexThreadBindingStore;
  readonly now?: (() => Date) | undefined;
  readonly operationId?: (() => string) | undefined;
  readonly bindingId?: (() => string) | undefined;
  readonly maxPromptChars?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

const DEFAULT_MAX_PROMPT_CHARS = 100_000;
const DEFAULT_MAX_OUTPUT_CHARS = 128 * 1024;

function failure<T>(
  kind: MissionProviderFailureKind,
  message: string,
): MissionProviderResult<T> {
  return { ok: false, kind, message };
}

function providerFailureKind(error: unknown): MissionProviderFailureKind {
  if (error instanceof CodexThreadBindingConflictError) return 'conflict';
  if (!(error instanceof CodexAppServerError)) return 'provider-failure';
  switch (error.code) {
    case 'unauthenticated':
      return 'unauthenticated';
    case 'not-connected':
    case 'process-exit':
    case 'stopped':
      return 'unavailable';
    case 'request-timeout':
      return 'uncertain-outcome';
    case 'protocol-error':
    case 'provider-error':
      return 'provider-failure';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  };
  return normalize(left) === normalize(right);
}

function validateAssignment(
  assignment: MissionRoleAssignment,
): string | undefined {
  if (!path.isAbsolute(assignment.workspacePath)) {
    return 'Codex assignment workspace must be an absolute privileged path.';
  }
  if (assignment.roleInstructions.trim() === '') {
    return 'Codex assignment role instructions are empty.';
  }
  if (!/^[a-f0-9]{64}$/.test(assignment.requestFingerprint)) {
    return 'Codex assignment fingerprint is invalid.';
  }
  return undefined;
}

function threadBinding(
  assignment: MissionRoleAssignment,
  threadId: string,
  bindingId: string,
  timestamp: string,
): CodexThreadBindingRecord {
  return {
    bindingId,
    providerId: CODEX_PROVIDER_ID,
    workspaceId: assignment.workspaceId,
    workspacePath: path.normalize(assignment.workspacePath),
    missionId: assignment.missionId,
    taskId: assignment.taskId,
    assignmentId: assignment.assignmentId,
    roleProfileId: assignment.roleProfileId,
    threadId,
    state: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function assignmentMatchesBinding(
  assignment: MissionRoleAssignment,
  binding: CodexThreadBindingRecord,
  platform: NodeJS.Platform,
): boolean {
  return (
    assignment.workspaceId === binding.workspaceId &&
    samePath(assignment.workspacePath, binding.workspacePath, platform) &&
    assignment.missionId === binding.missionId &&
    assignment.taskId === binding.taskId &&
    assignment.assignmentId === binding.assignmentId &&
    assignment.roleProfileId === binding.roleProfileId
  );
}

export class CodexMissionProviderAdapter
  implements MissionAgentProviderAdapter
{
  readonly providerId = CODEX_PROVIDER_ID;
  private readonly listeners = new Set<(event: MissionProviderEvent) => void>();
  private readonly outputByAssignment = new Map<string, string>();
  private readonly assignmentByThread = new Map<string, string>();
  private readonly completedTurns = new Map<string, 'idle' | 'failed'>();
  private closing = false;
  private statusValue: MissionProviderStatus = {
    providerId: CODEX_PROVIDER_ID,
    displayName: 'Codex',
    available: false,
    authenticated: false,
    persistentConversations: true,
    approvals: true,
    diagnostic: 'Codex App Server has not connected.',
  };

  constructor(private readonly options: CodexMissionProviderAdapterOptions) {
    options.client.onEvent((event) => this.handleEvent(event));
    this.rebuildThreadIndex();
  }

  get status(): MissionProviderStatus {
    return this.statusValue;
  }

  async connect(): Promise<MissionProviderStatus> {
    if (this.closing) return this.statusValue;
    try {
      const state = await this.options.client.connect();
      this.statusValue = {
        providerId: CODEX_PROVIDER_ID,
        displayName: 'Codex',
        available: state.initialized,
        authenticated: state.account?.authenticated === true,
        persistentConversations: true,
        approvals: true,
        diagnostic: state.diagnostic,
      };
    } catch (error) {
      this.statusValue = {
        ...this.statusValue,
        available: false,
        authenticated: false,
        diagnostic: errorMessage(error),
      };
    }
    return this.statusValue;
  }

  async ensureConversation(
    assignment: MissionRoleAssignment,
    expectedBindingRevision: number,
  ): Promise<MissionProviderResult<MissionConversation>> {
    if (this.closing) return failure('shutting-down', 'Codex is shutting down.');
    const invalid = validateAssignment(assignment);
    if (invalid !== undefined) return failure('invalid-assignment', invalid);
    if (!this.status.available) {
      await this.connect();
    }
    if (!this.status.available) {
      return failure(
        'unavailable',
        this.status.diagnostic ?? 'Codex App Server is unavailable.',
      );
    }
    if (!this.status.authenticated) {
      return failure(
        'unauthenticated',
        'Sign in with Codex through the provider-owned Codex surface.',
      );
    }
    await this.options.bindings.reload();
    const existing = this.options.bindings.getBinding(assignment.assignmentId);
    if (existing !== undefined) {
      if (
        !assignmentMatchesBinding(
          assignment,
          existing,
          this.options.platform ?? process.platform,
        )
      ) {
        return failure(
          'conflict',
          'That assignment ID already owns a different Codex conversation.',
        );
      }
      return this.resumeExact(existing);
    }
    const timestamp = (this.options.now?.() ?? new Date()).toISOString();
    const operationId =
      this.options.operationId?.() ?? `codex-start-${randomUUID()}`;
    const pending: PendingCodexThreadStart = {
      operationId,
      providerId: CODEX_PROVIDER_ID,
      workspaceId: assignment.workspaceId,
      workspacePath: path.normalize(assignment.workspacePath),
      missionId: assignment.missionId,
      taskId: assignment.taskId,
      assignmentId: assignment.assignmentId,
      roleProfileId: assignment.roleProfileId,
      requestFingerprint: assignment.requestFingerprint,
      startedAt: timestamp,
    };
    try {
      await this.options.bindings.beginStart(
        expectedBindingRevision,
        pending,
      );
      const started = await this.options.client.startThread({
        cwd: pending.workspacePath,
        approvalPolicy: 'on-request',
        sandbox:
          assignment.accessMode === 'read-only'
            ? 'read-only'
            : 'workspace-write',
        developerInstructions: assignment.roleInstructions,
        ...(assignment.model === undefined ? {} : { model: assignment.model }),
      });
      if (
        !samePath(
          started.cwd,
          pending.workspacePath,
          this.options.platform ?? process.platform,
        ) ||
        !samePath(
          started.thread.cwd,
          pending.workspacePath,
          this.options.platform ?? process.platform,
        )
      ) {
        return failure(
          'provider-failure',
          'Codex started outside the exact Council assignment workspace. The pending start was preserved for inspection.',
        );
      }
      const binding = threadBinding(
        assignment,
        started.thread.id,
        this.options.bindingId?.() ?? `codex-binding-${randomUUID()}`,
        timestamp,
      );
      const committed = await this.options.bindings.commitStart(
        expectedBindingRevision + 1,
        operationId,
        binding,
      );
      this.assignmentByThread.set(committed.threadId, committed.assignmentId);
      return {
        ok: true,
        value: {
          providerId: CODEX_PROVIDER_ID,
          providerConversationId: committed.threadId,
          assignmentId: committed.assignmentId,
          resumed: false,
        },
      };
    } catch (error) {
      return failure(providerFailureKind(error), errorMessage(error));
    }
  }

  async resumeConversation(
    assignmentId: string,
  ): Promise<MissionProviderResult<MissionConversation>> {
    if (this.closing) return failure('shutting-down', 'Codex is shutting down.');
    await this.options.bindings.reload();
    const binding = this.options.bindings.getBinding(assignmentId);
    if (binding === undefined) {
      return failure(
        'invalid-assignment',
        'That assignment has no exact Codex thread binding.',
      );
    }
    return this.resumeExact(binding);
  }

  async dispatchTurn(
    assignmentId: string,
    taskPrompt: string,
  ): Promise<MissionProviderResult<MissionTurn>> {
    if (this.closing) return failure('shutting-down', 'Codex is shutting down.');
    const maximum = this.options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    if (
      taskPrompt.trim() === '' ||
      taskPrompt.length > maximum ||
      /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(taskPrompt)
    ) {
      return failure(
        'invalid-assignment',
        `Codex task prompt must be 1–${maximum.toLocaleString('en-US')} characters without unsafe control bytes.`,
      );
    }
    await this.options.bindings.reload();
    const binding = this.options.bindings.getBinding(assignmentId);
    if (binding === undefined) {
      return failure(
        'invalid-assignment',
        'That assignment has no exact Codex thread binding.',
      );
    }
    if (binding.state === 'active') {
      return failure(
        'conflict',
        'That exact Codex assignment already has an active turn.',
      );
    }
    try {
      const turn = await this.options.client.startTurn({
        threadId: binding.threadId,
        text: taskPrompt,
        cwd: binding.workspacePath,
        approvalPolicy: 'on-request',
      });
      const expectedRevision = this.options.bindings.state.data.revision;
      await this.options.bindings.updateTurn(
        expectedRevision,
        assignmentId,
        turn.id,
        'active',
      );
      const completedState = this.completedTurns.get(
        `${binding.threadId}\0${turn.id}`,
      );
      if (completedState !== undefined) {
        this.completedTurns.delete(`${binding.threadId}\0${turn.id}`);
        await this.options.bindings.updateTurn(
          this.options.bindings.state.data.revision,
          assignmentId,
          undefined,
          completedState,
        );
      }
      return {
        ok: true,
        value: {
          providerId: CODEX_PROVIDER_ID,
          providerConversationId: binding.threadId,
          providerTurnId: turn.id,
          assignmentId,
        },
      };
    } catch (error) {
      return failure(providerFailureKind(error), errorMessage(error));
    }
  }

  async interruptTurn(
    assignmentId: string,
  ): Promise<MissionProviderResult<void>> {
    await this.options.bindings.reload();
    const binding = this.options.bindings.getBinding(assignmentId);
    if (binding?.state !== 'active' || binding.activeTurnId === undefined) {
      return failure(
        'invalid-assignment',
        'That assignment has no exact active Codex turn.',
      );
    }
    try {
      await this.options.client.interruptTurn(
        binding.threadId,
        binding.activeTurnId,
      );
      await this.options.bindings.updateTurn(
        this.options.bindings.state.data.revision,
        assignmentId,
        undefined,
        'idle',
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(providerFailureKind(error), errorMessage(error));
    }
  }

  async resolveApproval(
    approvalId: string,
    decision: MissionApprovalDecision,
  ): Promise<MissionProviderResult<void>> {
    try {
      await this.options.client.resolveApproval(approvalId, decision);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(providerFailureKind(error), errorMessage(error));
    }
  }

  recentOutput(assignmentId: string): string {
    return this.outputByAssignment.get(assignmentId) ?? '';
  }

  onEvent(listener: (event: MissionProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.options.bindings.reload();
    for (const binding of Object.values(
      this.options.bindings.state.data.bindings,
    )) {
      if (binding.state !== 'active' || binding.activeTurnId === undefined) continue;
      try {
        await this.options.client.interruptTurn(
          binding.threadId,
          binding.activeTurnId,
        );
        await this.options.bindings.reload();
        const current = this.options.bindings.getBinding(binding.assignmentId);
        if (
          current?.state === 'active' &&
          current.activeTurnId === binding.activeTurnId
        ) {
          await this.options.bindings.updateTurn(
            this.options.bindings.state.data.revision,
            binding.assignmentId,
            undefined,
            'idle',
          );
        }
      } catch {
        // Closing the owned App Server still ends the transport fail-closed.
      }
    }
    await this.options.client.stop();
  }

  private async resumeExact(
    binding: CodexThreadBindingRecord,
  ): Promise<MissionProviderResult<MissionConversation>> {
    try {
      const resumed = await this.options.client.resumeThread(
        binding.threadId,
        binding.workspacePath,
      );
      if (
        resumed.id !== binding.threadId ||
        !samePath(
          resumed.cwd,
          binding.workspacePath,
          this.options.platform ?? process.platform,
        )
      ) {
        return failure(
          'provider-failure',
          'Codex did not resume the exact bound thread and workspace.',
        );
      }
      this.assignmentByThread.set(binding.threadId, binding.assignmentId);
      return {
        ok: true,
        value: {
          providerId: CODEX_PROVIDER_ID,
          providerConversationId: binding.threadId,
          assignmentId: binding.assignmentId,
          resumed: true,
        },
      };
    } catch (error) {
      return failure(providerFailureKind(error), errorMessage(error));
    }
  }

  private rebuildThreadIndex(): void {
    this.assignmentByThread.clear();
    for (const binding of Object.values(
      this.options.bindings.state.data.bindings,
    )) {
      this.assignmentByThread.set(binding.threadId, binding.assignmentId);
    }
  }

  private handleEvent(event: CodexAppServerEvent): void {
    let projected: MissionProviderEvent | undefined;
    if (event.type === 'connection') {
      this.statusValue = {
        ...this.statusValue,
        available: event.state.initialized,
        authenticated: event.state.account?.authenticated === true,
        diagnostic: event.state.diagnostic,
      };
      projected = {
        type: 'status',
        providerId: CODEX_PROVIDER_ID,
        status: this.statusValue,
      };
    }
    if (event.type === 'output') {
      const assignmentId = this.assignmentByThread.get(event.threadId);
      if (assignmentId !== undefined) {
        const maximum = this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
        const existing = this.outputByAssignment.get(assignmentId) ?? '';
        this.outputByAssignment.set(
          assignmentId,
          `${existing}${event.delta}`.slice(-maximum),
        );
      }
      projected = {
        type: 'output',
        providerId: CODEX_PROVIDER_ID,
        providerConversationId: event.threadId,
        providerTurnId: event.turnId,
        assignmentId,
        text: event.delta,
        truncated: event.truncated,
      };
    }
    if (event.type === 'turn-completed') {
      const assignmentId = this.assignmentByThread.get(event.threadId);
      const status =
        typeof event.payload === 'object' &&
        event.payload !== null &&
        'status' in event.payload &&
        event.payload.status === 'failed'
          ? 'failed'
          : 'idle';
      this.completedTurns.set(`${event.threadId}\0${event.turnId}`, status);
      if (assignmentId !== undefined) {
        void this.finishTurnFromEvent(assignmentId, event.turnId, status);
      }
      projected = {
        type: 'turn',
        providerId: CODEX_PROVIDER_ID,
        providerConversationId: event.threadId,
        providerTurnId: event.turnId,
        assignmentId,
        state: status === 'failed' ? 'failed' : 'completed',
      };
    }
    if (event.type === 'turn-started') {
      projected = {
        type: 'turn',
        providerId: CODEX_PROVIDER_ID,
        providerConversationId: event.threadId,
        providerTurnId: event.turnId,
        assignmentId: this.assignmentByThread.get(event.threadId),
        state: 'started',
      };
    }
    if (event.type === 'thread-started' || event.type === 'thread-status') {
      const rawType =
        typeof event.payload === 'object' &&
        event.payload !== null &&
        'type' in event.payload
          ? event.payload.type
          : undefined;
      projected = {
        type: 'conversation',
        providerId: CODEX_PROVIDER_ID,
        providerConversationId: event.threadId,
        assignmentId: this.assignmentByThread.get(event.threadId),
        state:
          event.type === 'thread-started'
            ? 'started'
            : rawType === 'active'
              ? 'active'
              : rawType === 'systemError'
                ? 'failed'
                : 'idle',
      };
    }
    if (event.type === 'approval-requested') {
      projected = {
        type: 'approval',
        providerId: CODEX_PROVIDER_ID,
        approvalId: event.approval.approvalId,
        assignmentId: this.assignmentByThread.get(event.approval.threadId),
        state: 'pending',
        kind: event.approval.kind,
        summary:
          event.approval.command ??
          event.approval.reason ??
          'Codex requested approval.',
      };
    }
    if (event.type === 'approval-resolved') {
      projected = {
        type: 'approval',
        providerId: CODEX_PROVIDER_ID,
        approvalId: event.approvalId,
        assignmentId: undefined,
        state: event.decision === 'expired' ? 'expired' : 'resolved',
        ...(event.decision === 'expired'
          ? {}
          : { decision: event.decision }),
      };
    }
    if (event.type === 'provider-error' || event.type === 'protocol-warning') {
      projected = {
        type: 'error',
        providerId: CODEX_PROVIDER_ID,
        message: event.message,
      };
    }
    if (projected === undefined) return;
    for (const listener of this.listeners) {
      try {
        listener(projected);
      } catch {
        // Consumers cannot destabilize the provider transport.
      }
    }
  }

  private async finishTurnFromEvent(
    assignmentId: string,
    turnId: string,
    state: 'idle' | 'failed',
  ): Promise<void> {
    await this.options.bindings.reload();
    const binding = this.options.bindings.getBinding(assignmentId);
    if (
      binding?.state !== 'active' ||
      binding.activeTurnId !== turnId
    ) {
      return;
    }
    try {
      await this.options.bindings.updateTurn(
        this.options.bindings.state.data.revision,
        assignmentId,
        undefined,
        state,
      );
      this.completedTurns.delete(`${binding.threadId}\0${turnId}`);
    } catch {
      // The durable store remains authoritative and exposes its own problem.
    }
  }
}

export function fingerprintCodexAssignment(
  assignment: Omit<MissionRoleAssignment, 'requestFingerprint'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        providerId: CODEX_PROVIDER_ID,
        workspaceId: assignment.workspaceId,
        workspacePath: path.normalize(assignment.workspacePath),
        missionId: assignment.missionId,
        taskId: assignment.taskId,
        assignmentId: assignment.assignmentId,
        roleProfileId: assignment.roleProfileId,
        roleInstructions: assignment.roleInstructions,
        accessMode: assignment.accessMode,
        model: assignment.model ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}
