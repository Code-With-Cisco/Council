import type { StartSessionOutcome } from '../integration/client.js';
import type { ClaudePaths } from '../integration/paths.js';
import type { ReplyOutcome } from '../integration/pty/attach.js';
import {
  DecagramCouncilRuntime,
  type BootReport,
  type RuntimeOptions,
  type Snapshot,
} from '../integration/runtime.js';
import {
  membersNeedingStart,
  membersNeedingWake,
} from '../integration/roster/unified.js';
import type {
  AgentValidation,
  CliFailure,
  CliResult,
  DaemonStatus,
  ParseProblem,
  RosterConfig,
  Session,
  SessionBindingRef,
} from '../integration/types.js';
import type {
  AgentProviderAdapter,
  ClaudeRuntimeReader,
} from '../providers/contracts.js';
import type { CouncilAccessMode } from '../providers/missionContracts.js';
import { claudeMissionBindingProfileId } from '../missions/claudeBindingIdentity.js';
import type { ResolvedAgentCatalog } from './catalog.js';
import {
  SafeLaunchCoordinator,
  type LaunchWorkspace,
} from './launchCoordinator.js';
import {
  type SessionBindingRecord,
  type SessionBindingStore,
  type SessionProviderId,
} from './sessionBindings.js';
import type { AgentRuntimeCapabilities, AgentSupervisorPort } from './contracts.js';

export interface ClaudeCodeAgentSupervisorOptions {
  readonly provider: AgentProviderAdapter<SessionProviderId> & ClaudeRuntimeReader;
  readonly paths: ClaudePaths;
  readonly config: RosterConfig;
  readonly bindings: SessionBindingStore;
  readonly workspace: LaunchWorkspace;
  readonly catalog: ResolvedAgentCatalog;
  /** Fresh disk discovery used by every launch transaction. */
  readonly resolveCatalog: () => Promise<ResolvedAgentCatalog>;
  readonly authorizeMissionLaunchCwd?:
    | ((profileId: string, canonicalCwd: string) => Promise<boolean>)
    | undefined;
  readonly validations: ReadonlyMap<string, AgentValidation>;
  readonly catalogProblems?: readonly ParseProblem[] | undefined;
  readonly councilProfileId?: string | undefined;
  readonly onSnapshot: RuntimeOptions['onSnapshot'];
  readonly onHook?: RuntimeOptions['onHook'];
  readonly onNeedsInput?: RuntimeOptions['onNeedsInput'];
  readonly onError?: RuntimeOptions['onError'];
}

function domainFailure(message: string, argv: readonly string[] = []): CliFailure {
  return {
    ok: false,
    kind: 'cli-error',
    message,
    raw: '',
    argv,
    exitCode: null,
    durationMs: 0,
  };
}

/**
 * Whether a session can safely be handed a line of plain text.
 *
 * Re-verified against claude v2.1.234, because the earlier `waitingFor ===
 * 'input needed'` test matched a value the CLI never emits. The roster
 * actually distinguishes the two blocked cases like this:
 *
 *   awaiting instructions  state=blocked  status=idle     waitingFor absent
 *   permission prompt      state=blocked  status=waiting  waitingFor='permission prompt'
 *
 * The distinction is the whole point of this guard: free text typed into a
 * permission prompt answers the prompt, so a blocked session only qualifies
 * when it is idle AND names nothing it is waiting on. An unrecognised
 * `waitingFor` (dialog, sandbox request, worker request) stays excluded by the
 * same rule.
 *
 * `stopped` stays excluded deliberately: that is what an explicit Stop records,
 * and Resume is the honest way back.
 */
export function isSafePlainTextReplyState(session: Session | undefined): boolean {
  if (session?.id === undefined) return false;
  if (session.state === 'done' || session.state === 'failed') return true;
  const idle = session.status?.toLowerCase() === 'idle';
  if (session.state === 'working' && idle) return true;
  return session.state === 'blocked' && idle && session.waitingFor === undefined;
}

export function isDaemonControlWedged(status: DaemonStatus): boolean {
  return status.running && !status.controlSocketReachable;
}

/**
 * First supervisor implementation. It keeps Electron independent of Claude's
 * client/runtime details while preserving the existing integration behavior.
 * A future process, SDK, or local-model adapter can implement the same port.
 */
export class ClaudeCodeAgentSupervisor implements AgentSupervisorPort {
  readonly runtimeId = 'claude-code';
  capabilities: AgentRuntimeCapabilities;
  private readonly runtime: DecagramCouncilRuntime;
  private readonly launchCoordinator: SafeLaunchCoordinator;
  private config: RosterConfig;
  private catalog: ResolvedAgentCatalog;
  private validations: ReadonlyMap<string, AgentValidation>;
  private catalogProblems: readonly ParseProblem[];
  private councilProfileId: string | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private closing = false;

  constructor(private readonly options: ClaudeCodeAgentSupervisorOptions) {
    this.config = options.config;
    this.catalog = options.catalog;
    this.validations = options.validations;
    this.catalogProblems = options.catalogProblems ?? [];
    this.councilProfileId = options.councilProfileId;
    this.capabilities = {
      start: options.provider.capabilities.start,
      stop: options.provider.capabilities.stop,
      logs: options.provider.capabilities.logs,
      plainTextReply: options.provider.capabilities.plainTextReply,
      interactiveTerminal: false,
      persistentSessions: options.provider.capabilities.persistentSessions,
      councilReview: options.councilProfileId !== undefined,
    };
    this.runtime = new DecagramCouncilRuntime({
      provider: options.provider,
      paths: options.paths,
      config: this.config,
      bindings: this.bindingMap(),
      validations: this.validations,
      catalogRevision: this.catalog.revision,
      catalogProblems: this.catalogProblems,
      onSnapshot: options.onSnapshot,
      ...(options.onHook === undefined ? {} : { onHook: options.onHook }),
      ...(options.onNeedsInput === undefined ? {} : { onNeedsInput: options.onNeedsInput }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    this.launchCoordinator = new SafeLaunchCoordinator({
      provider: options.provider,
      bindings: options.bindings,
      workspace: options.workspace,
      resolveProfile: (profileId) =>
        this.config.members.find((member) => member.key === profileId),
      resolveDefinition: async (profile) => {
        const fresh = await options.resolveCatalog();
        const entry = fresh.entries.find(
          (candidate) => candidate.catalogId === profile.catalogId,
        );
        if (entry === undefined || entry.fingerprint === undefined) return undefined;
        return {
          catalogId: entry.catalogId,
          agentName: entry.agentName,
          fingerprint: entry.fingerprint,
          launchable: entry.launchability.launchable,
          definitionPath: entry.definitionPath,
          permissionMode: entry.metadata?.permissionMode,
          diagnostic: entry.launchability.message,
        };
      },
      verifyCapability: () => options.provider.verifyLaunchCapability(),
      refresh: async () => {
        this.syncRuntimeProjection(false);
        return (await this.runtime.refresh()).roster.sessions;
      },
      ...(options.authorizeMissionLaunchCwd === undefined
        ? {}
        : { authorizeLaunchCwd: options.authorizeMissionLaunchCwd }),
    });
  }

  get current(): Snapshot | undefined {
    return this.runtime.current;
  }

  async boot(): Promise<BootReport> {
    const report = await this.runtime.boot();
    await this.launchCoordinator.reconcilePendingLaunches();
    const snapshot = this.runtime.current ?? report.snapshot;
    return {
      ...report,
      snapshot,
      missing: membersNeedingStart(snapshot.roster),
      needsWake: membersNeedingWake(snapshot.roster).map((slot) => slot.member),
    };
  }

  start(): Promise<void> {
    return this.runtime.start();
  }

  stop(): Promise<void> {
    return this.stopRuntime();
  }

  startMember(
    profileId: string,
    expectedDefinitionFingerprint: string,
  ): Promise<CliResult<StartSessionOutcome>> {
    return this.trackResult(() =>
      this.launchCoordinator.startProfile(profileId, {
        expectedDefinitionFingerprint,
      }),
    );
  }

  startMemberWithMessage(
    profileId: string,
    expectedDefinitionFingerprint: string,
    message: string,
  ): Promise<CliResult<StartSessionOutcome>> {
    return this.trackResult(() =>
      this.launchCoordinator.startProfile(profileId, {
        expectedDefinitionFingerprint,
        promptOverride: message,
      }),
    );
  }

  startNewMember(
    profileId: string,
    expectedDefinitionFingerprint: string,
  ): Promise<CliResult<StartSessionOutcome>> {
    return this.trackResult(() =>
      this.launchCoordinator.startProfile(profileId, {
        replaceExisting: true,
        expectedDefinitionFingerprint,
      }),
    );
  }

  /**
   * Mission-only launch seam. The caller is the privileged Mission router,
   * which supplies an exact Council-authorized source checkout or worktree.
   */
  startMissionMember(
    profileId: string,
    missionExecutionId: string,
    expectedDefinitionFingerprint: string,
    taskPrompt: string,
    launchCwd: string,
    accessMode: CouncilAccessMode,
    bindingProfileId: string,
  ): Promise<CliResult<StartSessionOutcome>> {
    const scopedBindingProfileId = claudeMissionBindingProfileId(
      this.options.workspace.id,
      missionExecutionId,
    );
    if (
      bindingProfileId !== profileId &&
      bindingProfileId !== scopedBindingProfileId
    ) {
      return Promise.resolve(
        domainFailure('The Mission binding owner is not authorized.'),
      );
    }
    return this.trackResult(() =>
      this.launchCoordinator.startProfile(profileId, {
        rejectExisting: true,
        promptOverride: taskPrompt,
        expectedDefinitionFingerprint,
        launchCwd,
        missionExecutionId,
        missionAccessMode: accessMode,
        bindingProfileId,
        ...(accessMode === 'read-only'
          ? { permissionModeOverride: 'plan' as const }
          : {}),
      }),
    );
  }

  resumeMember(profileId: string): Promise<CliResult<string>> {
    return this.trackResult(() => this.launchCoordinator.resumeProfile(profileId));
  }

  clearBinding(profileId: string): Promise<CliResult<string>> {
    return this.trackResult(() => this.launchCoordinator.clearBinding(profileId));
  }

  stopSession(profileId: string): Promise<CliResult<string>> {
    return this.trackResult(() =>
      this.launchCoordinator.exactBoundSessionAction(profileId, {
        actionName: 'Stop',
        missingMessage: 'That profile has no exact active session binding.',
        action: (session) => this.options.provider.stopSession(session.id!),
      }),
    );
  }

  wakeSquad(): Promise<CliResult<string>> {
    return this.trackResult(async () => {
      await this.refreshProjection();
      const failed = this.current?.roster.squad.filter(
        (slot) => slot.bindingState === 'failed',
      ) ?? [];
      if (failed.length === 0) {
        return {
          ok: true,
          value: 'No exactly bound profiles need waking.',
          raw: '',
          argv: ['respawn'],
          durationMs: 0,
        };
      }
      const startedAt = Date.now();
      for (const slot of failed) {
        const result = await this.launchCoordinator.resumeProfile(slot.member.key);
        if (!result.ok) return result;
      }
      return {
        ok: true,
        value: `Woke ${failed.length} exactly bound profile${failed.length === 1 ? '' : 's'}.`,
        raw: '',
        argv: ['respawn', ...failed.map((slot) => slot.binding?.shortSessionId ?? '')],
        durationMs: Date.now() - startedAt,
      };
    });
  }

  logs(profileId: string): Promise<CliResult<string>> {
    return this.trackResult(() =>
      this.launchCoordinator.exactBoundSessionAction(profileId, {
        actionName: 'Logs',
        missingMessage: 'That profile has no exact session binding.',
        action: (session) => this.options.provider.readLogs(session.id!),
      }),
    );
  }

  reply(profileId: string, message: string): Promise<CliResult<ReplyOutcome>> {
    return this.trackResult(async () => {
      if (!this.capabilities.plainTextReply) {
        return domainFailure(
          'Reply is disabled because the terminal bridge is unavailable.',
        );
      }
      return this.launchCoordinator.exactBoundSessionAction(profileId, {
        actionName: 'Reply',
        missingMessage: 'That profile has no exact session binding.',
        action: async (session) => {
          if (!isSafePlainTextReplyState(session)) {
            return domainFailure(
              'Message is available for an idle agent or a resumable done/failed session. A session waiting on a permission prompt or dialog must be opened and answered there, and explicitly stopped sessions stay stopped.',
              ['attach', session.id!],
            );
          }
          const daemon = await this.options.provider.daemonStatus();
          if (!daemon.ok) return daemon;
          if (isDaemonControlWedged(daemon.value)) {
            return domainFailure(
              'The Claude supervisor is running but its control channel is unreachable. Open Diagnostics and run Restart supervisor safely before retrying; your message was not sent.',
              ['daemon', 'status'],
            );
          }
          return this.options.provider.sendReply(session.id!, message, {
            cwd: session.cwd,
          });
        },
      });
    });
  }

  councilReviewNeedsReplacement(): boolean {
    if (this.councilProfileId === undefined) return false;
    return (
      this.options.bindings.getBinding(this.councilProfileId) !== undefined ||
      this.options.bindings.getPendingLaunch(this.councilProfileId) !== undefined
    );
  }

  startCouncilReview(
    question: string,
    expectedDefinitionFingerprint: string,
    replaceExisting: boolean,
  ): Promise<CliResult<StartSessionOutcome>> {
    if (this.councilProfileId === undefined) {
      return Promise.resolve(
        domainFailure(
          'Council Review requires an explicitly internal "council-lead" definition.',
        ),
      );
    }
    return this.trackResult(() =>
      this.launchCoordinator.startProfile(this.councilProfileId!, {
        replaceExisting,
        rejectExisting: !replaceExisting,
        promptOverride: question,
        expectedDefinitionFingerprint,
      }),
    );
  }

  async updateCatalog(
    config: RosterConfig,
    catalog: ResolvedAgentCatalog,
    validations: ReadonlyMap<string, AgentValidation>,
    catalogProblems: readonly ParseProblem[],
    councilProfileId?: string | undefined,
  ): Promise<void> {
    this.config = config;
    this.catalog = catalog;
    this.validations = validations;
    this.catalogProblems = catalogProblems;
    this.councilProfileId = councilProfileId;
    this.capabilities = {
      ...this.capabilities,
      councilReview: councilProfileId !== undefined,
    };
    // Publish only after the runtime has rebuilt the complete authoritative
    // roster projection. Callers may then clear a stale-definition marker
    // without briefly exposing old validation state as current.
    await this.refreshProjection();
  }

  private bindingMap(): ReadonlyMap<string, SessionBindingRef> {
    return new Map(
      Object.entries(this.options.bindings.state.data.bindings) as [
        string,
        SessionBindingRecord,
      ][],
    );
  }

  private syncRuntimeProjection(schedule = true): void {
    this.runtime.updateRoster(
      this.config,
      this.bindingMap(),
      this.validations,
      this.catalog.revision,
      this.catalogProblems,
      schedule,
    );
  }

  private async refreshProjection(): Promise<void> {
    this.syncRuntimeProjection(false);
    await this.runtime.refresh();
  }

  private async stopRuntime(): Promise<void> {
    this.closing = true;
    await this.launchCoordinator.shutdown();
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations]);
    }
    await this.runtime.stop();
  }

  private trackResult<T>(
    operation: () => Promise<CliResult<T>>,
  ): Promise<CliResult<T>> {
    if (this.closing) {
      return Promise.resolve(domainFailure('Council is shutting down.'));
    }
    const result = Promise.resolve().then(operation);
    this.operations.add(result);
    void result
      .finally(() => this.operations.delete(result))
      .catch(() => undefined);
    return result;
  }
}
