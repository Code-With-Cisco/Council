import type {
  StartSessionOutcome,
  StartSessionRequest,
} from '../integration/client.js';
import type { ReplyOutcome } from '../integration/pty/attach.js';
import type {
  CliResult,
  DaemonStatus,
  Session,
} from '../integration/types.js';

/**
 * Provider capabilities that affect lifecycle controls.
 *
 * Council-specific capabilities, such as whether an internal Council profile
 * exists, stay in the supervisor because they are derived from the active
 * catalog rather than from a provider transport.
 */
export interface AgentProviderCapabilities {
  readonly start: boolean;
  readonly stop: boolean;
  readonly logs: boolean;
  readonly plainTextReply: boolean;
  readonly persistentSessions: boolean;
}

export interface ReplyContext {
  /** Exact provider-owned session directory; never accepted from renderer IPC. */
  readonly cwd?: string | undefined;
}

/**
 * Provider command boundary used by Council's ownership and launch
 * coordinators. The current normalized request/result/session shapes are kept
 * deliberately so extracting the Claude transport does not alter behavior.
 */
export interface AgentProviderAdapter<ProviderId extends string = string> {
  readonly providerId: ProviderId;
  readonly capabilities: AgentProviderCapabilities;

  verifyLaunchCapability(): Promise<CliResult<unknown>>;
  listSessions(options?: {
    readonly all?: boolean;
    readonly cwd?: string;
  }): Promise<CliResult<Session[]>>;
  startSession(
    request: StartSessionRequest,
  ): Promise<CliResult<StartSessionOutcome>>;
  stopSession(providerSessionId: string): Promise<CliResult<string>>;
  resumeSession(providerSessionId: string): Promise<CliResult<string>>;
  readLogs(providerSessionId: string): Promise<CliResult<string>>;
  sendReply(
    providerSessionId: string,
    message: string,
    context?: ReplyContext,
  ): Promise<CliResult<ReplyOutcome>>;
}

/**
 * Read surface required by the existing Claude runtime projection.
 *
 * Daemon status is intentionally kept out of AgentProviderAdapter: it is a
 * Claude runtime concept, not a requirement every future provider must model.
 */
export interface ClaudeRuntimeReader {
  listSessions(options?: {
    readonly all?: boolean;
    readonly cwd?: string;
  }): Promise<CliResult<Session[]>>;
  daemonStatus(): Promise<CliResult<DaemonStatus>>;
}
