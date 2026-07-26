/**
 * Decagram Council's Claude Code integration layer — the complete public API.
 *
 * This module is deliberately free of Electron and of any UI concern: it is
 * importable from a plain Node script, which is what the test harness
 * (`npm run harness`) uses to prove round-trips against a real local Claude Code
 * install before any renderer exists.
 *
 * The app is not an agent runtime. Claude Code's per-user supervisor daemon
 * already hosts background sessions that persist across sleep and terminal
 * closes. Everything here shells out to `claude` and reads state files.
 */

export type {
  AgentValidation,
  CliFailure,
  CliFailureKind,
  CliResult,
  CliSuccess,
  DaemonStatus,
  JobStateFile,
  KnownWaitingFor,
  ParseProblem,
  RawRosterEntry,
  RosterConfig,
  RosterMember,
  Session,
  SessionKind,
  SessionSource,
  SessionState,
  SquadSlot,
  StartedSession,
  TeamMember,
  TeamSnapshot,
  TeamTask,
  WaitingFor,
} from './types.js';
export { KNOWN_WAITING_FOR, SESSION_STATES } from './types.js';

export { ClaudePaths, ProjectPaths, claudeConfigDir } from './paths.js';

export { ClaudeClient, buildStartSessionArgv } from './client.js';
export type {
  ClaudeClientOptions,
  StartExecRequest,
  StartSessionOutcome,
  StartSessionRequest,
} from './client.js';

export {
  MINIMUM_CLAUDE_VERSION,
  compareVersions,
  locateClaude,
  parseVersion,
} from './cli/locate.js';
export type { LocateOptions, LocatedCli } from './cli/locate.js';
export { DEFAULT_TIMEOUT_MS, runClaude, runClaudeJson } from './cli/exec.js';
export type { ExecOptions } from './cli/exec.js';
export { classifyOutput, detectUnknownAgentWarning, summarizeOutput } from './cli/errors.js';

export { parseDaemonStatus } from './parse/daemon.js';
export {
  backgroundSessions,
  normalizeRosterEntry,
  parseRoster,
  parseStartedSession,
  shortIdFor,
} from './parse/roster.js';

export {
  enrichSession,
  readJobState,
  readJobsSnapshot,
  readPins,
  sessionsFromJobsOnly,
} from './fs/jobs.js';
export type { JobsSnapshot } from './fs/jobs.js';
export { leadShortIdFromTeamName, listTeams, readAllTeams, readTeam } from './fs/teams.js';
export { listAgentDefinitions, parseFrontmatter, validateAgentName } from './fs/agentDefs.js';
export type { AgentDefinition } from './fs/agentDefs.js';
export { ClaudeStateWatcher } from './fs/watch.js';
export type { StateChange, StateChangeArea, WatchOptions } from './fs/watch.js';

export {
  DEFAULT_POLL_INTERVAL_MS,
  SPECIALIST_KEYS,
  defaultRosterConfig,
  loadRosterConfig,
  parseRosterConfig,
  saveRosterConfig,
} from './roster/config.js';
export type { RosterConfigLoad, SpecialistKey } from './roster/config.js';
export {
  buildUnifiedRoster,
  membersNeedingStart,
  membersNeedingWake,
  mergeSessions,
  sessionsNeedingInput,
} from './roster/unified.js';
export type { BuildRosterInput, UnifiedRoster } from './roster/unified.js';

export { DECAGRAM_COUNCIL_HOOK_EVENTS, isNeedsInput, parseHookDelivery } from './hooks/events.js';
export type {
  HookBase,
  HookDelivery,
  HookPayload,
  DecagramCouncilHookEvent,
  NotificationPayload,
  NotificationType,
  SubagentPayload,
  TaskPayload,
  TeammateIdlePayload,
  ToolFailurePayload,
} from './hooks/events.js';
export { HookReceiver, SECRET_HEADER } from './hooks/receiver.js';
export type { ReceiverDescriptor, ReceiverOptions } from './hooks/receiver.js';
export {
  DECAGRAM_COUNCIL_HOOK_MARKER,
  generateHookConfig,
  installHooks,
  mergeHookConfig,
  planHookInstall,
  removeHookConfig,
} from './hooks/generate.js';
export type { CommandHookHandler, HookInstallPlan, HooksConfig, InstallResult } from './hooks/generate.js';
export { POWERSHELL_HOOK_FILENAME, powershellHookScript } from './hooks/scripts.js';

export {
  GATE_MARKER,
  GATE_POWERSHELL,
  POWERSHELL_GUARD_FILES,
  SHELL_DISPATCH_POWERSHELL,
  WRITE_DISPATCH_POWERSHELL,
  bundledGatesDir,
  generateGateConfig,
  installGates,
  planGateInstall,
} from './gates/install.js';
export type {
  GateInstallPlan,
  GateScriptLocation,
  GenerateGateOptions,
} from './gates/install.js';
export { runGuardSelfTest } from './gates/selfTest.js';
export type {
  GuardSelfTestOptions,
  GuardSelfTestResult,
  GuardSelfTestStatus,
} from './gates/selfTest.js';

export { AttachSession, loadPty, sendReply } from './pty/attach.js';
export type { AttachOptions, ReplyOptions, ReplyOutcome } from './pty/attach.js';

export { boardCounts, readBoard, worktreeBoards } from './board/read.js';
export type { Board, Epic, GateStatus, Story } from './board/read.js';

export { DecagramCouncilRuntime } from './runtime.js';
export type { BootReport, RuntimeOptions, Snapshot } from './runtime.js';
export { runLaunchPreflight } from './preflight.js';
export type {
  ExecutableStatus,
  LaunchPreflight,
  LaunchPreflightOptions,
} from './preflight.js';
