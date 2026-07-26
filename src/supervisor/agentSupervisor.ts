import type { ClaudeClient, StartSessionOutcome } from '../integration/client.js';
import type { ClaudePaths } from '../integration/paths.js';
import { sendReply, type ReplyOutcome } from '../integration/pty/attach.js';
import {
  DecagramCouncilRuntime,
  type BootReport,
  type RuntimeOptions,
  type Snapshot,
} from '../integration/runtime.js';
import type { CliFailure, CliResult, RosterConfig } from '../integration/types.js';
import type { AgentRuntimeCapabilities, AgentSupervisorPort } from './contracts.js';

export interface ClaudeCodeAgentSupervisorOptions {
  readonly client: ClaudeClient;
  readonly paths: ClaudePaths;
  readonly config: RosterConfig;
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

/**
 * First supervisor implementation. It keeps Electron independent of Claude's
 * client/runtime details while preserving the existing integration behavior.
 * A future process, SDK, or local-model adapter can implement the same port.
 */
export class ClaudeCodeAgentSupervisor implements AgentSupervisorPort {
  readonly runtimeId = 'claude-code';
  readonly capabilities: AgentRuntimeCapabilities;
  private readonly runtime: DecagramCouncilRuntime;

  constructor(private readonly options: ClaudeCodeAgentSupervisorOptions) {
    this.capabilities = {
      start: true,
      stop: true,
      logs: true,
      plainTextReply: options.ptyAvailable,
      interactiveTerminal: false,
      persistentSessions: true,
      councilReview: true,
    };
    this.runtime = new DecagramCouncilRuntime({
      client: options.client,
      paths: options.paths,
      config: options.config,
      onSnapshot: options.onSnapshot,
      ...(options.onHook === undefined ? {} : { onHook: options.onHook }),
      ...(options.onNeedsInput === undefined ? {} : { onNeedsInput: options.onNeedsInput }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
  }

  get current(): Snapshot | undefined {
    return this.runtime.current;
  }

  boot(): Promise<BootReport> {
    return this.runtime.boot();
  }

  start(): Promise<void> {
    return this.runtime.start();
  }

  stop(): Promise<void> {
    return this.runtime.stop();
  }

  startMember(key: string): Promise<CliResult<StartSessionOutcome>> {
    const slot = this.current?.roster.squad.find((entry) => entry.member.key === key);
    if (slot === undefined) {
      return Promise.resolve(domainFailure(`No configured agent matches "${key}".`, ['--bg']));
    }
    if (!slot.missing) {
      return Promise.resolve(
        domainFailure(`${slot.member.label} already has a session.`, ['--bg', '--agent', slot.member.agent]),
      );
    }
    return this.runtime.startMember(slot.member);
  }

  stopSession(id: string): Promise<CliResult<string>> {
    if (!this.isKnownActionableSession(id)) {
      return Promise.resolve(domainFailure('That session is not in the current roster.', ['stop', id]));
    }
    return this.options.client.stop(id);
  }

  wakeSquad(): Promise<CliResult<string>> {
    return this.runtime.wakeSquad();
  }

  logs(id: string): Promise<CliResult<string>> {
    if (!this.isKnownActionableSession(id)) {
      return Promise.resolve(domainFailure('That session is not in the current roster.', ['logs', id]));
    }
    return this.options.client.logs(id);
  }

  reply(id: string, message: string): Promise<CliResult<ReplyOutcome>> {
    if (!this.capabilities.plainTextReply) {
      return Promise.resolve(
        domainFailure('Reply is disabled because the terminal bridge is unavailable.', ['attach', id]),
      );
    }
    if (!this.isKnownActionableSession(id)) {
      return Promise.resolve(domainFailure('That session is not in the current roster.', ['attach', id]));
    }
    return sendReply(this.options.client.cli.bin, id, message);
  }

  startCouncilReview(
    question: string,
    cwd: string,
  ): Promise<CliResult<StartSessionOutcome>> {
    return this.runtime.startCouncilReview(question, cwd);
  }

  private isKnownActionableSession(id: string): boolean {
    return this.current?.roster.sessions.some((session) => session.id === id) === true;
  }
}
