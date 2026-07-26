import type { CliResult } from '../integration/types.js';
import type { AgentSupervisorPort } from '../supervisor/contracts.js';
import {
  IPC_CHANNELS,
  type UiFailure,
  type UiResult,
  type UiState,
} from './ipc.js';
import {
  validateCouncilQuestion,
  validateDefinitionFingerprint,
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
  readonly getSupervisor: () => AgentSupervisorPort | undefined;
  /** True only while the current definition projection is authoritative. */
  readonly canLaunchDefinitions: () => boolean;
  readonly confirmStartNew: () => Promise<boolean>;
  readonly afterAction: <T>(result: CliResult<T>) => Promise<UiResult<T>>;
}

function unavailable(message: string): UiFailure {
  return { ok: false, message };
}

function profileIdOrFailure(value: unknown): string | UiFailure {
  return validateProfileId(value) ?? unavailable('Invalid opaque profile ID.');
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

  registrar.handle(IPC_CHANNELS.logs, async (event, rawProfileId) => {
    if (!dependencies.isTrusted(event)) return unavailable('Untrusted IPC sender.');
    const supervisor = dependencies.getSupervisor();
    if (supervisor === undefined) return unavailable('Claude CLI is unavailable.');
    const profileId = profileIdOrFailure(rawProfileId);
    if (typeof profileId !== 'string') return profileId;
    return dependencies.afterAction(await supervisor.logs(profileId));
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
}
