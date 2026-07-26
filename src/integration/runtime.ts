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

import type { ClaudeClient, StartSessionOutcome } from './client.js';
import type { ClaudePaths } from './paths.js';
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
  RosterConfig,
  RosterMember,
  Session,
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
  readonly updatedAt: Date;
  /** Sessions parked on a person. Drives the amber attention channel and badge count. */
  readonly needsInput: readonly Session[];
  /** True when a machine restart left the squad in `failed` — offer "wake the squad". */
  readonly needsWake: boolean;
}

export interface RuntimeOptions {
  readonly client: ClaudeClient;
  readonly paths: ClaudePaths;
  readonly config: RosterConfig;
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
  /** Configured specialists with no session at all. Safe to start automatically. */
  readonly missing: readonly RosterMember[];
  /**
   * Specialists whose session reads `failed` — the machine-restart case.
   * Never respawned without the user seeing it first.
   */
  readonly needsWake: readonly RosterMember[];
  /** Roster members whose `agent` does not exist on disk. Dispatching would silently run a default agent. */
  readonly invalidAgents: readonly AgentValidation[];
  readonly receiver: ReceiverDescriptor | undefined;
}

export class MusterRuntime {
  private readonly watcher: ClaudeStateWatcher;
  private readonly receiver: HookReceiver;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private queued = false;
  private stopped = true;
  private snapshot: Snapshot | undefined;
  private validations = new Map<string, AgentValidation>();

  constructor(private readonly options: RuntimeOptions) {
    this.watcher = new ClaudeStateWatcher(options.paths);
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
   * Boot sequence: daemon status → roster → diff against config → report.
   *
   * Deliberately stops at reporting. Starting sessions is a separate call, so
   * the machine-restart case can be shown to the user before anything respawns.
   */
  async boot(): Promise<BootReport> {
    const daemonResult = await this.options.client.daemonStatus();
    // A down daemon is the ordinary resting state in this version, so a failure
    // here is only about our ability to ask, not about the daemon's health.
    const daemon = daemonResult.ok ? daemonResult.value : undefined;
    if (!daemonResult.ok) this.options.onError?.(new Error(daemonResult.message));

    await this.refreshValidations();
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

    this.watcher.onChange(() => this.scheduleRefresh());
    this.watcher.start();

    this.timer = setInterval(() => this.scheduleRefresh(), this.options.config.pollIntervalMs);
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
  }

  /** Coalesces refreshes so a hook burst produces one roster read, not twenty. */
  scheduleRefresh(): void {
    if (this.refreshing) {
      this.queued = true;
      return;
    }
    void this.refresh();
  }

  /** Reads all sources and publishes a snapshot. */
  async refresh(daemon?: DaemonStatus | undefined): Promise<Snapshot> {
    this.refreshing = true;
    try {
      const [rosterResult, jobs, teams] = await Promise.all([
        this.options.client.listSessions({ all: true }),
        readJobsSnapshot(this.options.paths),
        readAllTeams(this.options.paths),
      ]);

      const snapshot = this.assemble(rosterResult, jobs, teams, daemon);
      this.snapshot = snapshot;
      this.options.onSnapshot(snapshot);
      return snapshot;
    } finally {
      this.refreshing = false;
      if (this.queued) {
        this.queued = false;
        if (!this.stopped) void this.refresh();
      }
    }
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
      config: this.options.config,
      rosterSessions,
      jobs,
      teams,
      validations: this.validations,
    });

    const needsInput = roster.sessions.filter(
      (session) => session.state === 'blocked' || session.waitingFor !== undefined,
    );

    return {
      roster,
      daemon: daemon ?? this.snapshot?.daemon,
      rosterError: rosterResult.ok ? undefined : rosterResult,
      updatedAt: new Date(),
      needsInput,
      needsWake: membersNeedingWake(roster).length > 0,
    };
  }

  /** Re-scans subagent definitions so roster typos surface before dispatch. */
  async refreshValidations(): Promise<void> {
    const validations = new Map<string, AgentValidation>();
    for (const member of this.options.config.members) {
      const definitions = await listAgentDefinitions(this.options.paths, member.cwd);
      validations.set(member.agent, validateAgentName(member.agent, definitions));
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

  // ------------------------------------------------------------- squad actions

  /**
   * Starts a configured specialist.
   *
   * Refuses when the member's agent definition is missing, because dispatching
   * anyway produces a live session running a default template under the
   * specialist's name — a failure that looks like success.
   */
  async startMember(member: RosterMember): Promise<CliResult<StartSessionOutcome>> {
    const validation = this.validations.get(member.agent);
    if (validation !== undefined && !validation.found) {
      return {
        ok: false,
        kind: 'cli-error',
        message: `No subagent definition named "${member.agent}". Create it under .claude/agents/ before starting ${member.label}.`,
        raw: '',
        argv: ['--bg', '--agent', member.agent],
        exitCode: null,
        durationMs: 0,
      };
    }

    const result = await this.options.client.start({
      agent: member.agent,
      name: member.label,
      cwd: member.cwd,
      prompt: member.bootPrompt ?? `You are ${member.label}. Report in and await instructions.`,
      model: member.model,
      effort: member.effort,
    });

    this.scheduleRefresh();
    return result;
  }

  /** Starts every configured specialist that has no session. */
  async startMissing(): Promise<{ member: RosterMember; result: CliResult<StartSessionOutcome> }[]> {
    const snapshot = this.snapshot ?? (await this.refresh());
    const missing = membersNeedingStart(snapshot.roster);
    const results: { member: RosterMember; result: CliResult<StartSessionOutcome> }[] = [];
    // Sequential: each dispatch may cold-start the supervisor, and five
    // concurrent cold starts race over the same socket.
    for (const member of missing) {
      results.push({ member, result: await this.startMember(member) });
    }
    return results;
  }

  /**
   * "Wake the squad" — respawns sessions a machine restart left as `failed`.
   *
   * Only ever reached through an explicit user action.
   */
  async wakeSquad(): Promise<CliResult<string>> {
    const result = await this.options.client.respawnAll();
    this.scheduleRefresh();
    return result;
  }
}
