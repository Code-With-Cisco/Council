import type { ClaudeClient, StartSessionOutcome } from '../integration/client.js';
import type { ClaudePaths } from '../integration/paths.js';
import { sendReply, type ReplyOutcome } from '../integration/pty/attach.js';
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
  ParseProblem,
  RosterConfig,
  Session,
  SessionBindingRef,
} from '../integration/types.js';
import type { ResolvedAgentCatalog } from './catalog.js';
import {
  SafeLaunchCoordinator,
  type LaunchWorkspace,
} from './launchCoordinator.js';
import {
  type SessionBindingRecord,
  type SessionBindingStore,
} from './sessionBindings.js';
import type { AgentRuntimeCapabilities, AgentSupervisorPort } from './contracts.js';

export interface ClaudeCodeAgentSupervisorOptions {
  readonly client: ClaudeClient;
  readonly paths: ClaudePaths;
  readonly config: RosterConfig;
  readonly bindings: SessionBindingStore;
  readonly workspace: LaunchWorkspace;
  readonly catalog: ResolvedAgentCatalog;
  /** Fresh disk discovery used by every launch transaction. */
  readonly resolveCatalog: () => Promise<ResolvedAgentCatalog>;
  readonly validations: ReadonlyMap<string, AgentValidation>;
  readonly catalogProblems?: readonly ParseProblem[] | undefined;
  readonly councilProfileId?: string | undefined;
  readonly ptyAvailable: boolean;
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

export function isSafePlainTextReplyState(session: Session | undefined): boolean {
  return (
    session?.state === 'blocked' &&
    session.waitingFor === 'input needed' &&
    session.id !== undefined
  );
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
      start: true,
      stop: true,
      logs: true,
      plainTextReply: options.ptyAvailable,
      interactiveTerminal: false,
      persistentSessions: true,
      councilReview: options.councilProfileId !== undefined,
    };
    this.runtime = new DecagramCouncilRuntime({
      client: options.client,
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
      client: options.client,
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
      verifyCapability: () => options.client.verifyLaunchCapability(),
      refresh: async () => {
        this.syncRuntimeProjection(false);
        return (await this.runtime.refresh()).roster.sessions;
      },
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
        action: (session) => this.options.client.stop(session.id!),
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
        action: (session) => this.options.client.logs(session.id!),
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
              'One-line Reply is available only when the exact session is waiting for ordinary text input.',
              ['attach', session.id!],
            );
          }
          return sendReply(this.options.client.cli.bin, session.id!, message);
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
