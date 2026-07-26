/**
 * The runtime that ties the integration layer together: poll, watch, receive
 * hooks, and expose one snapshot the UI can render.
 *
 * Three inputs, one output:
 *  - hooks (fast path, milliseconds) — a needs-input state reaches the tray at once
 *  - filesystem watches (fast path) — state.json changes as the supervisor works
 *  - `agents --json --all` polling (~10s) — reconciliation, so a missed hook or
 *    a stale watch always converges
 *
 * Hooks are never the only path. Every hook delivery schedules a refresh rather
 * than mutating the snapshot directly, so the CLI stays the single source of
 * truth about session state and there is no divergent in-app model to debug.
 */

import type { ClaudePaths } from './paths.js';
import type { ClaudeRuntimeReader } from '../providers/contracts.js';
import { readJobsSnapshot, type JobsSnapshot } from './fs/jobs.js';
import { readAllTeams } from './fs/teams.js';
import { listAgentDefinitions, validateAgentName } from './fs/agentDefs.js';
import { ClaudeStateWatcher } from './fs/watch.js';
import { HookReceiver, type ReceiverDescriptor } from './hooks/receiver.js';
import { isNeedsInput, type HookDelivery } from './hooks/events.js';
import { buildUnifiedRoster, membersNeedingStart, membersNeedingWake, type UnifiedRoster } from './roster/unified.js';
import type {
  AgentValidation,
  CliFailure,
  CliResult,
  DaemonStatus,
  ParseProblem,
  RosterConfig,
  RosterMember,
  Session,
  SessionBindingRef,
} from './types.js';

export interface Snapshot {
  readonly roster: UnifiedRoster;
  readonly daemon: DaemonStatus | undefined;
  /**
   * Set when the last roster read failed. The previous roster is retained so a
   * transient CLI error does not blank the squad screen — it renders alongside
   * the stale data with an explicit staleness marker.
   */
  readonly rosterError: CliFailure | undefined;
  /**
   * Set by the application controller when catalog/profile watching or reload
   * fails. The last-known-good definition projection remains visible, but no
   * new definition-based launch may proceed until an authoritative rescan
   * clears this marker. Exact already-bound lifecycle actions remain usable.
   */
  readonly definitionError?: string | undefined;
  readonly updatedAt: Date;
  /** Sessions parked on a person. Drives the amber attention channel and badge count. */
  readonly needsInput: readonly Session[];
  /** True when a machine restart left the squad in `failed` — offer "wake the squad". */
  readonly needsWake: boolean;
  readonly catalogRevision: string | undefined;
  readonly catalogProblems: readonly ParseProblem[];
}

export interface RuntimeOptions {
  readonly provider: ClaudeRuntimeReader;
  readonly paths: ClaudePaths;
  readonly config: RosterConfig;
  readonly bindings?: ReadonlyMap<string, SessionBindingRef> | undefined;
  readonly validations?: ReadonlyMap<string, AgentValidation> | undefined;
  readonly catalogRevision?: string | undefined;
  readonly catalogProblems?: readonly ParseProblem[] | undefined;
  readonly onSnapshot: (snapshot: Snapshot) => void;
  /** Raw hook deliveries, for the activity log. */
  readonly onHook?: ((delivery: HookDelivery) => void) | undefined;
  /**
   * Fired the instant a hook reports an agent is waiting on a person, ahead of
   * the confirming roster read. Drives the OS notification and the tray badge.
   */
  readonly onNeedsInput?: ((delivery: HookDelivery) => void) | undefined;
  readonly onError?: ((error: Error) => void) | undefined;
}

/** What the boot sequence found, before anything is started. */
export interface BootReport {
  readonly daemon: DaemonStatus | undefined;
  readonly snapshot: Snapshot;
  /** Configured/discovered agents with no session at all. */
  readonly missing: readonly RosterMember[];
  /**
   * Specialists whose session reads `failed` — the machine-restart case.
   * Never respawned without the user seeing it first.
   */
  readonly needsWake: readonly RosterMember[];
  /** Profiles whose `agent` does not exist on disk. Dispatching would silently run a default agent. */
  readonly invalidAgents: readonly AgentValidation[];
  readonly receiver: ReceiverDescriptor | undefined;
}

export class DecagramCouncilRuntime {
  private readonly watcher: ClaudeStateWatcher;
  private readonly receiver: HookReceiver;
  private timer: NodeJS.Timeout | undefined;
  private refreshTail: Promise<void> = Promise.resolve();
  private scheduledRefresh = false;
  private refreshDirty = false;
  private stopped = true;
  private snapshot: Snapshot | undefined;
  private rosterConfig: RosterConfig;
  private bindings: ReadonlyMap<string, SessionBindingRef>;
  private validations: ReadonlyMap<string, AgentValidation>;
  private catalogRevision: string | undefined;
  private catalogProblems: readonly ParseProblem[];

  constructor(private readonly options: RuntimeOptions) {
    this.rosterConfig = options.config;
    this.bindings = options.bindings ?? new Map();
    this.validations = options.validations ?? new Map();
    this.catalogRevision = options.catalogRevision;
    this.catalogProblems = options.catalogProblems ?? [];
    this.watcher = new ClaudeStateWatcher(options.paths);
    this.watcher.onChange(() => this.scheduleRefresh());
    this.watcher.onError((error) => options.onError?.(error));
    this.receiver = new HookReceiver(options.paths, {
      onDelivery: (delivery) => this.handleHook(delivery),
      onError: (err) => options.onError?.(err),
    });
  }

  get current(): Snapshot | undefined {
    return this.snapshot;
  }

  get receiverInfo(): ReceiverDescriptor | undefined {
    return this.receiver.info;
  }

  /**
   * Replaces the catalog/profile projection without touching provider-owned
   * sessions. Definition-watch refreshes and workspace controllers call this
   * before publishing a new authoritative snapshot.
   */
  updateRoster(
    config: RosterConfig,
    bindings: ReadonlyMap<string, SessionBindingRef>,
    validations: ReadonlyMap<string, AgentValidation>,
    catalogRevision?: string | undefined,
    catalogProblems: readonly ParseProblem[] = [],
    schedule = true,
  ): void {
    const previousPollInterval = this.rosterConfig.pollIntervalMs;
    this.rosterConfig = config;
    this.bindings = bindings;
    this.validations = validations;
    this.catalogRevision = catalogRevision;
    this.catalogProblems = catalogProblems;
    if (
      !this.stopped &&
      previousPollInterval !== this.rosterConfig.pollIntervalMs
    ) {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = setInterval(
        () => this.scheduleRefresh(),
        this.rosterConfig.pollIntervalMs,
      );
      this.timer.unref();
    }
    if (schedule) this.scheduleRefresh();
  }

  /**
   * Boot sequence: daemon status → roster → diff against config → report.
   *
   * Deliberately stops at reporting. Starting sessions is a separate call, so
   * the machine-restart case can be shown to the user before anything respawns.
   */
  async boot(): Promise<BootReport> {
    const daemonResult = await this.options.provider.daemonStatus();
    // A down daemon is the ordinary resting state in this version, so a failure
    // here is only about our ability to ask, not about the daemon's health.
    const daemon = daemonResult.ok ? daemonResult.value : undefined;
    if (!daemonResult.ok) this.options.onError?.(new Error(daemonResult.message));

    if (this.validations.size === 0) await this.refreshValidations();
    const snapshot = await this.refresh(daemon);

    const invalid = [...this.validations.values()].filter((validation) => !validation.found);

    return {
      daemon,
      snapshot,
      missing: membersNeedingStart(snapshot.roster),
      needsWake: membersNeedingWake(snapshot.roster).map((slot) => slot.member),
      invalidAgents: invalid,
      receiver: this.receiver.info,
    };
  }

  /** Starts the receiver, the watcher and the poll loop. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;

    try {
      await this.receiver.start();
    } catch (err) {
      // Losing the fast path degrades latency, not correctness: polling still
      // reconciles everything. Not a reason to refuse to launch.
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }

    this.watcher.start();

    this.timer = setInterval(() => this.scheduleRefresh(), this.rosterConfig.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.watcher.stop();
    await this.receiver.stop();
    await this.refreshTail;
  }

  /** Coalesces refreshes so a hook burst produces one roster read, not twenty. */
  scheduleRefresh(): void {
    if (this.scheduledRefresh) {
      this.refreshDirty = true;
      return;
    }
    this.scheduledRefresh = true;
    this.refreshDirty = false;
    void this.refresh()
      .catch((error) => {
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      })
      .finally(() => {
        this.scheduledRefresh = false;
        if (this.refreshDirty && !this.stopped) {
          this.refreshDirty = false;
          this.scheduleRefresh();
        }
      });
  }

  /** Reads all sources and publishes a snapshot. */
  refresh(daemon?: DaemonStatus | undefined): Promise<Snapshot> {
    const result = this.refreshTail.then(
      () => this.performRefresh(daemon),
      () => this.performRefresh(daemon),
    );
    this.refreshTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async performRefresh(
    daemon?: DaemonStatus | undefined,
  ): Promise<Snapshot> {
    const [rosterResult, jobs, teams] = await Promise.all([
      this.options.provider.listSessions({ all: true }),
      readJobsSnapshot(this.options.paths),
      readAllTeams(this.options.paths),
    ]);

    const snapshot = this.assemble(rosterResult, jobs, teams, daemon);
    this.snapshot = snapshot;
    this.options.onSnapshot(snapshot);
    return snapshot;
  }

  private assemble(
    rosterResult: CliResult<Session[]>,
    jobs: JobsSnapshot,
    teams: Awaited<ReturnType<typeof readAllTeams>>,
    daemon: DaemonStatus | undefined,
  ): Snapshot {
    // On a failed read, keep the previous roster rather than showing an empty
    // squad. A blank screen reads as "the agents are gone", which is worse than
    // slightly stale data plus a visible error.
    const rosterSessions = rosterResult.ok
      ? rosterResult.value
      : (this.snapshot?.roster.sessions ?? []);

    const roster = buildUnifiedRoster({
      config: this.rosterConfig,
      rosterSessions,
      jobs,
      teams,
      validations: this.validations,
      bindings: this.bindings,
      // Absence is authoritative only when the current provider read
      // succeeded. Retained sessions keep useful stale detail visible after a
      // transient CLI failure, but they cannot prove that an exact binding is
      // gone (and therefore safe to clear).
      rosterAvailable: rosterResult.ok,
    });

    const needsInput = roster.squad
      .map((slot) => slot.session)
      .filter(
        (session): session is Session =>
          session !== undefined &&
          (session.state === 'blocked' || session.waitingFor !== undefined),
      );

    return {
      roster,
      daemon: daemon ?? this.snapshot?.daemon,
      rosterError: rosterResult.ok ? undefined : rosterResult,
      updatedAt: new Date(),
      needsInput,
      needsWake: membersNeedingWake(roster).length > 0,
      catalogRevision: this.catalogRevision,
      catalogProblems: this.catalogProblems,
    };
  }

  /** Re-scans subagent definitions so roster typos surface before dispatch. */
  async refreshValidations(): Promise<void> {
    const validations = new Map<string, AgentValidation>();
    for (const member of this.rosterConfig.members) {
      const definitions = await listAgentDefinitions(this.options.paths, member.cwd);
      validations.set(member.key, validateAgentName(member.agent, definitions));
    }
    this.validations = validations;
  }

  private handleHook(delivery: HookDelivery): void {
    this.options.onHook?.(delivery);

    // A needs-input event fires the notification path immediately rather than
    // waiting for the roster read to confirm it. That is the point of the fast
    // path: the user learns an agent is blocked in milliseconds. The refresh
    // below then supplies the authoritative state the UI renders.
    if (isNeedsInput(delivery)) this.options.onNeedsInput?.(delivery);

    // Never mutate the snapshot from a hook payload — an event says "something
    // changed", and the CLI says what it changed to.
    this.scheduleRefresh();
  }
}
