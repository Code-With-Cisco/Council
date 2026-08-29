import { randomUUID } from 'node:crypto';
import type { CliResult } from '../integration/types.js';
import type { AgentSupervisorPort } from '../supervisor/contracts.js';
import type { MissionUiController } from './missionUi.js';
import type { AppUpdateState } from './appUpdater.js';
import type { AgentPackInstallResult, AgentPackUninstallResult } from './agentPack.js';
import { sanitizeTerminalOutput } from './logOutput.js';
import {
  IPC_CHANNELS,
  type UiFailure,
  type UiResult,
  type UiState,
} from './ipc.js';
import {
  validateCouncilQuestion,
  validateCreateCandidateInput,
  validateCreateMissionInput,
  validateDefinitionFingerprint,
  validateInitialMessage,
  validateMissionDigest,
  validatePreviewIntegrationInput,
  validatePreviewSquadInput,
  validateRecordGateInput,
  validateRecordHandoffInput,
  validateRetryMissionExecutionInput,
  validateProfileId,
  validateReplyText,
} from './ipcValidation.js';

export interface IpcRegistrar {
  handle(
    channel: string,
    listener: (event: unknown, ...args: readonly unknown[]) => unknown,
  ): void;
}

export interface CouncilIpcDependencies {
  readonly isTrusted: (event: unknown) => boolean;
  readonly getState: () => UiState | undefined;
  readonly chooseWorkspace: () => Promise<UiResult<UiState>>;
  readonly activateWorkspace?: ((workspaceId: string) => Promise<UiResult<UiState>>) | undefined;
  readonly getSupervisor: () => AgentSupervisorPort | undefined;
  readonly getMissionController: () => MissionUiController | undefined;
  readonly recoverSupervisor: () => Promise<UiResult<import('../integration/types.js').DaemonStopOutcome>>;
  readonly refreshDiagnostics?: () => Promise<UiResult<import('./ipc.js').UiLaunchPreflight>>;
  readonly installAgentPack?: (() => Promise<UiResult<AgentPackInstallResult>>) | undefined;
  readonly uninstallAgentPack?: (() => Promise<UiResult<AgentPackUninstallResult>>) | undefined;
  readonly getUpdateState?: (() => AppUpdateState) | undefined;
  readonly checkForUpdates?: (() => Promise<UiResult<AppUpdateState>>) | undefined;
  readonly downloadUpdate?: (() => Promise<UiResult<AppUpdateState>>) | undefined;
  readonly installUpdate?: (() => Promise<UiResult<'restarting'>>) | undefined;
  /** True only while the current definition projection is authoritative. */
  readonly canLaunchDefinitions: () => boolean;
  readonly confirmStartNew: () => Promise<boolean>;
  readonly confirmStartSquad: () => Promise<boolean>;
  readonly confirmMissionIntegration: () => Promise<boolean>;
  readonly recordDiagnostic?: ((entry: {
    readonly id: string;
    readonly occurredAt: string;
    readonly operation: string;
    readonly code: string;
    readonly errorName: string;
    readonly message: string;
  }) => Promise<void>) | undefined;
  readonly afterAction: <T>(result: CliResult<T>) => Promise<UiResult<T>>;
}

function unavailable(message: string): UiFailure {
  return { ok: false, message };
}

function profileIdOrFailure(value: unknown): string | UiFailure {
  return validateProfileId(value) ?? unavailable('Invalid opaque profile ID.');
}

async function runMissionAction<T>(
  dependencies: CouncilIpcDependencies,
  operation: string,
  action: (controller: MissionUiController) => Promise<T>,
): Promise<UiResult<T>> {
  const controller = dependencies.getMissionController();
  if (controller === undefined) {
    return unavailable('Mission coordination is unavailable.');
  }
  try {
    return { ok: true, value: await action(controller) };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const rawMessage = error instanceof Error ? error.message : String(error);
    const lower = rawMessage.toLocaleLowerCase('en-US');
    const code: NonNullable<UiFailure['code']> =
      errorName === 'StaleMissionPlanError' ||
      errorName.endsWith('ConflictError') ||
      lower.includes('revision') ||
      lower.includes('changed after') ||
      lower.includes('refresh before')
        ? 'stale-revision'
        : lower.includes('provider') ||
            lower.includes('codex') ||
            lower.includes('claude') ||
            lower.includes('authentication')
          ? 'provider-unavailable'
          : errorName.includes('Worktree') ||
              errorName === 'MissionGitAdapterError' ||
              lower.includes('worktree')
            ? 'worktree-failure'
            : lower.includes('ledger') || errorName.includes('StoreBlocked')
              ? 'ledger-blocked'
              : errorName === 'MissionUiControllerError' ||
                  errorName === 'MissionDomainError'
                ? 'invalid-assignment'
                : 'unexpected';
    const safeExpected =
      code !== 'unexpected' &&
      rawMessage.length > 0 &&
      rawMessage.length <= 2_000 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rawMessage) &&
      !/(?:\b(?:sk-ant|sk-proj|sess|key)-[A-Za-z0-9_-]{8,}\b|authorization\s*:|api[_-]?key\s*[=:])/i.test(rawMessage) &&
      !/(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:[^/\s]+\/)+)/.test(rawMessage);
    const correlationId = `mission-${randomUUID().slice(0, 8)}`;
    await dependencies.recordDiagnostic?.({
      id: correlationId,
      occurredAt: new Date().toISOString(),
      operation,
      code,
      errorName,
      message: rawMessage,
    });
    const recommendedAction =
      code === 'stale-revision'
        ? 'Refresh Mission state, review the changed plan, and retry.'
        : code === 'provider-unavailable'
          ? 'Open Diagnostics, restore the selected provider, and retry this step.'
          : code === 'worktree-failure'
            ? 'Check repository and worktree diagnostics before retrying.'
            : code === 'ledger-blocked'
              ? 'Repair or restore the Mission ledger before making further changes.'
              : code === 'invalid-assignment'
                ? 'Review the selected roles and current Mission state, then edit or retry.'
                : 'Copy the correlation ID from Diagnostics and inspect the local diagnostic journal.';
    return {
      ok: false,
      code,
      operation,
      correlationId,
      recommendedAction,
      message: safeExpected
        ? rawMessage
        : `Mission ${operation} failed unexpectedly (${correlationId}).`,
    };
  }
}

/**
 * Registers the renderer's entire privileged action surface.
 *
 * The module is Electron-light: main supplies sender trust and confirmation
 * dialogs, while tests can invoke every handler without creating a window.
 */
export function registerCouncilIpc(
  registrar: IpcRegistrar,
  dependencies: CouncilIpcDependencies,
): void {
  registrar.handle(IPC_CHANNELS.getState, (event) => {
    if (!dependencies.isTrusted(event)) throw new Error('Untrusted IPC sender');
    const state = dependencies.getState();
    if (state === undefined) throw new Error('Application startup is not complete');
    return state;
  });

  registrar.handle(IPC_CHANNELS.chooseWorkspace, (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.chooseWorkspace();
  });

  registrar.handle(IPC_CHANNELS.startMember, async (
    event,
    rawProfileId,
    rawDefinitionFingerprint,
  ) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    if (!dependencies.canLaunchDefinitions()) {
      return unavailable(
        'Agent definitions are stale or runtime launch is unavailable. Resolve Diagnostics before starting.',
      );
    }
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude integration is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    const definitionFingerprint = validateDefinitionFingerprint(
      rawDefinitionFingerprint,
    );
    if (definitionFingerprint === undefined) {
      return unavailable('Invalid displayed definition fingerprint.');
    }
    return dependencies.afterAction(
      await supervisor.startMember(profileId, definitionFingerprint),
    );
  });

  registrar.handle(IPC_CHANNELS.startNewMember, async (
    event,
    rawProfileId,
    rawDefinitionFingerprint,
  ) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    if (!dependencies.canLaunchDefinitions()) {
      return unavailable(
        'Agent definitions are stale or runtime launch is unavailable. Resolve Diagnostics before starting.',
      );
    }
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude integration is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    const definitionFingerprint = validateDefinitionFingerprint(
      rawDefinitionFingerprint,
    );
    if (definitionFingerprint === undefined) {
      return unavailable('Invalid displayed definition fingerprint.');
    }
    if (!(await dependencies.confirmStartNew())) return unavailable('Start new was canceled.');
    return dependencies.afterAction(
      await supervisor.startNewMember(profileId, definitionFingerprint),
    );
  });

  registrar.handle(IPC_CHANNELS.resumeMember, async (event, rawProfileId) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude integration is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    return dependencies.afterAction(await supervisor.resumeMember(profileId));
  });

  registrar.handle(IPC_CHANNELS.clearBinding, async (event, rawProfileId) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude integration is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    return dependencies.afterAction(await supervisor.clearBinding(profileId));
  });

  registrar.handle(IPC_CHANNELS.stopSession, async (event, rawProfileId) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude CLI is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    return dependencies.afterAction(await supervisor.stopSession(profileId));
  });

  registrar.handle(IPC_CHANNELS.wakeSquad, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude integration is unavailable.');
    return dependencies.afterAction(await supervisor.wakeSquad());
  });

  registrar.handle(IPC_CHANNELS.activateWorkspace, (event, rawWorkspaceId) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    if (typeof rawWorkspaceId !== 'string' || rawWorkspaceId.length > 80) {
      return unavailable('Invalid workspace ID.');
    }
    return dependencies.activateWorkspace?.(rawWorkspaceId) ?? unavailable('Saved workspace switching is unavailable.');
  });

  registrar.handle(IPC_CHANNELS.startMemberWithMessage, async (
    event,
    rawProfileId,
    rawDefinitionFingerprint,
    rawMessage,
  ) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    if (!dependencies.canLaunchDefinitions()) {
      return unavailable('Agent definitions are stale or runtime launch is unavailable. Resolve Diagnostics before starting.');
    }
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude integration is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    const definitionFingerprint = validateDefinitionFingerprint(rawDefinitionFingerprint);
    if (definitionFingerprint === undefined) return unavailable('Invalid displayed definition fingerprint.');
    const message = validateInitialMessage(rawMessage);
    if (message === undefined) return unavailable('Initial message must be plain text between 1 and 20,000 characters.');
    return dependencies.afterAction(
      await supervisor.startMemberWithMessage(profileId, definitionFingerprint, message),
    );
  });

  registrar.handle(IPC_CHANNELS.recoverSupervisor, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.recoverSupervisor();
  });

  registrar.handle(IPC_CHANNELS.refreshDiagnostics, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.refreshDiagnostics?.() ?? unavailable('Diagnostics refresh is unavailable.');
  });

  registrar.handle(IPC_CHANNELS.installAgentPack, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.installAgentPack?.() ?? unavailable('Agent Pack installation is unavailable.');
  });

  registrar.handle(IPC_CHANNELS.uninstallAgentPack, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.uninstallAgentPack?.() ?? unavailable('Agent Pack uninstall is unavailable.');
  });

  registrar.handle(IPC_CHANNELS.getUpdateState, (event) => {
    if (!dependencies.isTrusted(event)) throw new Error('Untrusted IPC sender');
    const state = dependencies.getUpdateState?.();
    if (state === undefined) throw new Error('Application updater is unavailable');
    return state;
  });

  registrar.handle(IPC_CHANNELS.checkForUpdates, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.checkForUpdates?.() ?? unavailable('Application updater is unavailable.');
  });

  registrar.handle(IPC_CHANNELS.downloadUpdate, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.downloadUpdate?.() ?? unavailable('Application updater is unavailable.');
  });

  registrar.handle(IPC_CHANNELS.installUpdate, async (event) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    return dependencies.installUpdate?.() ?? unavailable('Application updater is unavailable.');
  });

  registrar.handle(IPC_CHANNELS.logs, async (event, rawProfileId) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude CLI is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    const result = await supervisor.logs(profileId);
    return dependencies.afterAction(
      result.ok ? { ...result, value: sanitizeTerminalOutput(result.value) } : result,
    );
  });

  registrar.handle(IPC_CHANNELS.reply, async (event, rawProfileId, rawMessage) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude CLI is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    const message = validateReplyText(rawMessage);
    if (message === undefined) {
      return unavailable('Reply must be 1–8,000 characters of one-line plain text.');
    }
    return dependencies.afterAction(await supervisor.reply(profileId, message));
  });

  registrar.handle(IPC_CHANNELS.council, async (
    event,
    rawQuestion,
    rawDefinitionFingerprint,
  ) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    if (!dependencies.canLaunchDefinitions()) {
      return unavailable(
        'Agent definitions are stale or runtime launch is unavailable. Resolve Diagnostics before convening Council.',
      );
    }
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude integration is unavailable.');
    const question = validateCouncilQuestion(rawQuestion);
    if (question === undefined) {
      return unavailable('Council question is empty, too large, or contains control bytes.');
    }
    const definitionFingerprint = validateDefinitionFingerprint(
      rawDefinitionFingerprint,
    );
    if (definitionFingerprint === undefined) {
      return unavailable('Invalid displayed Council definition fingerprint.');
    }
    let replaceExisting = false;
    if (supervisor.councilReviewNeedsReplacement()) {
      if (!(await dependencies.confirmStartNew())) {
        return unavailable('Start new was canceled.');
      }
      replaceExisting = true;
    }
    return dependencies.afterAction(
      await supervisor.startCouncilReview(
        question,
        definitionFingerprint,
        replaceExisting,
      ),
    );
  });

  registrar.handle(IPC_CHANNELS.getMissionState, async (event) => {
    if (!dependencies.isTrusted(event)) {
      return unavailable('Untrusted IPC sender.');
    }
    return runMissionAction(dependencies, 'refresh state', (controller) =>
      controller.getState(),
    );
  });

  registrar.handle(IPC_CHANNELS.createMission, async (event, rawInput) => {
    if (!dependencies.isTrusted(event)) {
      return unavailable('Untrusted IPC sender.');
    }
    const input = validateCreateMissionInput(rawInput);
    if (input === undefined) {
      return unavailable('Invalid bounded Mission draft.');
    }
    return runMissionAction(dependencies, 'create draft', (controller) =>
      controller.createMission(input),
    );
  });

  registrar.handle(IPC_CHANNELS.previewSquad, async (event, rawInput) => {
    if (!dependencies.isTrusted(event)) {
      return unavailable('Untrusted IPC sender.');
    }
    const input = validatePreviewSquadInput(rawInput);
    if (input === undefined) {
      return unavailable('Invalid opaque squad preview request.');
    }
    return runMissionAction(dependencies, 'preview squad', (controller) =>
      controller.previewSquad(input),
    );
  });

  registrar.handle(IPC_CHANNELS.startSquad, async (event, rawDigest) => {
    if (!dependencies.isTrusted(event)) {
      return unavailable('Untrusted IPC sender.');
    }
    const digest = validateMissionDigest(rawDigest);
    if (digest === undefined) {
      return unavailable('Invalid squad preview fingerprint.');
    }
    if (!(await dependencies.confirmStartSquad())) {
      return unavailable('Start Squad was canceled.');
    }
    return runMissionAction(dependencies, 'start squad', (controller) =>
      controller.startSquad(digest),
    );
  });

  registrar.handle(
    IPC_CHANNELS.retryMissionExecution,
    async (event, rawInput) => {
      if (!dependencies.isTrusted(event)) {
        return unavailable('Untrusted IPC sender.');
      }
      const input = validateRetryMissionExecutionInput(rawInput);
      if (input === undefined) {
        return unavailable('Invalid blocked Mission execution retry.');
      }
      return runMissionAction(dependencies, 'retry assignment', (controller) =>
        controller.retryBlockedExecution(input),
      );
    },
  );

  registrar.handle(IPC_CHANNELS.recordHandoff, async (event, rawInput) => {
    if (!dependencies.isTrusted(event)) {
      return unavailable('Untrusted IPC sender.');
    }
    const input = validateRecordHandoffInput(rawInput);
    if (input === undefined) {
      return unavailable('Invalid exact handoff evidence.');
    }
    return runMissionAction(dependencies, 'record handoff', (controller) =>
      controller.recordHandoff(input),
    );
  });

  registrar.handle(IPC_CHANNELS.createCandidate, async (event, rawInput) => {
    if (!dependencies.isTrusted(event)) {
      return unavailable('Untrusted IPC sender.');
    }
    const input = validateCreateCandidateInput(rawInput);
    if (input === undefined) {
      return unavailable('Invalid ordered handoff selection.');
    }
    return runMissionAction(dependencies, 'create candidate', (controller) =>
      controller.createCandidate(input),
    );
  });

  registrar.handle(IPC_CHANNELS.recordGate, async (event, rawInput) => {
    if (!dependencies.isTrusted(event)) {
      return unavailable('Untrusted IPC sender.');
    }
    const input = validateRecordGateInput(rawInput);
    if (input === undefined) {
      return unavailable('Invalid bounded gate request.');
    }
    return runMissionAction(dependencies, 'run gate', (controller) =>
      controller.recordGate(input),
    );
  });

  registrar.handle(
    IPC_CHANNELS.previewIntegration,
    async (event, rawInput) => {
      if (!dependencies.isTrusted(event)) {
        return unavailable('Untrusted IPC sender.');
      }
      const input = validatePreviewIntegrationInput(rawInput);
      if (input === undefined) {
        return unavailable('Invalid opaque integration preview request.');
      }
      return runMissionAction(dependencies, 'preview integration', (controller) =>
        controller.previewIntegration(input),
      );
    },
  );

  registrar.handle(
    IPC_CHANNELS.approveIntegration,
    async (event, rawDigest) => {
      if (!dependencies.isTrusted(event)) {
        return unavailable('Untrusted IPC sender.');
      }
      const digest = validateMissionDigest(rawDigest);
      if (digest === undefined) {
        return unavailable('Invalid integration approval fingerprint.');
      }
      if (!(await dependencies.confirmMissionIntegration())) {
        return unavailable('Integration approval was canceled.');
      }
      return runMissionAction(dependencies, 'approve integration', (controller) =>
        controller.approveIntegration(digest),
      );
    },
  );

  registrar.handle(
    IPC_CHANNELS.rejectIntegration,
    async (event, rawDigest) => {
      if (!dependencies.isTrusted(event)) {
        return unavailable('Untrusted IPC sender.');
      }
      const digest = validateMissionDigest(rawDigest);
      if (digest === undefined) {
        return unavailable('Invalid integration approval fingerprint.');
      }
      return runMissionAction(dependencies, 'reject integration', (controller) =>
        controller.rejectIntegration(digest),
      );
    },
  );
}
