import type {
  ClaudeClient,
  StartSessionOutcome,
  StartSessionRequest,
} from './client.js';
import {
  sendReply as sendClaudeReply,
  type ReplyOutcome,
} from './pty/attach.js';
import type {
  CliResult,
  DaemonStatus,
  Session,
} from './types.js';
import type {
  AgentProviderAdapter,
  AgentProviderCapabilities,
  ClaudeRuntimeReader,
  ReplyContext,
} from '../providers/contracts.js';
import { CLAUDE_CODE_PROVIDER_ID } from '../supervisor/sessionBindings.js';

export interface ClaudeProviderAdapterOptions {
  readonly ptyAvailable: boolean;
  /** Injectable only so transport delegation can be tested without a real PTY. */
  readonly reply?: typeof sendClaudeReply | undefined;
}

/**
 * Provider boundary for Claude Code.
 *
 * ClaudeClient remains responsible for CLI discovery, argv construction,
 * output parsing, and error classification. This adapter translates Council's
 * provider-neutral action names onto that verified integration surface.
 */
export class ClaudeProviderAdapter
  implements
    AgentProviderAdapter<typeof CLAUDE_CODE_PROVIDER_ID>,
    ClaudeRuntimeReader
{
  readonly providerId = CLAUDE_CODE_PROVIDER_ID;
  readonly capabilities: AgentProviderCapabilities;
  private readonly replyTransport: typeof sendClaudeReply;

  constructor(
    private readonly client: ClaudeClient,
    options: ClaudeProviderAdapterOptions,
  ) {
    this.capabilities = {
      start: true,
      stop: true,
      logs: true,
      plainTextReply: options.ptyAvailable,
      persistentSessions: true,
    };
    this.replyTransport = options.reply ?? sendClaudeReply;
  }

  verifyLaunchCapability(): Promise<CliResult<unknown>> {
    return this.client.verifyLaunchCapability();
  }

  listSessions(
    options?: { readonly all?: boolean; readonly cwd?: string },
  ): Promise<CliResult<Session[]>> {
    return this.client.listSessions(options);
  }

  startSession(
    request: StartSessionRequest,
  ): Promise<CliResult<StartSessionOutcome>> {
    return this.client.start(request);
  }

  stopSession(providerSessionId: string): Promise<CliResult<string>> {
    return this.client.stop(providerSessionId);
  }

  resumeSession(providerSessionId: string): Promise<CliResult<string>> {
    return this.client.respawn(providerSessionId);
  }

  readLogs(providerSessionId: string): Promise<CliResult<string>> {
    return this.client.logs(providerSessionId);
  }

  sendReply(
    providerSessionId: string,
    message: string,
    context: ReplyContext = {},
  ): Promise<CliResult<ReplyOutcome>> {
    return this.replyTransport(this.client.cli.bin, providerSessionId, message, {
      cwd: context.cwd,
    });
  }

  daemonStatus(): Promise<CliResult<DaemonStatus>> {
    return this.client.daemonStatus();
  }
}
