import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { StartSessionOutcome } from '../integration/client.js';
import type {
  CliFailure,
  CliFailureKind,
  CliResult,
  RosterMember,
  Session,
} from '../integration/types.js';
import { detectUnknownAgentWarning } from '../integration/cli/errors.js';
import type { AgentProviderAdapter } from '../providers/contracts.js';
import {
  resolveExactBindingSession,
  type MissionBindingAccessMode,
  type PendingLaunchRecord,
  type SessionBindingRecord,
  type SessionBindingStore,
  type SessionProviderId,
} from './sessionBindings.js';

export interface LaunchDefinitionResolution {
  readonly catalogId: string;
  readonly agentName: string;
  readonly fingerprint: string;
  readonly launchable: boolean;
  readonly definitionPath: string | undefined;
  readonly permissionMode?: string | undefined;
  readonly diagnostic?: string | undefined;
}

export interface LaunchWorkspace {
  readonly id: string;
  readonly canonicalPath: string;
  readonly trusted: boolean;
}

export interface SafeLaunchCoordinatorOptions {
  readonly provider: AgentProviderAdapter<SessionProviderId>;
  readonly bindings: SessionBindingStore;
  readonly workspace: LaunchWorkspace;
  readonly resolveProfile: (profileId: string) => RosterMember | undefined;
  /** Must rediscover from disk for every call. */
  readonly resolveDefinition: (
    profile: RosterMember,
  ) => Promise<LaunchDefinitionResolution | undefined>;
  /** Rechecks the executable, supported version, and non-interactive capability. */
  readonly verifyCapability: () => Promise<CliResult<unknown>>;
  /** Refreshes and publishes the authoritative supervisor snapshot. */
  readonly refresh: () => Promise<readonly Session[]>;
  /**
   * Privileged authorization for a launch directory outside the trusted source
   * checkout, such as an exact Council-owned Mission worktree lease.
   */
  readonly authorizeLaunchCwd?:
    | ((profileId: string, canonicalCwd: string) => Promise<boolean>)
    | undefined;
  readonly now?: (() => Date) | undefined;
  readonly uniqueId?: (() => string) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export interface StartProfileOptions {
  readonly replaceExisting?: boolean | undefined;
  /** Fail instead of returning an existing binding as a successful start. */
  readonly rejectExisting?: boolean | undefined;
  readonly promptOverride?: string | undefined;
  /** Privileged main-process path; never accepted from renderer IPC. */
  readonly launchCwd?: string | undefined;
  readonly expectedDefinitionFingerprint?: string | undefined;
  /** Privileged Mission-only override; never accepted from renderer IPC. */
  readonly permissionModeOverride?: 'plan' | undefined;
  readonly missionExecutionId?: string | undefined;
  readonly missionAccessMode?: MissionBindingAccessMode | undefined;
}

export interface ExactBoundSessionActionOptions<T> {
  readonly actionName: string;
  readonly missingMessage: string;
  readonly action: (
    session: Session,
    binding: SessionBindingRecord,
  ) => Promise<CliResult<T>>;
}

function failure(
  message: string,
  argv: readonly string[] = [],
  kind: CliFailureKind = 'cli-error',
  raw = '',
): CliFailure {
  return {
    ok: false,
    kind,
    message,
    raw,
    argv,
    exitCode: null,
    durationMs: 0,
  };
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return normalize(left) === normalize(right);
}

async function canonicalDirectory(directory: string): Promise<string> {
  let information;
  try {
    information = await stat(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Launch directory does not exist: ${directory}`);
    }
    throw new Error(
      `Launch directory is inaccessible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!information.isDirectory()) throw new Error(`Launch path is not a directory: ${directory}`);
  try {
    await access(directory, constants.R_OK);
    return await realpath(directory);
  } catch (error) {
    throw new Error(
      `Launch directory is inaccessible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isActive(session: Session): boolean {
  return session.state !== 'done' && session.state !== 'stopped' && session.state !== 'failed';
}

function outcomeForBinding(binding: SessionBindingRecord, session?: Session): StartSessionOutcome {
  return {
    id: binding.shortSessionId,
    name: session?.name ?? binding.uniqueLaunchName,
    unknownAgent: undefined,
  };
}

/**
 * Counts every roster row that could carry either persisted provider identity.
 * Clear binding is intentionally more conservative than action resolution:
 * an ambiguous duplicate or a short/full-ID disagreement means staleness has
 * not been proven, even though no single exact session can be selected safely.
 */
function bindingIdentityCandidateCount(
  binding: SessionBindingRecord,
  sessions: readonly Session[],
): number {
  return sessions.filter(
    (session) =>
      session.id === binding.shortSessionId ||
      (binding.fullSessionId !== undefined &&
        session.sessionId === binding.fullSessionId),
  ).length;
}

function matchesMissionLaunchIdentity(
  record: SessionBindingRecord | PendingLaunchRecord,
  profileId: string,
  options: StartProfileOptions,
  platform: NodeJS.Platform,
): boolean {
  return (
    options.missionExecutionId !== undefined &&
    options.missionAccessMode !== undefined &&
    options.expectedDefinitionFingerprint !== undefined &&
    options.launchCwd !== undefined &&
    record.profileId === profileId &&
    record.missionExecutionId === options.missionExecutionId &&
    record.missionAccessMode === options.missionAccessMode &&
    record.definitionFingerprint ===
      options.expectedDefinitionFingerprint &&
    samePath(
      record.requestedCanonicalCwd,
      options.launchCwd,
      platform,
    )
  );
}

/**
 * Serializes and journals all starts for one profile. It owns no provider
 * process itself; closing Council drains transactions and never deletes jobs.
 */
export class SafeLaunchCoordinator {
  private readonly starts = new Map<string, Promise<CliResult<StartSessionOutcome>>>();
  private readonly profileTails = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly volatileRejectedLaunches = new Set<string>();
  private readonly now: () => Date;
  private readonly uniqueId: () => string;
  private readonly platform: NodeJS.Platform;
  private closing = false;

  constructor(private readonly options: SafeLaunchCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.uniqueId = options.uniqueId ?? randomUUID;
    this.platform = options.platform ?? process.platform;
  }

  startProfile(
    profileId: string,
    options: StartProfileOptions = {},
  ): Promise<CliResult<StartSessionOutcome>> {
    if (this.closing) {
      return Promise.resolve(failure('Council is shutting down; no new launch was started.'));
    }
    if (
      (options.missionExecutionId === undefined) !==
      (options.missionAccessMode === undefined)
    ) {
      return Promise.resolve(
        failure(
          'Mission launch identity requires both execution ID and access mode.',
        ),
      );
    }
    const existing = this.starts.get(profileId);
    if (existing !== undefined) return existing;

    const transaction = this.withProfileLock(profileId, async () => {
      const result = await this.runStart(profileId, options);
      await this.options.refresh().catch(() => undefined);
      return result;
    }).finally(() => {
      if (this.starts.get(profileId) === transaction) this.starts.delete(profileId);
    });
    this.starts.set(profileId, transaction);
    return transaction;
  }

  resumeProfile(profileId: string): Promise<CliResult<string>> {
    if (this.closing) {
      return Promise.resolve(failure('Council is shutting down; Resume is unavailable.'));
    }
    return this.withProfileLock(profileId, async () => {
      const result = await this.runResumeProfile(profileId);
      await this.options.refresh().catch(() => undefined);
      return result;
    });
  }

  /**
   * Executes a provider-side privileged action only while holding the same
   * per-profile lock used by Start/Resume/Clear. The exact binding is reloaded
   * and compared immediately before the callback, so an action can never use a
   * provider ID made obsolete while the roster was being read.
   */
  exactBoundSessionAction<T>(
    profileId: string,
    options: ExactBoundSessionActionOptions<T>,
  ): Promise<CliResult<T>> {
    if (this.closing) {
      return Promise.resolve(
        failure(`Council is shutting down; ${options.actionName} is unavailable.`),
      );
    }
    return this.withProfileLock(profileId, async () => {
      const result = await this.runExactBoundSessionAction(profileId, options);
      await this.options.refresh().catch(() => undefined);
      return result;
    });
  }

  private async runExactBoundSessionAction<T>(
    profileId: string,
    options: ExactBoundSessionActionOptions<T>,
  ): Promise<CliResult<T>> {
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return failure(
        `Session bindings are malformed or unreadable: ${this.options.bindings.problem.message}`,
      );
    }
    const profile = this.options.resolveProfile(profileId);
    if (
      profile === undefined ||
      profile.key !== profileId ||
      profile.workspaceId !== this.options.workspace.id
    ) {
      return failure('That opaque profile is not authorized for the active workspace.');
    }
    const binding = this.options.bindings.getBinding(profileId);
    if (binding === undefined) return failure(options.missingMessage);
    if (
      binding.profileId !== profileId ||
      binding.workspaceId !== this.options.workspace.id
    ) {
      return failure('That binding is not authorized for the active workspace.');
    }

    const sessions = await this.options.provider.listSessions({ all: true });
    if (!sessions.ok) return sessions;
    const session = resolveExactBindingSession(binding, sessions.value);
    if (session?.id === undefined) return failure(options.missingMessage);

    // This is the binding CAS boundary. All in-app ownership mutations share
    // the profile lock, while reload also detects an external atomic edit.
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return failure(
        `Session bindings changed or became unreadable while ${options.actionName} was being prepared.`,
      );
    }
    const confirmed = this.options.bindings.getBinding(profileId);
    if (
      confirmed === undefined ||
      JSON.stringify(confirmed) !== JSON.stringify(binding)
    ) {
      return failure(
        `The exact binding changed while ${options.actionName} was being prepared.`,
      );
    }
    const confirmedProfile = this.options.resolveProfile(profileId);
    if (
      confirmedProfile === undefined ||
      confirmedProfile.key !== profileId ||
      confirmedProfile.workspaceId !== this.options.workspace.id
    ) {
      return failure(
        `The profile authorization changed while ${options.actionName} was being prepared.`,
      );
    }
    return options.action(session, confirmed);
  }

  private async runResumeProfile(profileId: string): Promise<CliResult<string>> {
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return failure(
        `Session bindings are malformed or unreadable: ${this.options.bindings.problem.message}`,
      );
    }
    const profile = this.options.resolveProfile(profileId);
    if (
      profile === undefined ||
      profile.key !== profileId ||
      profile.workspaceId !== this.options.workspace.id
    ) {
      return failure('That opaque profile is not authorized for the active workspace.');
    }
    const binding = this.options.bindings.getBinding(profileId);
    if (binding === undefined) return failure('This profile has no exact session binding to resume.');
    if (
      binding.profileId !== profileId ||
      binding.workspaceId !== this.options.workspace.id
    ) {
      return failure('That binding is not authorized for the active workspace.');
    }
    const sessions = await this.options.provider.listSessions({ all: true });
    if (!sessions.ok) return sessions;
    const session = resolveExactBindingSession(binding, sessions.value);
    if (session?.id === undefined) {
      return failure('The exact bound session is missing. Clear the stale binding or try again.');
    }
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return failure(
        'Session bindings changed or became unreadable while Resume was being prepared.',
      );
    }
    const confirmed = this.options.bindings.getBinding(profileId);
    if (
      confirmed === undefined ||
      JSON.stringify(confirmed) !== JSON.stringify(binding)
    ) {
      return failure('The exact binding changed while Resume was being prepared.');
    }
    const confirmedProfile = this.options.resolveProfile(profileId);
    if (
      confirmedProfile === undefined ||
      confirmedProfile.key !== profileId ||
      confirmedProfile.workspaceId !== this.options.workspace.id
    ) {
      return failure(
        'The profile authorization changed while Resume was being prepared.',
      );
    }
    if (isActive(session)) {
      return {
        ok: true,
        value: 'The exact bound session is already active.',
        raw: '',
        argv: ['respawn', session.id],
        durationMs: 0,
      };
    }
    return this.options.provider.resumeSession(session.id);
  }

  clearBinding(profileId: string): Promise<CliResult<string>> {
    if (this.closing) {
      return Promise.resolve(
        failure('Council is shutting down; Clear binding is unavailable.'),
      );
    }
    return this.withProfileLock(profileId, async () => {
      const result = await this.runClearBinding(profileId);
      await this.options.refresh().catch(() => undefined);
      return result;
    });
  }

  private async runClearBinding(profileId: string): Promise<CliResult<string>> {
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return failure(
        `Session bindings are malformed or unreadable and were not overwritten: ${this.options.bindings.problem.message}`,
      );
    }
    const profile = this.options.resolveProfile(profileId);
    if (
      profile === undefined ||
      profile.key !== profileId ||
      profile.workspaceId !== this.options.workspace.id
    ) {
      return failure('That opaque profile is not authorized for the active workspace.');
    }
    const binding = this.options.bindings.getBinding(profileId);
    if (
      binding !== undefined &&
      (binding.profileId !== profileId ||
        binding.workspaceId !== this.options.workspace.id)
    ) {
      return failure('That binding is not authorized for the active workspace.');
    }
    if (binding === undefined) {
      return {
        ok: true,
        value: 'No binding was present.',
        raw: '',
        argv: [],
        durationMs: 0,
      };
    }

    const sessions = await this.options.provider.listSessions({ all: true });
    if (!sessions.ok) return sessions;
    const exactSession = resolveExactBindingSession(binding, sessions.value);
    if (exactSession !== undefined) {
      return failure(
        `The exact bound session still exists (${exactSession.state}); the binding is not stale and was not cleared.`,
      );
    }
    if (bindingIdentityCandidateCount(binding, sessions.value) > 0) {
      return failure(
        'The provider roster contains ambiguous candidates for this binding; staleness could not be proven and the binding was not cleared.',
      );
    }

    // The provider roster proved the original identity absent. Re-read every
    // local authorization input and compare the exact record at the final
    // mutation boundary so neither an external edit nor a roster/profile
    // refresh can turn that proof into authority over a different binding.
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return failure(
        'Session bindings changed or became unreadable while Clear binding was being prepared.',
      );
    }
    const confirmed = this.options.bindings.getBinding(profileId);
    if (
      confirmed === undefined ||
      JSON.stringify(confirmed) !== JSON.stringify(binding)
    ) {
      return failure(
        'The exact binding changed while Clear binding was being prepared.',
      );
    }
    const confirmedProfile = this.options.resolveProfile(profileId);
    if (
      confirmedProfile === undefined ||
      confirmedProfile.key !== profileId ||
      confirmedProfile.workspaceId !== this.options.workspace.id
    ) {
      return failure(
        'The profile authorization changed while Clear binding was being prepared.',
      );
    }

    let previous: SessionBindingRecord | undefined;
    try {
      previous = await this.options.bindings.clearBinding(profileId, binding);
    } catch (error) {
      return failure(
        `Could not clear the binding safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      ok: true,
      value:
        previous === undefined
          ? 'No binding was present.'
          : 'Binding cleared. The Claude conversation was not stopped or deleted.',
      raw: '',
      argv: [],
      durationMs: 0,
    };
  }

  /**
   * Boot-only crash recovery. A journal entry is never enough to adopt a
   * session by itself: the provider roster must contain exactly one background
   * session with the transaction's app-generated name and canonical cwd.
   * Nothing is launched when evidence is absent or ambiguous.
   */
  async reconcilePendingLaunches(): Promise<void> {
    if (this.closing) return;
    const pendingLaunches = Object.values(
      this.options.bindings.state.data.pendingLaunches,
    ).filter((pending) => pending.workspaceId === this.options.workspace.id);
    if (pendingLaunches.length === 0) return;

    const listed = await this.options.provider.listSessions({ all: true });
    if (!listed.ok) return;

    for (const pending of pendingLaunches) {
      if (this.closing) break;
      const profile = this.options.resolveProfile(pending.profileId);
      if (
        profile === undefined ||
        profile.key !== pending.profileId ||
        profile.workspaceId !== pending.workspaceId
      ) {
        continue;
      }
      const expectedExisting =
        this.options.bindings.getBinding(pending.profileId);
      try {
        await this.withProfileLock(
          pending.profileId,
          async () => {
            if (this.isRejectedSubstitution(pending)) {
              await this.cleanupRejectedSubstitution(pending, listed.value);
              return;
            }
            await this.reconcilePending(
              profile,
              pending,
              listed.value,
              expectedExisting,
            );
          },
        );
      } catch {
        // Keep the durable journal for an explicit retry and surface the store
        // diagnostic through application state. Boot must remain recoverable.
      }
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations]);
    }
  }

  private withProfileLock<T>(
    profileId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.profileTails.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.profileTails.set(profileId, tail);

    const result = previous
      .catch(() => undefined)
      .then(operation)
      .finally(release);
    this.operations.add(result);
    void result
      .finally(() => this.operations.delete(result))
      .catch(() => undefined);
    void tail.then(() => {
      if (this.profileTails.get(profileId) === tail) {
        this.profileTails.delete(profileId);
      }
    });
    return result;
  }

  private async runStart(
    profileId: string,
    startOptions: StartProfileOptions,
  ): Promise<CliResult<StartSessionOutcome>> {
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return failure(
        `Session bindings are malformed or unreadable: ${this.options.bindings.problem.message}`,
      );
    }
    const profile = this.options.resolveProfile(profileId);
    if (profile === undefined || profile.key !== profileId) {
      return failure('Unknown opaque profile ID.');
    }
    if (profile.workspaceId !== this.options.workspace.id) {
      return failure('That profile does not belong to the active workspace.');
    }
    if (!this.options.workspace.trusted) {
      return failure('Trust this workspace before launching its agent instructions.');
    }

    const listed = await this.options.provider.listSessions({ all: true });
    if (!listed.ok) return listed;

    const existingBinding = this.options.bindings.getBinding(profileId);
    if (
      existingBinding !== undefined &&
      (existingBinding.profileId !== profileId ||
        existingBinding.workspaceId !== this.options.workspace.id)
    ) {
      return failure('The persisted binding belongs to a different workspace.');
    }
    const exactSession =
      existingBinding === undefined
        ? undefined
        : resolveExactBindingSession(existingBinding, listed.value);
    if (existingBinding !== undefined && startOptions.replaceExisting !== true) {
      const missionStart =
        startOptions.missionExecutionId !== undefined;
      const exactMissionBinding = matchesMissionLaunchIdentity(
        existingBinding,
        profileId,
        startOptions,
        this.platform,
      );
      if (
        (missionStart && !exactMissionBinding) ||
        (!missionStart &&
          existingBinding.missionExecutionId !== undefined)
      ) {
        return failure(
          'The exact profile binding belongs to a different launch authority.',
        );
      }
      if (exactSession === undefined) {
        return failure(
          'The exact bound session is missing. Use Clear binding before starting another conversation.',
        );
      }
      if (isActive(exactSession)) {
        if (startOptions.rejectExisting === true) {
          if (exactMissionBinding) {
            return {
              ok: true,
              value: outcomeForBinding(
                existingBinding,
                exactSession,
              ),
              raw: '',
              argv: [],
              durationMs: 0,
            };
          }
          return failure(
            'This profile already has an active exact conversation. Confirm Start new before replacing it.',
          );
        }
        return {
          ok: true,
          value: outcomeForBinding(existingBinding, exactSession),
          raw: '',
          argv: [],
          durationMs: 0,
        };
      }
      return failure('This conversation is stopped or complete. Choose Resume or Start new.');
    }

    const pending = this.options.bindings.getPendingLaunch(profileId);
    if (pending !== undefined) {
      if (
        pending.profileId !== profileId ||
        pending.workspaceId !== this.options.workspace.id
      ) {
        return failure('The pending launch belongs to a different workspace.');
      }
      const missionStart =
        startOptions.missionExecutionId !== undefined;
      if (
        (missionStart &&
          !matchesMissionLaunchIdentity(
            pending,
            profileId,
            startOptions,
            this.platform,
          )) ||
        (!missionStart && pending.missionExecutionId !== undefined)
      ) {
        return failure(
          'The pending launch belongs to a different Mission execution.',
        );
      }
      if (this.isRejectedSubstitution(pending)) {
        const cleanup = await this.cleanupRejectedSubstitution(
          pending,
          listed.value,
        );
        if (!cleanup.cleared) {
          return failure(
            `A rejected substituted-agent launch still requires cleanup; no retry was started. ${cleanup.message}`,
          );
        }
      } else {
        const reconciled = await this.reconcilePending(
          profile,
          pending,
          listed.value,
          existingBinding,
        );
        if (reconciled !== undefined) return reconciled;
        await this.options.bindings.clearPendingLaunch(profileId, pending);
      }
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = await canonicalDirectory(
        startOptions.launchCwd ?? profile.cwd,
      );
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
    if (
      !samePath(
        canonicalCwd,
        this.options.workspace.canonicalPath,
        this.platform,
      ) &&
      !(
        this.options.authorizeLaunchCwd !== undefined &&
        (await this.options.authorizeLaunchCwd(profileId, canonicalCwd))
      )
    ) {
      return failure(
        'The profile launch directory is neither the active workspace nor an exact authorized Council lease.',
      );
    }

    const definition = await this.options.resolveDefinition(profile);
    if (definition === undefined) {
      return failure('The selected agent definition no longer exists.');
    }
    if (
      definition.catalogId !== profile.catalogId ||
      definition.agentName !== profile.agent
    ) {
      return failure('The selected catalog identity changed before launch.');
    }
    if (!definition.launchable) {
      return failure(definition.diagnostic ?? 'The selected agent definition cannot launch.');
    }
    if (
      profile.definitionFingerprint === undefined ||
      definition.fingerprint !== profile.definitionFingerprint
    ) {
      return failure(
        'The agent definition changed after it was displayed. Review the refreshed definition before launching.',
      );
    }
    if (
      startOptions.expectedDefinitionFingerprint !== undefined &&
      (profile.definitionFingerprint !==
        startOptions.expectedDefinitionFingerprint ||
        definition.fingerprint !== startOptions.expectedDefinitionFingerprint)
    ) {
      return failure(
        'The agent definition changed after this action was displayed. Review the refreshed definition before launching.',
      );
    }

    const capability = await this.options.verifyCapability();
    if (!capability.ok) return capability;

    // Capability discovery and catalog reads are asynchronous. Re-resolve both
    // authorization and definition at the final pre-spawn boundary so a
    // concurrently removed profile or changed definition cannot launch.
    const confirmedProfile = this.options.resolveProfile(profileId);
    if (
      confirmedProfile === undefined ||
      confirmedProfile.key !== profileId ||
      confirmedProfile.workspaceId !== this.options.workspace.id ||
      confirmedProfile.agent !== profile.agent ||
      confirmedProfile.catalogId !== profile.catalogId ||
      confirmedProfile.definitionFingerprint !==
        profile.definitionFingerprint ||
      confirmedProfile.cwd !== profile.cwd
    ) {
      return failure(
        'The profile authorization changed while launch was being prepared.',
      );
    }
    const confirmedDefinition =
      await this.options.resolveDefinition(confirmedProfile);
    if (
      confirmedDefinition === undefined ||
      !confirmedDefinition.launchable ||
      confirmedDefinition.catalogId !== definition.catalogId ||
      confirmedDefinition.agentName !== definition.agentName ||
      confirmedDefinition.fingerprint !== definition.fingerprint
    ) {
      return failure(
        'The agent definition changed while launch was being prepared.',
      );
    }
    const finalProfile = this.options.resolveProfile(profileId);
    if (
      finalProfile === undefined ||
      finalProfile.key !== confirmedProfile.key ||
      finalProfile.workspaceId !== this.options.workspace.id ||
      finalProfile.definitionFingerprint !==
        confirmedProfile.definitionFingerprint
    ) {
      return failure(
        'The profile authorization changed immediately before launch.',
      );
    }

    const createdAt = this.now().toISOString();
    const uniqueLaunchName = `dc-${profileId.slice(-12)}-${this.uniqueId().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`;
    const pendingLaunch: PendingLaunchRecord = {
      providerId: this.options.provider.providerId,
      workspaceId: this.options.workspace.id,
      profileId,
      uniqueLaunchName,
      agentName: definition.agentName,
      catalogId: definition.catalogId,
      definitionFingerprint: definition.fingerprint,
      requestedCanonicalCwd: canonicalCwd,
      ...(startOptions.missionExecutionId === undefined
        ? {}
        : {
            missionExecutionId:
              startOptions.missionExecutionId,
            missionAccessMode:
              startOptions.missionAccessMode!,
          }),
      createdAt,
    };
    try {
      await this.options.bindings.setPendingLaunch(pendingLaunch);
    } catch (error) {
      return failure(
        `Could not journal the launch before spawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const launchProfile = this.options.resolveProfile(profileId);
    const launchDefinition =
      launchProfile === undefined
        ? undefined
        : await this.options.resolveDefinition(launchProfile);
    const finalAuthorizedProfile = this.options.resolveProfile(profileId);
    if (
      launchProfile === undefined ||
      finalAuthorizedProfile === undefined ||
      launchProfile.key !== profileId ||
      finalAuthorizedProfile.key !== profileId ||
      launchProfile.workspaceId !== this.options.workspace.id ||
      finalAuthorizedProfile.workspaceId !== this.options.workspace.id ||
      launchProfile.agent !== confirmedProfile.agent ||
      finalAuthorizedProfile.agent !== launchProfile.agent ||
      launchProfile.catalogId !== confirmedProfile.catalogId ||
      finalAuthorizedProfile.catalogId !== launchProfile.catalogId ||
      launchProfile.definitionFingerprint !==
        confirmedProfile.definitionFingerprint ||
      finalAuthorizedProfile.definitionFingerprint !==
        launchProfile.definitionFingerprint ||
      launchProfile.cwd !== confirmedProfile.cwd ||
      finalAuthorizedProfile.cwd !== launchProfile.cwd ||
      launchDefinition === undefined ||
      !launchDefinition.launchable ||
      launchDefinition.catalogId !== confirmedDefinition.catalogId ||
      launchDefinition.agentName !== confirmedDefinition.agentName ||
      launchDefinition.fingerprint !== confirmedDefinition.fingerprint
    ) {
      try {
        await this.options.bindings.clearPendingLaunch(
          profileId,
          pendingLaunch,
        );
      } catch (error) {
        return failure(
          `Launch authorization changed before spawn, and its unstarted journal could not be cleared: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return failure(
        'The profile or agent definition changed immediately before launch; no provider session was started.',
      );
    }

    const result = await this.options.provider.startSession({
      agent: launchDefinition.agentName,
      name: uniqueLaunchName,
      cwd: canonicalCwd,
      prompt:
        startOptions.promptOverride ??
        launchProfile.bootPrompt ??
        `You are ${launchProfile.label}. Report in and await instructions.`,
      model: launchProfile.model,
      effort: launchProfile.effort,
      permissionMode:
        startOptions.permissionModeOverride ??
        launchProfile.permissionMode ??
        launchDefinition.permissionMode,
    });

    if (!result.ok) {
      const unknownAgent = detectUnknownAgentWarning(result.raw);
      if (unknownAgent !== null) {
        const rejected = await this.persistRejectedSubstitution(pendingLaunch);
        const cleanup = await this.cleanupRejectedSubstitution(rejected);
        await this.options.refresh().catch(() => undefined);
        return failure(
          `Claude substituted its default agent for "${unknownAgent}" while returning an uncertain acknowledgement. The session was not bound. ${cleanup.message}`,
          result.argv,
          'cli-error',
          result.raw,
        );
      }
      if (result.kind === 'timeout' || result.kind === 'malformed-output') {
        const after = await this.options.provider.listSessions({ all: true });
        if (after.ok) {
          const recovered = await this.reconcilePending(
            profile,
            pendingLaunch,
            after.value,
            existingBinding,
          );
          if (recovered !== undefined) return recovered;
        }
        // Keep the journal. A retry must reconcile this identity before spawn.
        return failure(
          `${result.message}. The uncertain launch was journaled and will be reconciled before retry.`,
          result.argv,
          result.kind,
          result.raw,
        );
      }
      await this.options.bindings
        .clearPendingLaunch(profileId, pendingLaunch)
        .catch(() => undefined);
      return result;
    }

    const acknowledgedExistingId = listed.value.some(
      (session) =>
        session.kind === 'background' && session.id === result.value.id,
    );
    if (acknowledgedExistingId) {
      let journalMessage =
        'The launch journal was cleared because no substituted agent was reported.';
      if (result.value.unknownAgent !== undefined) {
        const rejected = await this.persistRejectedSubstitution(pendingLaunch);
        journalMessage =
          `The rejected-substitution journal was retained for safe review (${rejected.uniqueLaunchName}).`;
      } else {
        await this.options.bindings
          .clearPendingLaunch(profileId, pendingLaunch)
          .catch(() => undefined);
      }
      await this.options.refresh().catch(() => undefined);
      return failure(
        `Claude acknowledged the launch with a provider session ID that already existed; no session was stopped or bound. ${journalMessage}`,
        result.argv,
        'malformed-output',
        result.raw,
      );
    }

    if (
      result.value.unknownAgent !== undefined ||
      result.value.name !== uniqueLaunchName
    ) {
      const rejected = await this.persistRejectedSubstitution(pendingLaunch);
      // The acknowledgement's short id is not cleanup authority. Re-read the
      // roster and require the journal's unique launch name plus canonical cwd,
      // so a duplicate/reused short id can never stop unrelated provider work.
      const cleanup = await this.cleanupRejectedSubstitution(rejected);
      await this.options.refresh().catch(() => undefined);
      const reason =
        result.value.unknownAgent !== undefined
          ? `Claude substituted its default agent for "${result.value.unknownAgent}".`
          : 'Claude acknowledged the launch under an unexpected name.';
      return failure(
        `${reason} The wrong session was not bound. ${cleanup.message}`,
        result.argv,
        'cli-error',
        result.raw,
      );
    }

    const postLaunch = await this.options.provider.listSessions({ all: true });
    const acknowledgedMatches = postLaunch.ok
      ? postLaunch.value.filter((session) => session.id === result.value.id)
      : [];
    if (acknowledgedMatches.length > 1) {
      await this.options.refresh().catch(() => undefined);
      return failure(
        'Claude returned an ambiguous provider session identity. No session was ' +
          'stopped or bound because the acknowledged short ID is not unique. ' +
          'The pending launch journal was retained for safe reconciliation.',
        result.argv,
        'malformed-output',
        result.raw,
      );
    }
    const acknowledged = acknowledgedMatches[0];
    let actualCanonicalCwd: string | undefined;
    if (acknowledged?.cwd !== undefined) {
      try {
        actualCanonicalCwd = await canonicalDirectory(acknowledged.cwd);
      } catch {
        // Requested cwd remains durable; an unverifiable actual path is omitted.
      }
    }
    if (
      actualCanonicalCwd !== undefined &&
      !samePath(actualCanonicalCwd, canonicalCwd, this.platform)
    ) {
      const cleanup = await this.options.provider.stopSession(result.value.id);
      await this.options.bindings
        .clearPendingLaunch(profileId, pendingLaunch)
        .catch(() => undefined);
      await this.options.refresh().catch(() => undefined);
      return failure(
        `Claude started the session in a different canonical workspace. Cleanup: ${
          cleanup.ok ? 'stopped the new session' : cleanup.message
        }.`,
        result.argv,
        'cli-error',
        result.raw,
      );
    }
    const binding: SessionBindingRecord = {
      providerId: this.options.provider.providerId,
      workspaceId: this.options.workspace.id,
      profileId,
      shortSessionId: result.value.id,
      ...(acknowledged?.sessionId === undefined
        ? {}
        : { fullSessionId: acknowledged.sessionId }),
      uniqueLaunchName,
      agentName: definition.agentName,
      catalogId: definition.catalogId,
      definitionFingerprint: definition.fingerprint,
      requestedCanonicalCwd: canonicalCwd,
      ...(startOptions.missionExecutionId === undefined
        ? {}
        : {
            missionExecutionId:
              startOptions.missionExecutionId,
            missionAccessMode:
              startOptions.missionAccessMode!,
          }),
      ...(actualCanonicalCwd === undefined ? {} : { actualCanonicalCwd }),
      createdAt,
      lastConfirmedAt: this.now().toISOString(),
    };

    try {
      if (existingBinding === undefined) {
        await this.options.bindings.setBinding(binding);
      } else {
        await this.options.bindings.replaceBinding(binding, existingBinding);
      }
    } catch (error) {
      const cleanup = await this.options.provider.stopSession(result.value.id);
      let journalMessage = 'cleared the pending launch journal';
      try {
        await this.options.bindings.clearPendingLaunch(
          profileId,
          pendingLaunch,
        );
      } catch (journalError) {
        journalMessage = `could not clear the pending journal: ${
          journalError instanceof Error ? journalError.message : String(journalError)
        }`;
      }
      await this.options.refresh().catch(() => undefined);
      return failure(
        `The new session started but its binding could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }. Cleanup: ${cleanup.ok ? 'stopped the new session' : cleanup.message}; ${journalMessage}.`,
        result.argv,
        'cli-error',
        result.raw,
      );
    }

    await this.options.refresh();
    return result;
  }

  /**
   * Unique name + cwd is used only for the current journaled transaction.
   * Zero matches is conclusive for a retry; multiple matches remain blocked.
   */
  private async reconcilePending(
    profile: RosterMember,
    pending: PendingLaunchRecord,
    sessions: readonly Session[],
    expectedExisting: SessionBindingRecord | undefined,
  ): Promise<CliResult<StartSessionOutcome> | undefined> {
    if (this.isRejectedSubstitution(pending)) {
      return failure(
        'The pending launch was rejected as an agent substitution and can only be cleaned up; it was not bound.',
      );
    }
    const candidates = await this.findPendingCandidates(pending, sessions);
    if (candidates.length === 0) return undefined;
    if (candidates.length !== 1 || candidates[0]?.id === undefined) {
      return failure(
        'The pending launch identity is ambiguous; no retry was started.',
      );
    }
    const session = candidates[0];
    const shortSessionId = session.id;
    if (shortSessionId === undefined) return undefined;
    const binding: SessionBindingRecord = {
      providerId: this.options.provider.providerId,
      workspaceId: pending.workspaceId,
      profileId: profile.key,
      shortSessionId,
      ...(session.sessionId === undefined ? {} : { fullSessionId: session.sessionId }),
      uniqueLaunchName: pending.uniqueLaunchName,
      agentName: pending.agentName,
      catalogId: pending.catalogId,
      definitionFingerprint: pending.definitionFingerprint,
      requestedCanonicalCwd: pending.requestedCanonicalCwd,
      ...(pending.missionExecutionId === undefined
        ? {}
        : {
            missionExecutionId: pending.missionExecutionId,
            missionAccessMode: pending.missionAccessMode!,
          }),
      ...(session.cwd === undefined ? {} : { actualCanonicalCwd: session.cwd }),
      createdAt: pending.createdAt,
      lastConfirmedAt: this.now().toISOString(),
    };
    if (expectedExisting !== undefined) {
      await this.options.bindings.replaceBinding(binding, expectedExisting);
    } else {
      await this.options.bindings.setBinding(binding);
    }
    await this.options.refresh();
    return {
      ok: true,
      value: outcomeForBinding(binding, session),
      raw: '',
      argv: [],
      durationMs: 0,
    };
  }

  private isRejectedSubstitution(pending: PendingLaunchRecord): boolean {
    return (
      pending.disposition === 'rejected-substitution' ||
      this.volatileRejectedLaunches.has(pending.uniqueLaunchName)
    );
  }

  private async persistRejectedSubstitution(
    pending: PendingLaunchRecord,
  ): Promise<PendingLaunchRecord> {
    this.volatileRejectedLaunches.add(pending.uniqueLaunchName);
    if (pending.disposition === 'rejected-substitution') return pending;
    let expected = pending;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.options.bindings.markPendingLaunchRejected(
          expected.profileId,
          expected,
        );
      } catch {
        // A failed atomic replace leaves the original durable file intact.
        // Reload and retry once so transient writer failures cannot leave an
        // adoptable journal after Council exits.
        await this.options.bindings.reload().catch(() => undefined);
        const current = this.options.bindings.getPendingLaunch(
          pending.profileId,
        );
        if (
          current?.uniqueLaunchName !== pending.uniqueLaunchName
        ) {
          return pending;
        }
        if (current.disposition === 'rejected-substitution') return current;
        expected = current;
      }
    }
    // The volatile marker prevents adoption for this process. A permanent
    // inability to write durable state is an external storage failure; cleanup
    // remains blocked/retained and its result explicitly tells the caller not
    // to exit before repairing storage.
    return expected;
  }

  private async cleanupRejectedSubstitution(
    pending: PendingLaunchRecord,
    knownSessions?: readonly Session[],
  ): Promise<{ readonly cleared: boolean; readonly message: string }> {
    await this.options.bindings.reload();
    if (this.options.bindings.problem !== undefined) {
      return {
        cleared: false,
        message:
          'The rejected-substitution journal remains because the binding store is unreadable.',
      };
    }
    let current = this.options.bindings.getPendingLaunch(pending.profileId);
    if (current === undefined) {
      this.volatileRejectedLaunches.delete(pending.uniqueLaunchName);
      return {
        cleared: true,
        message: 'The rejected-substitution journal was already cleared.',
      };
    }
    if (
      current.uniqueLaunchName !== pending.uniqueLaunchName ||
      (!this.isRejectedSubstitution(current) &&
        !this.volatileRejectedLaunches.has(pending.uniqueLaunchName))
    ) {
      return {
        cleared: false,
        message:
          'The launch journal changed before cleanup; no provider session was stopped.',
      };
    }
    if (current.disposition !== 'rejected-substitution') {
      current = await this.persistRejectedSubstitution(current);
    }
    const durableFailureNote =
      current.disposition === 'rejected-substitution'
        ? ''
        : ' Durable rejection could not be written; repair the binding storage before exiting Council.';

    let sessions = knownSessions;
    if (sessions === undefined) {
      const listed = await this.options.provider.listSessions({ all: true });
      if (!listed.ok) {
        return {
          cleared: false,
          message:
            `The rejected-substitution journal remains because the provider roster could not be read.${durableFailureNote}`,
        };
      }
      sessions = listed.value;
    }
    const candidates = await this.findPendingCandidates(current, sessions);
    if (candidates.length === 0) {
      try {
        await this.options.bindings.clearPendingLaunch(
          current.profileId,
          current,
        );
        this.volatileRejectedLaunches.delete(current.uniqueLaunchName);
        return {
          cleared: true,
          message:
            'The authoritative provider roster contains no substituted session; the rejected-substitution journal was cleared.',
        };
      } catch (error) {
        return {
          cleared: false,
          message:
            `No substituted session is visible, but the rejected-substitution journal remains because it could not be cleared: ${
              error instanceof Error ? error.message : String(error)
            }.${durableFailureNote}`,
        };
      }
    }
    if (candidates.length !== 1 || candidates[0]?.id === undefined) {
      return {
        cleared: false,
        message:
          `The rejected-substitution journal remains because the cleanup target is ambiguous.${durableFailureNote}`,
      };
    }

    const cleanup = await this.options.provider.stopSession(candidates[0].id);
    if (!cleanup.ok) {
      return {
        cleared: false,
        message:
          `The rejected-substitution journal remains because cleanup failed: ${cleanup.message}.${durableFailureNote}`,
      };
    }
    try {
      await this.options.bindings.clearPendingLaunch(
        current.profileId,
        current,
      );
      this.volatileRejectedLaunches.delete(current.uniqueLaunchName);
      return {
        cleared: true,
        message:
          'The uniquely identified substituted session was stopped and its rejected-substitution journal was cleared.',
      };
    } catch (error) {
      return {
        cleared: false,
        message:
          `The substituted session was stopped, but its rejected-substitution journal remains because it could not be cleared: ${
            error instanceof Error ? error.message : String(error)
          }.`,
      };
    }
  }

  private async findPendingCandidates(
    pending: PendingLaunchRecord,
    sessions: readonly Session[],
  ): Promise<Session[]> {
    const candidates: Session[] = [];
    for (const session of sessions) {
      if (
        session.kind !== 'background' ||
        session.state === 'stopped' ||
        session.name !== pending.uniqueLaunchName ||
        session.cwd === undefined
      ) {
        continue;
      }
      try {
        const actual = await canonicalDirectory(session.cwd);
        if (samePath(actual, pending.requestedCanonicalCwd, this.platform)) {
          candidates.push({ ...session, cwd: actual });
        }
      } catch {
        // Unverifiable cwd is not launch-recovery evidence.
      }
    }
    return candidates;
  }
}
