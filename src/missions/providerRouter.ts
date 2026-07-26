import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { CliResult } from '../integration/types.js';
import type { StartSessionOutcome } from '../integration/client.js';
import type {
  MissionProviderStatus,
  CouncilAccessMode,
  CouncilProviderId,
} from '../providers/missionContracts.js';
import {
  CodexMissionProviderAdapter,
  fingerprintCodexAssignment,
} from '../providers/codex/adapter.js';
import type { CodexThreadBindingStore } from '../providers/codex/threadBindings.js';
import type {
  MissionBindingAccessMode,
  PendingLaunchRecord,
  SessionBindingRecord,
  SessionBindingStore,
} from '../supervisor/sessionBindings.js';
import type { MissionProviderPort } from './coordinator.js';
import { MAX_PREVIEW_ROLE_INSTRUCTIONS } from './types.js';

const CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface ResolvedMissionAssignment {
  readonly profileId: string;
  readonly definitionFingerprint: string;
  readonly roleInstructions: string;
  readonly taskPrompt: string;
  readonly model?: string | undefined;
  readonly launchable: boolean;
  readonly diagnostic?: string | undefined;
}

export interface ClaudeMissionLauncher {
  startMissionMember(
    profileId: string,
    missionExecutionId: string,
    expectedDefinitionFingerprint: string,
    taskPrompt: string,
    launchCwd: string,
    accessMode: CouncilAccessMode,
  ): Promise<CliResult<StartSessionOutcome>>;
}

export interface MissionProviderRouterOptions {
  readonly workspace: {
    readonly id: string;
    readonly canonicalPath: string;
    readonly trusted: boolean;
  };
  readonly resolveAssignment: (request: {
    readonly missionId: string;
    readonly taskId: string;
    readonly profileId: string;
    readonly expectedDefinitionFingerprint: string;
  }) => Promise<ResolvedMissionAssignment>;
  readonly claude:
    | {
        readonly launcher: ClaudeMissionLauncher;
        readonly bindings: SessionBindingStore;
        readonly available: () => boolean;
        readonly diagnostic?: (() => string | undefined) | undefined;
      }
    | undefined;
  readonly codex:
    | {
        readonly adapter: CodexMissionProviderAdapter;
        readonly bindings: CodexThreadBindingStore;
      }
    | undefined;
}

function providerStatus(
  providerId: CouncilProviderId,
  displayName: string,
  overrides: Partial<MissionProviderStatus>,
): MissionProviderStatus {
  return {
    providerId,
    displayName,
    available: false,
    authenticated: false,
    persistentConversations: true,
    approvals: providerId === 'codex',
    diagnostic: `${displayName} is unavailable.`,
    ...overrides,
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safePrompt(value: string, name: string): string {
  if (
    value.trim() === '' ||
    value.length > 100_000 ||
    CONTROL.test(value)
  ) {
    throw new Error(`${name} is empty, oversized, or contains unsafe control bytes.`);
  }
  return value;
}

function normalizeRoleInstructions(value: string): string {
  return safePrompt(
    value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'),
    'Role instructions',
  );
}

function fingerprintRoleInstructions(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function matchesMissionBinding(
  record: SessionBindingRecord | PendingLaunchRecord,
  request: {
    readonly executionId?: string | undefined;
    readonly accessMode: MissionBindingAccessMode;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly expectedDefinitionFingerprint: string;
  },
): boolean {
  return (
    request.executionId !== undefined &&
    record.profileId === request.profileId &&
    record.workspaceId === request.workspaceId &&
    record.missionExecutionId === request.executionId &&
    record.missionAccessMode === request.accessMode &&
    record.definitionFingerprint ===
      request.expectedDefinitionFingerprint &&
    (!('disposition' in record) ||
      record.disposition !== 'rejected-substitution')
  );
}

/**
 * Privileged provider router for Mission starts.
 *
 * The renderer selects only a stable provider ID. This router freshly resolves
 * role instructions and the task prompt, owns provider-native identity, and
 * never exposes an executable, cwd, credential, or arbitrary provider request.
 */
export class MissionProviderRouter implements MissionProviderPort {
  constructor(private readonly options: MissionProviderRouterOptions) {}

  statuses(): readonly MissionProviderStatus[] {
    const claudeAvailable =
      this.options.claude !== undefined && this.options.claude.available();
    return [
      providerStatus('claude-code', 'Claude Code', {
        available: claudeAvailable,
        authenticated: claudeAvailable,
        approvals: false,
        diagnostic: claudeAvailable
          ? this.options.claude?.diagnostic?.()
          : (this.options.claude?.diagnostic?.() ??
            'Claude Code is unavailable for new Mission assignments.'),
      }),
      this.options.codex?.adapter.status ??
        providerStatus('codex', 'Codex', {
          diagnostic: 'Codex App Server was not found.',
        }),
    ];
  }

  async previewStart(request: {
    readonly missionId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly providerId: CouncilProviderId;
    readonly expectedDefinitionFingerprint: string;
    readonly executionId?: string | undefined;
    readonly accessMode: CouncilAccessMode;
  }) {
    this.assertWorkspace(request.workspaceId);
    const assignment = await this.resolve(request);
    const roleInstructions = normalizeRoleInstructions(
      assignment.roleInstructions,
    );
    const previewStatus = this.statuses().find(
      (status) => status.providerId === request.providerId,
    );
    let launchable = assignment.launchable;
    let diagnostic = assignment.diagnostic;
    let action: 'start' | 'reuse' | 'resume' = 'start';

    if (request.providerId === 'codex') {
      const codex = this.options.codex;
      if (
        codex === undefined ||
        !codex.adapter.status.available ||
        !codex.adapter.status.authenticated
      ) {
        launchable = false;
        diagnostic =
          codex?.adapter.status.diagnostic ??
          'Codex App Server is unavailable or not authenticated.';
      }
    } else {
      const claude = this.options.claude;
      if (claude === undefined || !claude.available()) {
        launchable = false;
        diagnostic =
          claude?.diagnostic?.() ??
          'Claude Code is unavailable for new Mission assignments.';
      } else {
        await claude.bindings.reload();
        if (claude.bindings.problem !== undefined) {
          launchable = false;
          diagnostic = `Claude session bindings are unavailable: ${claude.bindings.problem.message}`;
        } else {
          const binding = claude.bindings.getBinding(
            request.profileId,
          );
          const pending = claude.bindings.getPendingLaunch(
            request.profileId,
          );
          if (binding !== undefined || pending !== undefined) {
            if (
              (binding !== undefined &&
                matchesMissionBinding(binding, request)) ||
              (pending !== undefined &&
                matchesMissionBinding(pending, request))
            ) {
              action = 'reuse';
            } else {
              launchable = false;
              diagnostic =
                'This Claude profile is owned by a different binding or pending launch. Existing non-Mission bindings cannot be claimed by a Mission.';
            }
          }
        }
      }
    }
    const previewableRoleInstructions =
      roleInstructions.length <= MAX_PREVIEW_ROLE_INSTRUCTIONS
        ? roleInstructions
        : undefined;
    if (previewableRoleInstructions === undefined) {
      launchable = false;
      diagnostic =
        `Effective role instructions exceed the ${MAX_PREVIEW_ROLE_INSTRUCTIONS}-character Start Squad preview limit. Shorten the role definition before launch.`;
    }

    return {
      taskId: request.taskId,
      profileId: request.profileId,
      providerId: request.providerId,
      definitionFingerprint: assignment.definitionFingerprint,
      roleInstructionFingerprint:
        fingerprintRoleInstructions(roleInstructions),
      providerAvailable: previewStatus?.available === true,
      providerAuthenticated:
        previewStatus?.authenticated === true,
      protocolReady: previewStatus?.available === true,
      ...(previewableRoleInstructions === undefined
        ? {}
        : { roleInstructions: previewableRoleInstructions }),
      action,
      launchable,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }

  async start(request: {
    readonly executionId: string;
    readonly missionId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly profileId: string;
    readonly providerId: string;
    readonly expectedDefinitionFingerprint: string;
    readonly action: 'start' | 'reuse' | 'resume';
    readonly missionObjective: string;
    readonly taskTitle: string;
    readonly taskDescription: string;
    readonly lease:
      | {
          readonly leaseId: string;
          readonly taskId: string;
          readonly branchName: string;
          readonly canonicalPath: string;
          readonly baseCommitSha: string;
          readonly baseTreeSha: string;
        }
      | undefined;
  }): Promise<{
    readonly providerId: string;
    readonly profileId: string;
    readonly providerResourceId: string;
  }> {
    this.assertWorkspace(request.workspaceId);
    const providerId = this.providerId(request.providerId);
    const assignment = await this.resolve({
      missionId: request.missionId,
      taskId: request.taskId,
      profileId: request.profileId,
      expectedDefinitionFingerprint:
        request.expectedDefinitionFingerprint,
    });
    if (!assignment.launchable) {
      throw new Error(
        assignment.diagnostic ?? 'The selected role is not launchable.',
      );
    }
    const missionObjective = safePrompt(
      request.missionObjective,
      'Mission objective',
    );
    const taskTitle = safePrompt(request.taskTitle, 'Mission task title');
    const taskDescription = safePrompt(
      request.taskDescription,
      'Mission task description',
    );
    const roleTaskPrompt = safePrompt(
      assignment.taskPrompt,
      'Role task guidance',
    );
    const taskPrompt = safePrompt(
      [
        'Mission objective:',
        missionObjective,
        '',
        `Assigned task: ${taskTitle}`,
        taskDescription,
        '',
        'Role-specific execution guidance:',
        roleTaskPrompt,
      ].join('\n'),
      'Mission task prompt',
    );
    const launchCwd = request.lease?.canonicalPath ??
      this.options.workspace.canonicalPath;
    if (!path.isAbsolute(launchCwd)) {
      throw new Error('Mission launch path must be an absolute privileged path.');
    }

    if (providerId === 'claude-code') {
      const claude = this.options.claude;
      if (claude === undefined || !claude.available()) {
        throw new Error(
          claude?.diagnostic?.() ?? 'Claude Code is unavailable.',
        );
      }
      const started = await claude.launcher.startMissionMember(
        request.profileId,
        request.executionId,
        request.expectedDefinitionFingerprint,
        taskPrompt,
        launchCwd,
        request.lease === undefined ? 'read-only' : 'workspace-write',
      );
      if (!started.ok) throw new Error(started.message);
      await claude.bindings.reload();
      const binding = claude.bindings.getBinding(request.profileId);
      if (
        binding === undefined ||
        binding.shortSessionId !== started.value.id ||
        binding.workspaceId !== request.workspaceId ||
        binding.profileId !== request.profileId ||
        binding.missionExecutionId !== request.executionId ||
        binding.missionAccessMode !==
          (request.lease === undefined
            ? 'read-only'
            : 'workspace-write') ||
        binding.definitionFingerprint !==
          request.expectedDefinitionFingerprint ||
        path.normalize(binding.requestedCanonicalCwd) !==
          path.normalize(launchCwd)
      ) {
        throw new Error(
          'Claude launched but no exact matching durable session binding was available.',
        );
      }
      return {
        providerId,
        profileId: request.profileId,
        providerResourceId:
          binding.fullSessionId ?? binding.shortSessionId,
      };
    }

    const codex = this.options.codex;
    if (codex === undefined) throw new Error('Codex App Server is unavailable.');
    await codex.bindings.reload();
    if (codex.bindings.state.writeBlocked) {
      throw new Error(
        codex.bindings.state.problem?.message ??
          'Codex thread bindings are write-blocked.',
      );
    }
    const roleInstructions = normalizeRoleInstructions(
      assignment.roleInstructions,
    );
    const requestFingerprint = fingerprintCodexAssignment({
      workspaceId: request.workspaceId,
      workspacePath: launchCwd,
      missionId: request.missionId,
      taskId: request.taskId,
      assignmentId: request.executionId,
      roleProfileId: request.profileId,
      roleInstructions,
      accessMode: request.lease === undefined ? 'read-only' : 'workspace-write',
      ...(assignment.model === undefined ? {} : { model: assignment.model }),
    });
    const conversation = await codex.adapter.ensureConversation(
      {
        workspaceId: request.workspaceId,
        workspacePath: launchCwd,
        missionId: request.missionId,
        taskId: request.taskId,
        assignmentId: request.executionId,
        roleProfileId: request.profileId,
        roleInstructions,
        requestFingerprint,
        accessMode:
          request.lease === undefined ? 'read-only' : 'workspace-write',
        ...(assignment.model === undefined ? {} : { model: assignment.model }),
      },
      codex.bindings.state.data.revision,
    );
    if (!conversation.ok) throw new Error(conversation.message);

    if (conversation.value.initialTaskDispatchState === 'pending') {
      throw new Error(
        'The initial Codex task dispatch has an uncertain outcome. Council will not duplicate it automatically.',
      );
    }
    if (conversation.value.initialTaskDispatchState === 'not-started') {
      const turn = await codex.adapter.dispatchTurn(
        request.executionId,
        taskPrompt,
      );
      if (!turn.ok) throw new Error(turn.message);
    }
    return {
      providerId,
      profileId: request.profileId,
      providerResourceId: conversation.value.providerConversationId,
    };
  }

  private async resolve(request: {
    readonly missionId: string;
    readonly taskId: string;
    readonly profileId: string;
    readonly expectedDefinitionFingerprint: string;
  }): Promise<ResolvedMissionAssignment> {
    try {
      const resolved = await this.options.resolveAssignment(request);
      if (
        resolved.profileId !== request.profileId ||
        resolved.definitionFingerprint !==
          request.expectedDefinitionFingerprint
      ) {
        throw new Error(
          'The role definition changed after it was displayed. Review a fresh Mission preview.',
        );
      }
      return resolved;
    } catch (error) {
      throw new Error(`Mission role resolution failed: ${messageFor(error)}`);
    }
  }

  private assertWorkspace(workspaceId: string): void {
    if (!this.options.workspace.trusted) {
      throw new Error('Trust this workspace before starting a Mission squad.');
    }
    if (workspaceId !== this.options.workspace.id) {
      throw new Error('Mission provider request belongs to another workspace.');
    }
  }

  private providerId(value: string): CouncilProviderId {
    if (value !== 'claude-code' && value !== 'codex') {
      throw new Error('Mission provider ID is unsupported.');
    }
    return value;
  }
}
