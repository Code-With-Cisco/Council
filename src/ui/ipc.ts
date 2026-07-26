import type { StartSessionOutcome } from '../integration/client.js';
import type { LaunchPreflight } from '../integration/preflight.js';
import type { ReplyOutcome } from '../integration/pty/attach.js';
import type { Snapshot } from '../integration/runtime.js';
import type { AgentRuntimeCapabilities } from '../supervisor/contracts.js';

export const IPC_CHANNELS = {
  getState: 'dc:get-state',
  startMember: 'dc:start-member',
  stopSession: 'dc:stop-session',
  wakeSquad: 'dc:wake-squad',
  logs: 'dc:logs',
  reply: 'dc:reply',
  council: 'dc:council',
  snapshot: 'dc:snapshot',
} as const;

export interface UiState {
  readonly projectDir: string;
  readonly preflight: LaunchPreflight;
  readonly capabilities: AgentRuntimeCapabilities;
  readonly rosterProblems: readonly string[];
  readonly startupMessages: readonly string[];
  readonly snapshot: Snapshot | undefined;
}

export interface UiFailure {
  readonly ok: false;
  readonly message: string;
  readonly details?: string | undefined;
}

export interface UiSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type UiResult<T> = UiSuccess<T> | UiFailure;

export interface DecagramCouncilApi {
  getState(): Promise<UiState>;
  startMember(key: string): Promise<UiResult<StartSessionOutcome>>;
  stopSession(id: string): Promise<UiResult<string>>;
  wakeSquad(): Promise<UiResult<string>>;
  logs(id: string): Promise<UiResult<string>>;
  reply(id: string, message: string): Promise<UiResult<ReplyOutcome>>;
  council(question: string, cwd: string): Promise<UiResult<StartSessionOutcome>>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}
