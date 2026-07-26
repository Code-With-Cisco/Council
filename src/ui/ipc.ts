import type { StartSessionOutcome } from '../integration/client.js';
import type { ReplyOutcome } from '../integration/pty/attach.js';
import type { Snapshot } from '../integration/runtime.js';
import type { AgentRuntimeCapabilities } from '../supervisor/contracts.js';
import type { ResolvedAgentCatalog } from '../supervisor/catalog.js';
import type { SessionBindingStoreProblem } from '../supervisor/sessionBindings.js';
import type {
  UiCreateMissionInput,
  UiCreateMissionResult,
  UiIntegrationPreview,
  UiIntegrationResult,
  UiMissionState,
  UiRecordGateInput,
  UiRecordHandoffInput,
  UiRetryMissionExecutionInput,
  UiRetryMissionExecutionResult,
  UiCreateCandidateInput,
  UiMissionCandidate,
  UiMissionGate,
  UiMissionHandoff,
  UiPreviewIntegrationInput,
  UiPreviewSquadInput,
  UiSquadStartPreview,
  UiSquadStartResult,
} from './missionUi.js';

export const IPC_CHANNELS = {
  getState: 'dc:get-state',
  chooseWorkspace: 'dc:choose-workspace',
  startMember: 'dc:start-member',
  startNewMember: 'dc:start-new-member',
  resumeMember: 'dc:resume-member',
  clearBinding: 'dc:clear-binding',
  stopSession: 'dc:stop-session',
  wakeSquad: 'dc:wake-squad',
  logs: 'dc:logs',
  reply: 'dc:reply',
  council: 'dc:council',
  getMissionState: 'dc:mission:get-state',
  createMission: 'dc:mission:create',
  previewSquad: 'dc:mission:preview-squad',
  startSquad: 'dc:mission:start-squad',
  retryMissionExecution: 'dc:mission:retry-execution',
  recordHandoff: 'dc:mission:record-handoff',
  createCandidate: 'dc:mission:create-candidate',
  recordGate: 'dc:mission:record-gate',
  previewIntegration: 'dc:mission:preview-integration',
  approveIntegration: 'dc:mission:approve-integration',
  rejectIntegration: 'dc:mission:reject-integration',
  missionState: 'dc:mission:state',
  snapshot: 'dc:snapshot',
  state: 'dc:state',
} as const;

export interface UiWorkspaceState {
  readonly status: 'setup' | 'invalid' | 'ready';
  readonly id: string | undefined;
  readonly label: string | undefined;
  readonly selectedPath: string | undefined;
  readonly canonicalPath: string | undefined;
  readonly trusted: boolean;
  readonly developmentOverride: boolean;
  readonly diagnostic: string | undefined;
}

export interface UiExecutableStatus {
  readonly name: 'PowerShell' | 'git' | 'node';
  readonly available: boolean;
  readonly version: string | undefined;
  readonly discoveredVia: 'candidate-probe' | 'process' | 'not-found';
}

export interface UiLaunchPreflight {
  readonly checkedAt: string;
  readonly platform: NodeJS.Platform;
  readonly supportedPlatform: boolean;
  readonly claude:
    | {
        readonly version: string | undefined;
        readonly meetsMinimum: boolean;
        readonly discoveredVia: 'override' | 'path' | 'well-known' | 'vscode-extension';
      }
    | null;
  readonly powershell: UiExecutableStatus;
  readonly git: UiExecutableStatus;
  readonly node: UiExecutableStatus;
  readonly guardSelfTest: {
    readonly status: 'passed' | 'failed' | 'unavailable';
    readonly message: string;
  };
  readonly hookHandlerCount: number;
  readonly ptyAvailable: boolean;
}

export interface UiState {
  readonly workspace: UiWorkspaceState;
  readonly projectDir: string | undefined;
  readonly preflight: UiLaunchPreflight | undefined;
  readonly capabilities: AgentRuntimeCapabilities;
  readonly rosterProblems: readonly string[];
  readonly startupMessages: readonly string[];
  readonly catalog: ResolvedAgentCatalog | undefined;
  readonly bindingProblem: SessionBindingStoreProblem | undefined;
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
  chooseWorkspace(): Promise<UiResult<UiState>>;
  startMember(
    profileId: string,
    expectedDefinitionFingerprint: string,
  ): Promise<UiResult<StartSessionOutcome>>;
  startNewMember(
    profileId: string,
    expectedDefinitionFingerprint: string,
  ): Promise<UiResult<StartSessionOutcome>>;
  resumeMember(profileId: string): Promise<UiResult<string>>;
  clearBinding(profileId: string): Promise<UiResult<string>>;
  stopSession(profileId: string): Promise<UiResult<string>>;
  wakeSquad(): Promise<UiResult<string>>;
  logs(profileId: string): Promise<UiResult<string>>;
  reply(profileId: string, message: string): Promise<UiResult<ReplyOutcome>>;
  council(
    question: string,
    expectedDefinitionFingerprint: string,
  ): Promise<UiResult<StartSessionOutcome>>;
  getMissionState(): Promise<UiResult<UiMissionState>>;
  createMission(
    input: UiCreateMissionInput,
  ): Promise<UiResult<UiCreateMissionResult>>;
  previewSquad(
    input: UiPreviewSquadInput,
  ): Promise<UiResult<UiSquadStartPreview>>;
  startSquad(previewDigest: string): Promise<UiResult<UiSquadStartResult>>;
  retryMissionExecution(
    input: UiRetryMissionExecutionInput,
  ): Promise<UiResult<UiRetryMissionExecutionResult>>;
  recordHandoff(
    input: UiRecordHandoffInput,
  ): Promise<UiResult<UiMissionHandoff>>;
  createCandidate(
    input: UiCreateCandidateInput,
  ): Promise<UiResult<UiMissionCandidate>>;
  recordGate(input: UiRecordGateInput): Promise<UiResult<UiMissionGate>>;
  previewIntegration(
    input: UiPreviewIntegrationInput,
  ): Promise<UiResult<UiIntegrationPreview>>;
  approveIntegration(
    previewDigest: string,
  ): Promise<UiResult<UiIntegrationResult>>;
  rejectIntegration(
    previewDigest: string,
  ): Promise<UiResult<UiIntegrationResult>>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onState(listener: (state: UiState) => void): () => void;
  onMissionState(listener: (state: UiMissionState) => void): () => void;
}
