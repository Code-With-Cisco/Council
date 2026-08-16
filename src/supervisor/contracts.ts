import type { StartSessionOutcome } from '../integration/client.js';
import type { ReplyOutcome } from '../integration/pty/attach.js';
import type { BootReport, Snapshot } from '../integration/runtime.js';
import type { CliResult } from '../integration/types.js';

/**
 * Capabilities are explicit so the renderer can adapt to a runtime without
 * learning which CLI or process implementation sits behind the supervisor.
 */
export interface AgentRuntimeCapabilities {
  readonly start: boolean;
  readonly stop: boolean;
  readonly logs: boolean;
  readonly plainTextReply: boolean;
  readonly interactiveTerminal: boolean;
  readonly persistentSessions: boolean;
  readonly councilReview: boolean;
}

/**
 * UI-facing boundary for agent lifecycle operations.
 *
 * Electron owns an implementation of this port, but no renderer action receives
 * a raw executable, agent name, or working directory. Those values are resolved
 * from the supervisor's current catalog and roster.
 */
export interface AgentSupervisorPort {
  readonly runtimeId: string;
  readonly capabilities: AgentRuntimeCapabilities;
  readonly current: Snapshot | undefined;

  boot(): Promise<BootReport>;
  start(): Promise<void>;
  stop(): Promise<void>;
  startMember(
    profileId: string,
    expectedDefinitionFingerprint: string,
  ): Promise<CliResult<StartSessionOutcome>>;
  startMemberWithMessage(
    profileId: string,
    expectedDefinitionFingerprint: string,
    message: string,
  ): Promise<CliResult<StartSessionOutcome>>;
  startNewMember(
    profileId: string,
    expectedDefinitionFingerprint: string,
  ): Promise<CliResult<StartSessionOutcome>>;
  resumeMember(profileId: string): Promise<CliResult<string>>;
  clearBinding(profileId: string): Promise<CliResult<string>>;
  stopSession(profileId: string): Promise<CliResult<string>>;
  wakeSquad(): Promise<CliResult<string>>;
  logs(profileId: string): Promise<CliResult<string>>;
  reply(profileId: string, message: string): Promise<CliResult<ReplyOutcome>>;
  councilReviewNeedsReplacement(): boolean;
  startCouncilReview(
    question: string,
    expectedDefinitionFingerprint: string,
    replaceExisting: boolean,
  ): Promise<CliResult<StartSessionOutcome>>;
}
