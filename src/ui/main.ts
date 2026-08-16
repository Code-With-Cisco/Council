import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch, type FSWatcher } from 'chokidar';
import electronUpdater from 'electron-updater';
import {
  AppConfigStore,
  validateWorkspaceDirectory,
  type WorkspaceRecord,
} from '../config/appConfig.js';
import type { CliResult } from '../integration/types.js';
import { ClaudeClient } from '../integration/client.js';
import { ClaudeProviderAdapter } from '../integration/claudeProviderAdapter.js';
import { NodeGitPort } from '../git/index.js';
import { AgentDefinitionWatcher } from '../integration/fs/agentWatch.js';
import { ClaudePaths } from '../integration/paths.js';
import { runLaunchPreflight, type LaunchPreflight } from '../integration/preflight.js';
import {
  RosterConfigStore,
  type RosterConfigStoreLoad,
} from '../integration/roster/config.js';
import { buildUnifiedRoster } from '../integration/roster/unified.js';
import type { Snapshot } from '../integration/runtime.js';
import {
  ClaudeCodeAgentSupervisor,
  SessionBindingStore,
  resolveAgentCatalog,
  resolveProfiles,
  type AgentRuntimeCapabilities,
  type AgentSupervisorPort,
  type ResolvedAgentCatalog,
  type ResolvedProfiles,
} from '../supervisor/index.js';
import { fingerprintAgentDefinition } from '../supervisor/catalog.js';
import {
  CodexAppServerClient,
  CodexMissionProviderAdapter,
  CodexThreadBindingStore,
  locateCodex,
} from '../providers/codex/index.js';
import { MissionLedgerStore } from '../missions/ledger.js';
import {
  MissionCoordinator,
} from '../missions/coordinator.js';
import { MissionGitAdapter } from '../missions/gitAdapter.js';
import { MissionProviderRouter } from '../missions/providerRouter.js';
import { MissionWorktreeAdapter } from '../missions/worktreeAdapter.js';
import { GateRunner } from '../missions/gateRunner.js';
import {
  WorktreeLeaseManager,
  WorktreeLeaseStore,
} from '../orchestration/worktrees/index.js';
import { acquireSingleInstance } from './singleInstance.js';
import {
  IPC_CHANNELS,
  type UiFailure,
  type UiIssue,
  type UiLaunchPreflight,
  type UiResult,
  type UiState,
  type UiWorkspaceState,
} from './ipc.js';
import { registerCouncilIpc } from './ipcHandlers.js';
import { DiagnosticJournal } from './diagnosticJournal.js';
import { AgentPackInstaller } from './agentPack.js';
import {
  AppUpdateController,
  type AppUpdaterPort,
  type AppUpdateState,
} from './appUpdater.js';
import type { MissionUiController } from './missionUi.js';
import { PrivilegedMissionUiController } from './missionController.js';
import {
  SerializedLifecycle,
  type SerializedLifecycleContext,
} from './serializedLifecycle.js';

const APP_ID = 'com.decagram.council';
const APP_NAME = 'Decagram Council';
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sourceUiDir = path.resolve(currentDir, '../../../src/ui');

app.setName(APP_NAME);

let mainWindow: BrowserWindow | undefined;
let supervisor: AgentSupervisorPort | undefined;
let claudeSupervisor: ClaudeCodeAgentSupervisor | undefined;
let claudeRuntimeClient: ClaudeClient | undefined;
let missionUiController: MissionUiController | undefined;
let missionWorktrees: WorktreeLeaseManager | undefined;
let definitionWatcher: AgentDefinitionWatcher | undefined;
let profileWatcher: FSWatcher | undefined;
let bindingWatcher: FSWatcher | undefined;
let applicationConfigWatcher: FSWatcher | undefined;
let currentState: UiState | undefined;
let shutdownStarted = false;
let updateInstallRequested = false;
let activationGeneration = 0;
const applicationLifecycle = new SerializedLifecycle();
let catalogRefresh: Promise<void> = Promise.resolve();
let appConfigStore: AppConfigStore;
let bindingStore: SessionBindingStore;
let codexThreadBindings: CodexThreadBindingStore;
let codexClient: CodexAppServerClient | undefined;
let codexMissionProvider: CodexMissionProviderAdapter | undefined;
let missionLedgerStore: MissionLedgerStore;
let worktreeLeaseStore: WorktreeLeaseStore;
let claudePaths: ClaudePaths;
let diagnosticJournal: DiagnosticJournal;
let appUpdateController: AppUpdateController;
let profileStore: RosterConfigStore | undefined;
let savedRoster: RosterConfigStoreLoad | undefined;
let supervisorActionsReady = false;
let activeConfigurationSignature: string | undefined;
const controllerProblems = new Map<'binding' | 'catalog' | 'profile', string>();

const UNAVAILABLE_CAPABILITIES: AgentRuntimeCapabilities = {
  start: false,
  stop: false,
  logs: false,
  plainTextReply: false,
  interactiveTerminal: false,
  persistentSessions: true,
  councilReview: false,
};

function unavailable(message: string): UiFailure {
  return { ok: false, message };
}

function configurationSignature(
  workspace: WorkspaceRecord,
  includeUserDefinitions: boolean,
): string {
  return JSON.stringify({
    id: workspace.id,
    label: workspace.label,
    selectedPath: workspace.selectedPath,
    canonicalPath: workspace.canonicalPath,
    trusted: workspace.trusted,
    includeUserDefinitions,
  });
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  };
  return normalize(left) === normalize(right);
}

function isInsideCanonicalRoot(root: string, candidate: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  };
  const relative = path.relative(normalize(root), normalize(candidate));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function profileLoadProblem(
  loaded: RosterConfigStoreLoad,
): string | undefined {
  if (!loaded.writeBlocked && loaded.problems.length === 0) return undefined;
  return (
    'Profile preferences are not authoritative and were not overwritten: ' +
    (loaded.problems.join(' · ') || 'the profile document could not be validated')
  );
}

function toUiResult<T>(result: CliResult<T>): UiResult<T> {
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, message: result.message, details: result.raw };
}

function setupWorkspaceState(
  diagnostic?: string | undefined,
  record?: WorkspaceRecord | undefined,
  developmentOverride = false,
): UiWorkspaceState {
  return {
    status: diagnostic === undefined ? 'setup' : 'invalid',
    id: record?.id,
    label: record?.label,
    selectedPath: record?.selectedPath,
    canonicalPath: record?.canonicalPath,
    trusted: record?.trusted ?? false,
    developmentOverride,
    diagnostic,
  };
}

function readyWorkspaceState(
  record: WorkspaceRecord,
  developmentOverride: boolean,
): UiWorkspaceState {
  return {
    status: 'ready',
    id: record.id,
    label: record.label,
    selectedPath: record.selectedPath,
    canonicalPath: record.canonicalPath,
    trusted: record.trusted,
    developmentOverride,
    diagnostic: undefined,
  };
}

function initialState(workspace: UiWorkspaceState, startupMessages: readonly string[]): UiState {
  return {
    workspace,
    projectDir: undefined,
    preflight: undefined,
    capabilities: UNAVAILABLE_CAPABILITIES,
    rosterProblems: [],
    startupMessages,
    catalog: undefined,
    bindingProblem: bindingStore?.problem,
    snapshot: undefined,
    issues: [],
  };
}

function deriveUiIssues(state: UiState): readonly UiIssue[] {
  const issues: UiIssue[] = [];
  const snapshot = state.snapshot;
  for (const session of snapshot?.needsInput ?? []) {
    if (snapshot === undefined) break;
    const slot = snapshot.roster.squad.find(
      (candidate) => candidate.session?.id === session.id,
    );
    issues.push({
      id: `session:${session.id ?? session.sessionId ?? session.name ?? 'unknown'}`,
      severity: 'attention',
      source: 'session',
      summary: `${session.name ?? slot?.member.label ?? 'Agent'} needs attention`,
      detail: session.waitingFor ?? session.detail ?? 'Waiting for input',
      destination: {
        view: slot?.member.mode === 'internal' ? 'council' : 'squad',
        profileId: slot?.member.key,
      },
      actions: [
        'open',
        ...(session.waitingFor === 'input needed' ? (['reply'] as const) : []),
      ],
    });
  }
  if (snapshot?.rosterError !== undefined) {
    issues.push({
      id: 'provider:claude-roster',
      severity: 'error',
      source: 'provider',
      summary: 'Claude roster is unavailable',
      detail: snapshot.rosterError.message,
      destination: { view: 'diagnostics', diagnosticKey: 'claude-daemon' },
      actions: ['open', 'refresh'],
    });
  }
  if (snapshot?.definitionError !== undefined) {
    issues.push({
      id: 'catalog:definitions',
      severity: 'error',
      source: 'catalog',
      summary: 'Agent definitions need attention',
      detail: snapshot.definitionError,
      destination: { view: 'diagnostics', diagnosticKey: 'agent-catalog' },
      actions: ['open', 'refresh'],
    });
  }
  if (state.bindingProblem !== undefined) {
    issues.push({
      id: 'binding:store',
      severity: 'error',
      source: 'binding',
      summary: 'Session bindings need attention',
      detail: state.bindingProblem.message,
      destination: { view: 'diagnostics', diagnosticKey: 'session-bindings' },
      actions: ['open', 'refresh'],
    });
  }
  if (state.preflight?.claude === null) {
    issues.push({
      id: 'preflight:claude',
      severity: 'error',
      source: 'preflight',
      summary: 'Claude CLI was not found',
      detail: 'Install Claude Code or configure its executable before starting agents.',
      destination: { view: 'diagnostics', diagnosticKey: 'claude-cli' },
      actions: ['open', 'refresh'],
    });
  }
  return issues;
}

function refreshCurrentIssues(): void {
  if (currentState === undefined) return;
  currentState = { ...currentState, issues: deriveUiIssues(currentState) };
}

function toUiPreflight(preflight: LaunchPreflight): UiLaunchPreflight {
  const executable = (
    status: LaunchPreflight['powershell'],
  ): UiLaunchPreflight['powershell'] => ({
    name: status.name,
    available: status.available,
    resolvedPath: status.executable,
    version: status.version,
    discoveredVia: status.discoveredVia,
  });
  const hookHandlerCount = Object.values(preflight.hookConfig)
    .flatMap((groups) => groups ?? [])
    .reduce((count, group) => count + (group.hooks?.length ?? 0), 0);
  return {
    checkedAt: preflight.checkedAt,
    platform: preflight.platform,
    supportedPlatform: preflight.supportedPlatform,
    claude:
      preflight.claude === null
        ? null
        : {
            version: preflight.claude.version,
            meetsMinimum: preflight.claude.meetsMinimum,
            discoveredVia: preflight.claude.discoveredVia,
          },
    powershell: executable(preflight.powershell),
    bash: executable(preflight.bash),
    git: executable(preflight.git),
    node: executable(preflight.node),
    guardSelfTest: {
      status: preflight.guardSelfTest.status,
      message: preflight.guardSelfTest.message,
    },
    supervisor: {
      recognized: preflight.supervisor.status?.recognized ?? false,
      running: preflight.supervisor.status?.running ?? false,
      reachable: preflight.supervisor.reachable,
      version: preflight.supervisor.status?.version,
      workerCount: preflight.supervisor.status?.workerCount,
      versionMismatch: preflight.supervisor.versionMismatch,
      diagnostic: preflight.supervisor.diagnostic,
      raw: preflight.supervisor.status?.raw ?? '',
    },
    hookHandlerCount,
    ptyAvailable: preflight.ptyAvailable,
  };
}

function catalogOnlySnapshot(
  profiles: ResolvedProfiles,
  catalog: ResolvedAgentCatalog,
  preflight: LaunchPreflight,
): Snapshot {
  const bindings = new Map(
    Object.entries(bindingStore.state.data.bindings),
  );
  const message =
    preflight.claude === null
      ? 'Claude CLI is unavailable; catalog inventory remains visible.'
      : 'Claude CLI does not meet the supported minimum; catalog inventory remains visible.';
  return {
    roster: buildUnifiedRoster({
      config: profiles.config,
      rosterSessions: [],
      jobs: { states: new Map(), pinned: new Set(), problems: [] },
      teams: [],
      validations: profiles.validations,
      bindings,
      rosterAvailable: false,
    }),
    daemon: undefined,
    rosterError: {
      ok: false,
      kind: preflight.claude === null ? 'cli-missing' : 'cli-error',
      message,
      raw: '',
      argv: ['agents', '--json', '--all'],
      exitCode: null,
      durationMs: 0,
    },
    updatedAt: new Date(),
    needsInput: [],
    needsWake: false,
    catalogRevision: catalog.revision,
    catalogProblems: profiles.catalogProblems,
  };
}

function publishState(): void {
  if (currentState === undefined) return;
  refreshCurrentIssues();
  currentState = {
    ...currentState,
    savedWorkspaces: appConfigStore.current.workspaces.map(({ id, label, trusted }) => ({
      id,
      label,
      trusted,
    })),
  };
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.state, currentState);
}

function publishMissionState(state: Awaited<ReturnType<MissionUiController['getState']>>): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.missionState, state);
}

function publishUpdateState(state: AppUpdateState): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.updateState, state);
}

function markRuntimeStale(
  source: 'binding' | 'catalog' | 'profile',
  message: string,
): void {
  if (currentState === undefined) return;
  controllerProblems.set(source, message);
  currentState = {
    ...currentState,
    startupMessages: [...currentState.startupMessages, message],
  };
  const snapshot = currentState.snapshot;
  if (snapshot === undefined) {
    if (source === 'binding') {
      currentState = { ...currentState, capabilities: UNAVAILABLE_CAPABILITIES };
    }
    publishState();
    return;
  }
  publishSnapshot({ ...snapshot, updatedAt: new Date() });
}

function publishSnapshot(snapshot: Snapshot): void {
  const definitionError = (['catalog', 'profile'] as const)
    .map((source) => controllerProblems.get(source))
    .filter((problem): problem is string => problem !== undefined)
    .join(' · ');
  const effectiveSnapshot: Snapshot = {
    ...snapshot,
    ...(definitionError === ''
      ? { definitionError: undefined }
      : { definitionError, updatedAt: new Date() }),
  };
  if (currentState !== undefined) {
    const runtimeCapabilities =
      supervisorActionsReady &&
      supervisor !== undefined &&
      bindingStore?.problem === undefined &&
      !controllerProblems.has('binding') &&
      effectiveSnapshot.rosterError === undefined
        ? supervisor.capabilities
        : UNAVAILABLE_CAPABILITIES;
    currentState = {
      ...currentState,
      snapshot: effectiveSnapshot,
      capabilities: runtimeCapabilities,
      bindingProblem: bindingStore?.problem,
    };
    refreshCurrentIssues();
  }
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.snapshot, effectiveSnapshot);
    if (currentState !== undefined) {
      mainWindow.webContents.send(IPC_CHANNELS.state, currentState);
    }
  }
}

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  return (
    mainWindow !== undefined &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame
  );
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1380,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    show: false,
    frame: true,
    backgroundColor: '#0e1114',
    webPreferences: {
      preload: path.join(sourceUiDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadFile(path.join(sourceUiDir, 'renderer', 'index.html'));
  return window;
}

async function afterAction<T>(result: CliResult<T>): Promise<UiResult<T>> {
  if (currentState !== undefined) {
    currentState = { ...currentState, bindingProblem: bindingStore.problem };
    publishState();
  }
  return toUiResult(result);
}

function registerIpc(): void {
  registerCouncilIpc(
    {
      handle: (channel, listener) => {
        ipcMain.handle(channel, (event, ...args) => listener(event, ...args));
      },
    },
    {
      isTrusted: (event) => isTrustedIpcSender(event as IpcMainInvokeEvent),
      getState: () => currentState,
      chooseWorkspace,
      activateWorkspace: activateSavedWorkspace,
      getSupervisor: () => (supervisorActionsReady ? supervisor : undefined),
      getMissionController: () => missionUiController,
      recoverSupervisor: async () => {
        if (claudeRuntimeClient === undefined) {
          return unavailable('Claude CLI is unavailable.');
        }
        const result = await claudeRuntimeClient.daemonStop({
          any: true,
          keepWorkers: true,
        });
        return toUiResult(result);
      },
      refreshDiagnostics: async () => {
        const projectDir = currentState?.projectDir;
        if (projectDir === undefined) {
          return unavailable('Choose a trusted repository before refreshing diagnostics.');
        }
        try {
          const preflight = await runLaunchPreflight(projectDir);
          const rendered = toUiPreflight(preflight);
          if (currentState !== undefined) {
            currentState = { ...currentState, preflight: rendered };
            publishState();
          }
          return { ok: true, value: rendered };
        } catch (error) {
          return unavailable(
            `Diagnostics refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      installAgentPack: async () => {
        const projectDir = currentState?.projectDir;
        if (projectDir === undefined || currentState?.workspace.trusted !== true) {
          return unavailable('Choose and trust a repository before installing the Agent Pack.');
        }
        try {
          const installer = new AgentPackInstaller(app.getAppPath(), projectDir);
          const preview = await installer.preview();
          const detail = preview.items
            .map((item) => `${item.action.toUpperCase()}: ${item.relativePath}\n  ${item.detail}`)
            .join('\n');
          if (!preview.canInstall) {
            await dialog.showMessageBox(mainWindow!, {
              type: 'warning',
              title: 'Agent Pack conflicts require attention',
              message: 'No files were changed.',
              detail,
              buttons: ['Close'],
              noLink: true,
            });
            return unavailable('Agent Pack has conflicting files. Review the preview; nothing was overwritten.');
          }
          const confirmation = await dialog.showMessageBox(mainWindow!, {
            type: 'question',
            title: 'Install Agent Pack?',
            message: `Install Agent Pack v${preview.version} into ${currentState.workspace.label ?? 'this repository'}?`,
            detail,
            buttons: ['Install', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          if (confirmation.response !== 0) return unavailable('Agent Pack installation was canceled.');
          const result = await installer.install(preview);
          return { ok: true, value: result };
        } catch (error) {
          return unavailable(`Agent Pack installation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      getUpdateState: () => appUpdateController.state,
      checkForUpdates: async () => {
        const state = await appUpdateController.check();
        return state.status === 'unsupported'
          ? unavailable(state.message)
          : { ok: true, value: state };
      },
      downloadUpdate: async () => {
        if (appUpdateController.state.status !== 'available') {
          return unavailable('Check for an available update before downloading.');
        }
        const state = await appUpdateController.download();
        return state.status === 'error'
          ? unavailable(state.message)
          : { ok: true, value: state };
      },
      installUpdate: async () => {
        if (!appUpdateController.installReady) {
          return unavailable('No downloaded update is ready to install.');
        }
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question',
          title: 'Install update and relaunch?',
          message: `Install Decagram Council ${appUpdateController.state.availableVersion ?? 'update'} now?`,
          detail:
            'Council will close cleanly, install the downloaded update, and relaunch. Provider sessions are not deleted.',
          buttons: ['Install and relaunch', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (confirmation.response !== 0) {
          return unavailable('Update installation was canceled.');
        }
        updateInstallRequested = true;
        setTimeout(() => app.quit(), 100).unref();
        return { ok: true, value: 'restarting' as const };
      },
      canLaunchDefinitions: () =>
        currentState?.capabilities.start === true &&
        currentState.snapshot !== undefined &&
        currentState.snapshot?.definitionError === undefined,
      confirmStartNew: async () => {
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          title: 'Start a new conversation?',
          message: 'The previous Claude conversation will be preserved.',
          detail:
            'Council will replace only this profile’s binding after the new session is safely saved.',
          buttons: ['Start new', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return confirmation.response === 0;
      },
      confirmStartSquad: async () => {
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question',
          title: 'Start this squad?',
          message: 'Start the exact reviewed Mission squad?',
          detail:
            'Council will revalidate the preview fingerprint before creating provider conversations or worktree leases.',
          buttons: ['Start squad', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return confirmation.response === 0;
      },
      confirmMissionIntegration: async () => {
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          title: 'Approve integration?',
          message: 'Integrate the exact reviewed commit?',
          detail:
            'Council will revalidate the target head, Test and Review gates, and single-use preview fingerprint before a fast-forward update.',
          buttons: ['Approve integration', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return confirmation.response === 0;
      },
      recordDiagnostic: (entry) => diagnosticJournal.record(entry),
      afterAction,
    },
  );
}

function transientWorkspaceId(canonicalPath: string): string {
  return `ws_dev_${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 24)}`;
}

async function developmentOverride(): Promise<WorkspaceRecord | undefined> {
  if (app.isPackaged) return undefined;
  const raw = process.env['DECAGRAM_COUNCIL_PROJECT_DIR'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const validated = await validateWorkspaceDirectory(path.resolve(raw));
  return {
    id: transientWorkspaceId(validated.canonicalPath),
    label: validated.label,
    selectedPath: validated.selectedPath,
    canonicalPath: validated.canonicalPath,
    lastValidatedAt: validated.validatedAt,
    trusted: false,
  };
}

async function confirmWorkspaceTrustPrompt(workspace: WorkspaceRecord): Promise<boolean> {
  const confirmation = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    title: 'Trust this repository?',
    message: `Trust “${workspace.label}” and its agent instructions?`,
    detail:
      'Starting an agent allows Claude Code to read the repository and act according to its definition. Council will not copy hooks, agents, or settings into it.',
    buttons: ['Trust and use', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return confirmation.response === 0;
}

async function chooseWorkspace(): Promise<UiResult<UiState>> {
  if (appConfigStore.writeBlocked) {
    return unavailable(
      `Workspace configuration is malformed and was not overwritten: ${appConfigStore.diagnostic?.message ?? 'unknown parse error'}`,
    );
  }
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose a trusted repository',
    properties: ['openDirectory'],
  });
  const selectedPath = selection.filePaths[0];
  if (selection.canceled || selectedPath === undefined) {
    return currentState === undefined
      ? unavailable('Workspace selection was canceled.')
      : { ok: true, value: currentState };
  }

  const previousState = currentState;
  let deactivated = false;
  try {
    const result = await applicationLifecycle.enqueue<UiResult<UiState>>(
      async (context) => {
        let workspace = await appConfigStore.selectWorkspace(selectedPath);
        if (context.isShuttingDown) {
          return unavailable('Council is shutting down.');
        }
        const generation = ++activationGeneration;
        deactivated = true;
        await disposeActiveRuntime();
        if (!isActivationCurrent(generation, context)) {
          return unavailable('Workspace selection was superseded.');
        }

        if (!workspace.trusted) {
          if (!(await confirmWorkspaceTrustPrompt(workspace))) {
            if (context.isShuttingDown) {
              return unavailable('Council is shutting down.');
            }
            if (!isActivationCurrent(generation, context)) {
              return unavailable('Workspace selection was superseded.');
            }
            currentState = initialState(
              setupWorkspaceState('Workspace trust was not granted.', workspace),
              ['Select and trust a repository before starting agents.'],
            );
            publishState();
            return { ok: true, value: currentState };
          }
          if (context.isShuttingDown) {
            return unavailable('Council is shutting down.');
          }
          workspace = await appConfigStore.confirmWorkspaceTrust(workspace.id);
        }

        if (context.isShuttingDown) {
          return unavailable('Workspace selection was superseded.');
        }
        await activateWorkspace(workspace, false, generation, context);
        if (
          !isActivationCurrent(generation, context) ||
          currentState === undefined
        ) {
          return unavailable('Workspace activation did not complete.');
        }
        return { ok: true, value: currentState };
      },
    );
    return result ?? unavailable('Council is shutting down.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState =
      !deactivated && previousState?.workspace.status === 'ready' && !shutdownStarted
        ? {
            ...previousState,
            startupMessages: [...previousState.startupMessages, message],
          }
        : initialState(setupWorkspaceState(message), [message]);
    publishState();
    return unavailable(message);
  }
}

async function activateSavedWorkspace(workspaceId: string): Promise<UiResult<UiState>> {
  const target = appConfigStore.current.workspaces.find((workspace) => workspace.id === workspaceId);
  if (target === undefined) return unavailable('That saved workspace no longer exists.');
  if (currentState?.workspace.id === target.id) return { ok: true, value: currentState };
  try {
    const validated = await validateWorkspaceDirectory(target.selectedPath);
    if (!sameCanonicalPath(validated.canonicalPath, target.canonicalPath)) {
      return unavailable('The saved repository now resolves to a different location. Choose it again to review trust.');
    }
    const selected = await appConfigStore.activateWorkspace(target.id);
    const result = await applicationLifecycle.enqueue<UiResult<UiState>>(async (context) => {
      const generation = ++activationGeneration;
      await disposeActiveRuntime();
      if (!isActivationCurrent(generation, context)) return unavailable('Workspace switch was superseded.');
      await activateWorkspace(selected, false, generation, context);
      return currentState === undefined
        ? unavailable('Workspace activation did not complete.')
        : { ok: true, value: currentState };
    });
    return result ?? unavailable('Council is shutting down.');
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

async function disposeActiveRuntime(): Promise<void> {
  supervisorActionsReady = false;
  missionUiController = undefined;
  const activeMissionWorktrees = missionWorktrees;
  missionWorktrees = undefined;
  activeConfigurationSignature = undefined;
  controllerProblems.clear();
  const watcher = definitionWatcher;
  definitionWatcher = undefined;
  const savedProfileWatcher = profileWatcher;
  profileWatcher = undefined;
  const savedBindingWatcher = bindingWatcher;
  bindingWatcher = undefined;
  profileStore = undefined;
  savedRoster = undefined;
  const active = supervisor;
  supervisor = undefined;
  claudeSupervisor = undefined;
  claudeRuntimeClient = undefined;

  const failures: unknown[] = [];
  const watcherResults = await Promise.allSettled([
    watcher?.stop() ?? Promise.resolve(),
    savedProfileWatcher?.close() ?? Promise.resolve(),
    savedBindingWatcher?.close() ?? Promise.resolve(),
    activeMissionWorktrees?.shutdown() ?? Promise.resolve(),
  ]);
  for (const result of watcherResults) {
    if (result.status === 'rejected') failures.push(result.reason);
  }

  // A refresh may already be inside a filesystem read or supervisor update.
  // Let it observe the generation change and settle before stopping the
  // supervisor it references.
  try {
    await catalogRefresh;
  } catch (error) {
    failures.push(error);
  }
  if (active !== undefined) {
    try {
      await active.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to fully dispose the active workspace runtime.');
  }
}

function isActivationCurrent(
  generation: number,
  context?: SerializedLifecycleContext | undefined,
): boolean {
  return (
    !shutdownStarted &&
    !applicationLifecycle.isShuttingDown &&
    context?.isShuttingDown !== true &&
    generation === activationGeneration
  );
}

async function abandonActivation(
  generation: number,
  context: SerializedLifecycleContext,
): Promise<boolean> {
  if (isActivationCurrent(generation, context)) return false;
  await disposeActiveRuntime();
  return true;
}

async function activateWorkspace(
  workspace: WorkspaceRecord,
  isDevelopmentOverride: boolean,
  generation: number,
  context: SerializedLifecycleContext,
): Promise<void> {
  await disposeActiveRuntime();
  if (await abandonActivation(generation, context)) return;
  if (!workspace.trusted) {
    currentState = initialState(
      setupWorkspaceState('Trust this workspace before launching agents.', workspace),
      [],
    );
    publishState();
    return;
  }
  activeConfigurationSignature = configurationSignature(
    workspace,
    appConfigStore.current.includeUserDefinitions,
  );

  const startupMessages: string[] = [];
  let preflight: LaunchPreflight;
  try {
    preflight = await runLaunchPreflight(workspace.canonicalPath);
  } catch (error) {
    if (await abandonActivation(generation, context)) return;
    const message = error instanceof Error ? error.message : String(error);
    currentState = initialState(
      setupWorkspaceState(`Preflight failed: ${message}`, workspace, isDevelopmentOverride),
      [message],
    );
    publishState();
    return;
  }
  if (await abandonActivation(generation, context)) return;

  const resolveCatalog = (): Promise<ResolvedAgentCatalog> =>
    resolveAgentCatalog({
      workspaceId: workspace.id,
      workspaceRoot: workspace.canonicalPath,
      userAgentsDir: claudePaths.agentsDir(),
      includeUser: appConfigStore.current.includeUserDefinitions,
    });

  let catalog = await resolveCatalog();
  if (await abandonActivation(generation, context)) return;
  const rosterFile = path.join(app.getPath('userData'), 'roster.json');
  profileStore = new RosterConfigStore(
    rosterFile,
    workspace.canonicalPath,
    workspace.id,
  );
  savedRoster = await profileStore.load();
  if (await abandonActivation(generation, context)) return;
  const initialProfileProblem = profileLoadProblem(savedRoster);
  if (initialProfileProblem !== undefined) {
    controllerProblems.set('profile', initialProfileProblem);
    startupMessages.push(initialProfileProblem);
  }
  await bindingStore.reload();
  if (await abandonActivation(generation, context)) return;
  const durableBindings = () => Object.values(bindingStore.state.data.bindings);
  const pendingLaunches = () =>
    Object.values(bindingStore.state.data.pendingLaunches);
  let profiles = resolveProfiles(
    savedRoster.config,
    catalog,
    durableBindings(),
    pendingLaunches(),
  );
  if (await abandonActivation(generation, context)) return;
  if (profiles.ignoredLegacyPlaceholders) {
    startupMessages.push('Ignored the obsolete generated placeholder roster.');
  }
  if (catalog.entries.length > 0) {
    startupMessages.push(
      `Resolved ${catalog.entries.length} agent definition${catalog.entries.length === 1 ? '' : 's'} for this workspace.`,
    );
  }

  const userData = app.getPath('userData');
  diagnosticJournal = new DiagnosticJournal(userData);
  const missionWorktreeRoot = path.join(userData, 'mission-worktrees');
  const gateWorktreeRoot = path.join(userData, 'mission-gate-worktrees');
  const emptyHooksPath = path.join(userData, 'council-empty-git-hooks');
  await Promise.all([
    mkdir(missionWorktreeRoot, { recursive: true }),
    mkdir(gateWorktreeRoot, { recursive: true }),
    mkdir(emptyHooksPath, { recursive: true }),
  ]);
  const [
    canonicalMissionWorktreeRoot,
    canonicalGateWorktreeRoot,
    canonicalEmptyHooksPath,
  ] = await Promise.all([
    realpath(missionWorktreeRoot),
    realpath(gateWorktreeRoot),
    realpath(emptyHooksPath),
  ]);
  if (await abandonActivation(generation, context)) return;
  const missionGitProcess = new NodeGitPort({
    executable:
      preflight.git.executable ??
      (process.platform === 'win32' ? 'git.exe' : 'git'),
    hooksPath: canonicalEmptyHooksPath,
  });
  const createdWorktreeManager = new WorktreeLeaseManager({
    git: missionGitProcess,
    store: worktreeLeaseStore,
    workspace: {
      id: workspace.id,
      canonicalPath: workspace.canonicalPath,
      trusted: workspace.trusted,
    },
    worktreeRoot: canonicalMissionWorktreeRoot,
  });
  missionWorktrees = createdWorktreeManager;
  try {
    const leaseState = await worktreeLeaseStore.reload();
    if (leaseState.problem !== undefined) {
      throw new Error(leaseState.problem.message);
    }
    const recoverableLeases = Object.values(leaseState.data.leases)
      .filter(
        (lease) =>
          lease.workspaceId === workspace.id && lease.state !== 'removed',
      )
      .sort((left, right) => left.leaseId.localeCompare(right.leaseId));
    for (const lease of recoverableLeases) {
      const reconciled = await createdWorktreeManager.reconcile(lease.leaseId);
      if (
        reconciled.state === 'blocked' ||
        reconciled.state === 'provisioning' ||
        reconciled.state === 'cleanup-pending'
      ) {
        startupMessages.push(
          `Mission worktree lease ${reconciled.leaseId} requires explicit recovery (${reconciled.state}).`,
        );
      }
    }
  } catch {
    startupMessages.push(
      'Council could not reconcile every saved Mission worktree lease. Existing worktrees were preserved and affected actions remain blocked.',
    );
  }
  const missionWorktreeAdapter = new MissionWorktreeAdapter({
    git: missionGitProcess,
    manager: createdWorktreeManager,
    store: worktreeLeaseStore,
    workspace: {
      id: workspace.id,
      canonicalPath: workspace.canonicalPath,
      trusted: workspace.trusted,
    },
    worktreeRoot: canonicalMissionWorktreeRoot,
  });
  const missionGitAdapter = new MissionGitAdapter({
    git: missionGitProcess,
    leases: createdWorktreeManager,
    workspace: {
      id: workspace.id,
      canonicalPath: workspace.canonicalPath,
      trusted: workspace.trusted,
    },
  });
  const nodeExecutable = preflight.node.executable ?? process.execPath;
  const gateRunner = new GateRunner({
    git: missionGitProcess,
    store: worktreeLeaseStore,
    workspace: {
      id: workspace.id,
      canonicalPath: workspace.canonicalPath,
      trusted: workspace.trusted,
    },
    gateWorktreeRoot: canonicalGateWorktreeRoot,
    safeEnv: {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'test',
    },
    policy: {
      commands: [
        {
          id: 'project-tests',
          executable: nodeExecutable,
          argv: [
            path.join(
              workspace.canonicalPath,
              'node_modules',
              'vitest',
              'vitest.mjs',
            ),
            'run',
          ],
        },
        {
          id: 'project-typecheck',
          executable: nodeExecutable,
          argv: [
            path.join(
              workspace.canonicalPath,
              'node_modules',
              'typescript',
              'bin',
              'tsc',
            ),
            '-p',
            'tsconfig.json',
            '--noEmit',
          ],
        },
      ],
      testCommandIds: ['project-tests'],
      reviewCommandIds: ['project-typecheck'],
    },
  });
  try {
    await gateRunner.reconcile();
  } catch (error) {
    startupMessages.push(
      `Detached gate recovery needs attention: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    const leaseState = await worktreeLeaseStore.reload();
    if (leaseState.problem !== undefined) {
      throw new Error(leaseState.problem.message);
    }
    const knownPaths = [
      ...Object.values(leaseState.data.leases)
        .filter((lease) => lease.workspaceId === workspace.id)
        .map((lease) => lease.checkoutPath),
      ...Object.values(leaseState.data.gateRuns)
        .filter((run) => run.workspaceId === workspace.id)
        .map((run) => run.checkoutPath),
    ];
    const repository = await missionGitProcess.inspectRepository(
      workspace.canonicalPath,
    );
    const registered = await missionGitProcess.listWorktrees(
      repository.repositoryRoot,
    );
    for (const entry of registered) {
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(entry.path);
      } catch {
        continue;
      }
      if (
        !isInsideCanonicalRoot(
          canonicalMissionWorktreeRoot,
          canonicalPath,
        ) &&
        !isInsideCanonicalRoot(canonicalGateWorktreeRoot, canonicalPath)
      ) {
        continue;
      }
      if (
        knownPaths.some((knownPath) =>
          sameCanonicalPath(knownPath, canonicalPath),
        )
      ) {
        continue;
      }
      const orphanId = createHash('sha256')
        .update(canonicalPath)
        .digest('hex')
        .slice(0, 16);
      startupMessages.push(
        `Orphaned Council worktree ${orphanId} is registered without a valid lease. It was preserved and not adopted.`,
      );
    }
  } catch {
    startupMessages.push(
      'Council could not complete the read-only orphan worktree scan. No worktree was adopted or deleted.',
    );
  }

  const initialSnapshot = catalogOnlySnapshot(profiles, catalog, preflight);
  currentState = {
    workspace: readyWorkspaceState(workspace, isDevelopmentOverride),
    projectDir: workspace.canonicalPath,
    preflight: toUiPreflight(preflight),
    capabilities: UNAVAILABLE_CAPABILITIES,
    rosterProblems: savedRoster.problems,
    startupMessages,
    catalog,
    bindingProblem: bindingStore.problem,
    issues: [],
    snapshot:
      initialProfileProblem === undefined
        ? initialSnapshot
        : { ...initialSnapshot, definitionError: initialProfileProblem },
  };
  publishState();

  if (preflight.claude !== null && preflight.claude.meetsMinimum) {
    const client = ClaudeClient.fromBinary(preflight.claude.bin);
    claudeRuntimeClient = client;
    const provider = new ClaudeProviderAdapter(client, {
      ptyAvailable: preflight.ptyAvailable,
    });
    const created = new ClaudeCodeAgentSupervisor({
      provider,
      paths: claudePaths,
      config: profiles.config,
      bindings: bindingStore,
      workspace: {
        id: workspace.id,
        canonicalPath: workspace.canonicalPath,
        trusted: workspace.trusted,
      },
      catalog,
      resolveCatalog,
      validations: profiles.validations,
      catalogProblems: profiles.catalogProblems,
      councilProfileId: profiles.councilProfileId,
      authorizeMissionLaunchCwd: (profileId, canonicalCwd) =>
        missionWorktreeAdapter.authorizesLaunch(profileId, canonicalCwd),
      onSnapshot: (snapshot) => {
        if (isActivationCurrent(generation, context)) publishSnapshot(snapshot);
      },
      onNeedsInput: (delivery) => {
        if (!isActivationCurrent(generation, context)) return;
        if (!Notification.isSupported()) return;
        const message = 'message' in delivery.payload ? delivery.payload.message : undefined;
        new Notification({
          title: `${APP_NAME} needs you`,
          body: message ?? 'An agent is waiting for input.',
        }).show();
      },
      onError: (error) => {
        if (!isActivationCurrent(generation, context) || currentState === undefined) return;
        currentState = {
          ...currentState,
          startupMessages: [...currentState.startupMessages, error.message],
        };
        publishState();
      },
    });
    supervisor = created;
    claudeSupervisor = created;

    try {
      const report = await created.boot();
      if (await abandonActivation(generation, context)) return;
      publishSnapshot(report.snapshot);
      await created.start();
      if (await abandonActivation(generation, context)) return;
      supervisorActionsReady = true;
      publishSnapshot(created.current ?? report.snapshot);
    } catch (error) {
      if (await abandonActivation(generation, context)) return;
      const message = error instanceof Error ? error.message : String(error);
      startupMessages.push(`Runtime startup failed: ${message}`);
      supervisorActionsReady = false;
      await created.stop().catch(() => undefined);
      if (supervisor === created) supervisor = undefined;
      if (claudeSupervisor === created) claudeSupervisor = undefined;
      currentState = { ...currentState!, startupMessages: [...startupMessages] };
      publishState();
    }
  } else {
    if (await abandonActivation(generation, context)) return;
    startupMessages.push(
      preflight.claude === null
        ? 'Claude CLI was not found. Catalog remains visible; runtime actions are disabled.'
        : `Claude Code ${preflight.claude.version ?? '(unknown)'} is below the supported minimum.`,
    );
    currentState = { ...currentState!, startupMessages: [...startupMessages] };
    publishState();
  }

  if (await abandonActivation(generation, context)) return;
  const resolveMissionAssignment = async (request: {
    readonly missionId: string;
    readonly taskId: string;
    readonly profileId: string;
    readonly expectedDefinitionFingerprint: string;
  }) => {
    const member = profiles.config.members.find(
      (candidate) => candidate.key === request.profileId,
    );
    if (
      member === undefined ||
      member.workspaceId !== workspace.id ||
      member.catalogId === undefined
    ) {
      throw new Error(
        'The selected opaque profile is no longer authorized for this workspace.',
      );
    }
    const freshCatalog = await resolveCatalog();
    const entry = freshCatalog.entries.find(
      (candidate) => candidate.catalogId === member.catalogId,
    );
    if (
      entry === undefined ||
      entry.definitionPath === undefined ||
      entry.fingerprint === undefined
    ) {
      throw new Error(
        entry?.launchability.message ??
          'The selected role definition is missing or ambiguous.',
      );
    }
    const bytes = await readFile(entry.definitionPath);
    const fingerprint = fingerprintAgentDefinition(bytes);
    if (
      fingerprint !== entry.fingerprint ||
      fingerprint !== request.expectedDefinitionFingerprint ||
      member.definitionFingerprint !== request.expectedDefinitionFingerprint
    ) {
      throw new Error(
        'The role definition changed after it was displayed. Review a fresh Mission preview.',
      );
    }
    const roleInstructions = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
    return {
      profileId: member.key,
      definitionFingerprint: fingerprint,
      roleInstructions,
      taskPrompt:
        member.bootPrompt ??
        `Act as ${member.label}. Complete only the assigned Mission task and report exact evidence.`,
      ...(member.model ?? entry.metadata?.model) === undefined
        ? {}
        : { model: member.model ?? entry.metadata?.model },
      launchable: entry.launchability.launchable,
      ...(entry.launchability.message === undefined
        ? {}
        : { diagnostic: entry.launchability.message }),
    };
  };
  const missionProviderRouter = new MissionProviderRouter({
    workspace: {
      id: workspace.id,
      canonicalPath: workspace.canonicalPath,
      trusted: workspace.trusted,
    },
    resolveAssignment: resolveMissionAssignment,
    claude:
      claudeSupervisor === undefined
        ? undefined
        : {
            launcher: claudeSupervisor,
            bindings: bindingStore,
            available: () =>
              supervisorActionsReady && claudeSupervisor !== undefined,
            diagnostic: () =>
              supervisorActionsReady
                ? undefined
                : 'Claude Code Mission starts are unavailable until its runtime is ready.',
          },
    codex:
      codexMissionProvider === undefined
        ? undefined
        : {
            adapter: codexMissionProvider,
            bindings: codexThreadBindings,
          },
  });
  const missionCoordinator = new MissionCoordinator({
    store: missionLedgerStore,
    provider: missionProviderRouter,
    git: missionGitAdapter,
    worktrees: missionWorktreeAdapter,
  });
  try {
    let recoveryState = await missionLedgerStore.reload();
    if (recoveryState.problem !== undefined) {
      throw new Error(recoveryState.problem.message);
    }
    const approved = Object.values(recoveryState.data.approvals)
      .filter(
        (approval) =>
          approval.workspaceId === workspace.id &&
          approval.status === 'approved',
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const approval of approved) {
      try {
        await missionCoordinator.resumeApprovedIntegration(
          approval.id,
          recoveryState.data.revision,
        );
        startupMessages.push(
          `Recovered approved Mission integration ${approval.id} to its exact reviewed commit.`,
        );
        recoveryState = await missionLedgerStore.reload();
        if (recoveryState.problem !== undefined) {
          throw new Error(recoveryState.problem.message);
        }
      } catch {
        startupMessages.push(
          `Approved Mission integration ${approval.id} still requires recovery; no unreviewed target was accepted.`,
        );
        recoveryState = await missionLedgerStore.reload();
        if (recoveryState.problem !== undefined) break;
      }
    }
  } catch {
    startupMessages.push(
      'Council could not reconcile approved Mission integrations. Their durable approvals were preserved without accepting repository drift.',
    );
  }
  const createdMissionController = new PrivilegedMissionUiController({
    store: missionLedgerStore,
    coordinator: missionCoordinator,
    providers: missionProviderRouter,
    gateRunner,
    workspaceId: workspace.id,
    publish: (state) => {
      if (isActivationCurrent(generation, context)) {
        publishMissionState(state);
      }
    },
  });
  missionUiController = createdMissionController;
  if (currentState !== undefined) {
    currentState = {
      ...currentState,
      startupMessages: [...startupMessages],
    };
    publishState();
  }
  publishMissionState(await createdMissionController.getState());

  if (await abandonActivation(generation, context)) return;
  definitionWatcher = new AgentDefinitionWatcher(catalog.roots.map((root) => root.path));
  definitionWatcher.onError((error) => {
    if (!isActivationCurrent(generation, context) || currentState === undefined) return;
    markRuntimeStale('catalog', `Agent-definition watcher failed: ${error.message}`);
  });
  const reloadCatalog = (): void => {
    catalogRefresh = catalogRefresh.then(async () => {
      if (!isActivationCurrent(generation, context) || savedRoster === undefined) return;
      const refreshedCatalog = await resolveCatalog();
      if (!isActivationCurrent(generation, context) || savedRoster === undefined) return;
      const refreshedProfiles: ResolvedProfiles = resolveProfiles(
        savedRoster.config,
        refreshedCatalog,
        durableBindings(),
        pendingLaunches(),
      );
      catalog = refreshedCatalog;
      profiles = refreshedProfiles;
      controllerProblems.delete('catalog');
      if (claudeSupervisor !== undefined) {
        await claudeSupervisor.updateCatalog(
          refreshedProfiles.config,
          refreshedCatalog,
          refreshedProfiles.validations,
          refreshedProfiles.catalogProblems,
          refreshedProfiles.councilProfileId,
        );
        if (!isActivationCurrent(generation, context)) return;
      }
      if (currentState !== undefined) {
        const nextSnapshot =
          claudeSupervisor?.current ??
          catalogOnlySnapshot(refreshedProfiles, refreshedCatalog, preflight);
        currentState = {
          ...currentState,
          catalog: refreshedCatalog,
        };
        publishSnapshot(nextSnapshot);
      }
    }).catch((error) => {
      if (!isActivationCurrent(generation, context) || currentState === undefined) return;
      markRuntimeStale(
        'catalog',
        `Catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  definitionWatcher.onChange(reloadCatalog);
  await definitionWatcher.start();
  if (await abandonActivation(generation, context)) return;
  // Close the scan→watch readiness window. A change that became Chokidar's
  // initial baseline is still captured by this authoritative post-ready scan.
  reloadCatalog();
  await catalogRefresh;
  if (await abandonActivation(generation, context)) return;

  const activeProfileStore = profileStore;
  profileWatcher = watch(rosterFile, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  const reloadProfiles = (): void => {
    catalogRefresh = catalogRefresh.then(async () => {
      if (!isActivationCurrent(generation, context) || activeProfileStore === undefined) return;
      const loaded = await activeProfileStore.reload();
      if (!isActivationCurrent(generation, context)) return;
      const problem = profileLoadProblem(loaded);
      if (problem !== undefined) {
        savedRoster = loaded;
        if (currentState !== undefined) {
          currentState = {
            ...currentState,
            rosterProblems: loaded.problems,
          };
        }
        markRuntimeStale(
          'profile',
          problem,
        );
        return;
      }
      savedRoster = loaded;
      controllerProblems.delete('profile');
      profiles = resolveProfiles(
        loaded.config,
        catalog,
        durableBindings(),
        pendingLaunches(),
      );
      if (claudeSupervisor !== undefined) {
        await claudeSupervisor.updateCatalog(
          profiles.config,
          catalog,
          profiles.validations,
          profiles.catalogProblems,
          profiles.councilProfileId,
        );
        if (!isActivationCurrent(generation, context)) return;
      }
      if (currentState !== undefined) {
        const nextSnapshot =
          claudeSupervisor?.current ??
          catalogOnlySnapshot(profiles, catalog, preflight);
        currentState = {
          ...currentState,
          rosterProblems: loaded.problems,
        };
        publishSnapshot(nextSnapshot);
      }
    }).catch((error) => {
      if (!isActivationCurrent(generation, context) || currentState === undefined) return;
      markRuntimeStale(
        'profile',
        `Profile preference reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  profileWatcher.on('add', reloadProfiles);
  profileWatcher.on('change', reloadProfiles);
  profileWatcher.on('unlink', reloadProfiles);
  profileWatcher.on('error', (error) => {
    if (!isActivationCurrent(generation, context) || currentState === undefined) return;
    markRuntimeStale(
      'profile',
      `Profile preference watcher failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  // Close the load→watch readiness window. An edit that became Chokidar's
  // initial baseline is applied by this post-ready authoritative reload.
  profileWatcher.once('ready', () => {
    if (isActivationCurrent(generation, context)) reloadProfiles();
  });

  if (await abandonActivation(generation, context)) return;
  bindingWatcher = watch(bindingStore.file, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  const reloadBindings = (): void => {
    catalogRefresh = catalogRefresh.then(async () => {
      if (!isActivationCurrent(generation, context) || savedRoster === undefined) return;
      await bindingStore.reload();
      if (!isActivationCurrent(generation, context)) return;
      if (bindingStore.problem !== undefined) {
        markRuntimeStale(
          'binding',
          `Session binding edit was not applied or overwritten: ${bindingStore.problem.message}`,
        );
        return;
      }
      controllerProblems.delete('binding');
      profiles = resolveProfiles(
        savedRoster.config,
        catalog,
        durableBindings(),
        pendingLaunches(),
      );
      if (claudeSupervisor !== undefined) {
        await claudeSupervisor.updateCatalog(
          profiles.config,
          catalog,
          profiles.validations,
          profiles.catalogProblems,
          profiles.councilProfileId,
        );
        if (!isActivationCurrent(generation, context)) return;
      }
      const nextSnapshot =
        claudeSupervisor?.current ??
        catalogOnlySnapshot(profiles, catalog, preflight);
      if (currentState !== undefined) {
        currentState = {
          ...currentState,
          bindingProblem: undefined,
        };
        publishSnapshot(nextSnapshot);
      }
    }).catch((error) => {
      if (!isActivationCurrent(generation, context) || currentState === undefined) return;
      markRuntimeStale(
        'binding',
        `Session binding reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  bindingWatcher.on('add', reloadBindings);
  bindingWatcher.on('change', reloadBindings);
  bindingWatcher.on('unlink', reloadBindings);
  bindingWatcher.on('error', (error) => {
    if (!isActivationCurrent(generation, context) || currentState === undefined) return;
    markRuntimeStale(
      'binding',
      `Session binding watcher failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  // As with profiles, converge once after watch readiness so no binding edit
  // can disappear into Chokidar's initial baseline.
  bindingWatcher.once('ready', () => {
    if (isActivationCurrent(generation, context)) reloadBindings();
  });
  await abandonActivation(generation, context);
}

async function initializeApp(context: SerializedLifecycleContext): Promise<void> {
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  const updater = app.isPackaged
    ? (electronUpdater.autoUpdater as unknown as AppUpdaterPort)
    : undefined;
  appUpdateController = new AppUpdateController({
    updater,
    currentVersion: app.getVersion(),
    enabled: app.isPackaged && process.platform === 'win32',
    onState: publishUpdateState,
  });

  const userData = app.getPath('userData');
  appConfigStore = new AppConfigStore(userData);
  bindingStore = new SessionBindingStore(path.join(userData, 'session-bindings.json'));
  codexThreadBindings = new CodexThreadBindingStore(userData);
  missionLedgerStore = new MissionLedgerStore(
    path.join(userData, 'mission-ledger.json'),
  );
  worktreeLeaseStore = new WorktreeLeaseStore(
    path.join(userData, 'worktree-leases.json'),
  );
  claudePaths = new ClaudePaths();
  const [appConfigLoad] = await Promise.all([
    appConfigStore.load(),
    bindingStore.load(),
    codexThreadBindings.load(),
    missionLedgerStore.load(),
    worktreeLeaseStore.load(),
  ]);
  if (context.isShuttingDown) return;
  const startupMessages: string[] = [];
  if (appConfigLoad.diagnostic !== undefined) {
    startupMessages.push(
      `Application configuration was not overwritten: ${appConfigLoad.diagnostic.message}`,
    );
  }
  if (bindingStore.problem !== undefined) {
    startupMessages.push(
      `Session bindings were not overwritten: ${bindingStore.problem.message}`,
    );
  }
  if (codexThreadBindings.state.problem !== undefined) {
    startupMessages.push(
      `Codex thread bindings were not overwritten: ${codexThreadBindings.state.problem.message}`,
    );
  }
  if (missionLedgerStore.problem !== undefined) {
    startupMessages.push(
      `Mission ledger was not overwritten: ${missionLedgerStore.problem.message}`,
    );
  }
  if (worktreeLeaseStore.problem !== undefined) {
    startupMessages.push(
      `Worktree leases were not overwritten: ${worktreeLeaseStore.problem.message}`,
    );
  }

  const locatedCodex = await locateCodex({
    override: process.env['DECAGRAM_COUNCIL_CODEX_BIN'],
    resourcesPath: process.resourcesPath,
  });
  if (context.isShuttingDown) return;
  if (locatedCodex === null) {
    startupMessages.push(
      'Codex App Server was not found. Claude-only Missions remain available.',
    );
  } else {
    codexClient = new CodexAppServerClient({
      executable: locatedCodex.executable,
      clientVersion: app.getVersion(),
    });
    codexMissionProvider = new CodexMissionProviderAdapter({
      client: codexClient,
      bindings: codexThreadBindings,
    });
    const codexStatus = await codexMissionProvider.connect();
    if (context.isShuttingDown) return;
    if (!codexStatus.available || !codexStatus.authenticated) {
      startupMessages.push(
        codexStatus.diagnostic ??
          'Codex App Server is unavailable or requires provider-owned sign-in.',
      );
    }
  }

  currentState = initialState(
    setupWorkspaceState(appConfigLoad.diagnostic?.message, appConfigLoad.activeWorkspace),
    startupMessages,
  );
  registerIpc();
  mainWindow = createWindow();
  singleInstance.notifyWindowReady();
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  applicationConfigWatcher = watch(appConfigStore.file, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  const reloadApplicationConfig = (): void => {
    if (currentState?.workspace.developmentOverride === true) return;
    void applicationLifecycle.enqueue(async (context) => {
      const loaded = await appConfigStore.reload();
      if (
        context.isShuttingDown ||
        !context.isLatest ||
        currentState === undefined
      ) {
        return;
      }
      if (loaded.diagnostic !== undefined) {
        currentState = {
          ...currentState,
          startupMessages: [
            ...currentState.startupMessages,
            `Application configuration edit was not applied or overwritten: ${loaded.diagnostic.message}`,
          ],
        };
        publishState();
        return;
      }

      const target = loaded.activeWorkspace;
      if (target === undefined || !target.trusted) {
        const generation = ++activationGeneration;
        await disposeActiveRuntime();
        if (!isActivationCurrent(generation, context)) return;
        currentState = initialState(
          setupWorkspaceState(
            target === undefined ? undefined : 'This workspace has not been trusted.',
            target,
          ),
          [],
        );
        publishState();
        return;
      }

      const signature = configurationSignature(
        target,
        loaded.config.includeUserDefinitions,
      );
      if (signature === activeConfigurationSignature) return;

      try {
        const validated = await validateWorkspaceDirectory(target.selectedPath);
        if (context.isShuttingDown || !context.isLatest) return;
        if (!sameCanonicalPath(validated.canonicalPath, target.canonicalPath)) {
          throw new Error(
            'The saved workspace now resolves to a different location and must be selected and trusted again.',
          );
        }
      } catch (error) {
        if (context.isShuttingDown || !context.isLatest) return;
        const generation = ++activationGeneration;
        await disposeActiveRuntime();
        if (!isActivationCurrent(generation, context)) return;
        const message = error instanceof Error ? error.message : String(error);
        currentState = initialState(setupWorkspaceState(message, target), [message]);
        publishState();
        return;
      }

      if (context.isShuttingDown || !context.isLatest) return;
      const generation = ++activationGeneration;
      await activateWorkspace(target, false, generation, context);
    }).catch((error) => {
      if (
        shutdownStarted ||
        applicationLifecycle.isShuttingDown ||
        currentState === undefined
      ) {
        return;
      }
      currentState = {
        ...currentState,
        startupMessages: [
          ...currentState.startupMessages,
          `Application configuration reload failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
      publishState();
    });
  };
  applicationConfigWatcher.on('add', reloadApplicationConfig);
  applicationConfigWatcher.on('change', reloadApplicationConfig);
  applicationConfigWatcher.on('unlink', reloadApplicationConfig);
  applicationConfigWatcher.on('error', (error) => {
    if (
      shutdownStarted ||
      applicationLifecycle.isShuttingDown ||
      currentState === undefined
    ) {
      return;
    }
    currentState = {
      ...currentState,
      startupMessages: [
        ...currentState.startupMessages,
        `Application configuration watcher failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
    publishState();
  });
  let initialConfigurationSettled = false;
  let configurationWatcherReady = false;
  let configurationConverged = false;
  const convergeConfigurationAfterReady = (): void => {
    if (
      !initialConfigurationSettled ||
      !configurationWatcherReady ||
      configurationConverged ||
      currentState?.workspace.developmentOverride === true
    ) {
      return;
    }
    configurationConverged = true;
    reloadApplicationConfig();
  };
  applicationConfigWatcher.once('ready', () => {
    configurationWatcherReady = true;
    convergeConfigurationAfterReady();
  });

  try {
    const override = await developmentOverride();
    if (context.isShuttingDown) return;
    if (override !== undefined) {
      startupMessages.push(
        `Using visible development workspace override: ${override.canonicalPath}`,
      );
      if (!(await confirmWorkspaceTrustPrompt(override))) {
        if (context.isShuttingDown) return;
        currentState = initialState(
          setupWorkspaceState(
            'Development workspace trust was not granted.',
            override,
            true,
          ),
          startupMessages,
        );
        publishState();
        return;
      }
      if (context.isShuttingDown) return;
      const generation = ++activationGeneration;
      await activateWorkspace(
        { ...override, trusted: true },
        true,
        generation,
        context,
      );
      return;
    }

    const saved = appConfigLoad.activeWorkspace;
    if (saved === undefined) {
      publishState();
      return;
    }
    if (!saved.trusted) {
      currentState = initialState(
        setupWorkspaceState('This saved workspace has not been trusted.', saved),
        startupMessages,
      );
      publishState();
      return;
    }
    const validated = await appConfigStore.revalidateActiveWorkspace();
    if (context.isShuttingDown) return;
    const generation = ++activationGeneration;
    await activateWorkspace(validated, false, generation, context);
  } catch (error) {
    if (context.isShuttingDown) return;
    const message = error instanceof Error ? error.message : String(error);
    currentState = initialState(
      setupWorkspaceState(message, appConfigLoad.activeWorkspace),
      [...startupMessages, message],
    );
    publishState();
  } finally {
    // Re-read once after both initial activation and watch readiness. This
    // closes the load→watch baseline window without racing the normal saved
    // workspace activation or overriding an explicit development workspace.
    initialConfigurationSettled = true;
    convergeConfigurationAfterReady();
  }
}

const singleInstance = acquireSingleInstance(
  {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    quit: () => app.quit(),
    on: (_event, listener) => {
      app.on('second-instance', (event, argv, workingDirectory, additionalData) =>
        listener(event, argv, workingDirectory, additionalData),
      );
    },
  },
  () => mainWindow,
);

const allowUnsupportedDevelopment =
  !app.isPackaged && process.env['DECAGRAM_COUNCIL_ALLOW_NON_WINDOWS_DEV'] === '1';

if (singleInstance.primary) {
  if (process.platform !== 'win32' && !allowUnsupportedDevelopment) {
    void app.whenReady().then(() => {
      dialog.showErrorBox(
        `${APP_NAME} is Windows only`,
        'This build supports Windows 10 and Windows 11 only.',
      );
      app.quit();
    });
  } else {
    void app.whenReady().then(async () => {
      try {
        await applicationLifecycle.enqueue((context) => initializeApp(context));
      } catch (error) {
        if (shutdownStarted || applicationLifecycle.isShuttingDown) return;
        dialog.showErrorBox(
          `${APP_NAME} could not start`,
          error instanceof Error ? error.message : String(error),
        );
        app.quit();
      }
    });
  }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  activationGeneration += 1;
  void applicationLifecycle
    .shutdown(async () => {
      const configWatcher = applicationConfigWatcher;
      applicationConfigWatcher = undefined;
      const failures: unknown[] = [];
      const results = await Promise.allSettled([
        configWatcher?.close() ?? Promise.resolve(),
        disposeActiveRuntime(),
        codexMissionProvider?.shutdown() ??
          codexClient?.stop() ??
          Promise.resolve(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Council shutdown cleanup was incomplete.');
      }
    })
    .catch((error) => {
      console.error(error);
    })
    .finally(() => {
      if (updateInstallRequested) {
        try {
          appUpdateController.quitAndInstall();
          return;
        } catch (error) {
          console.error(error);
        }
      }
      app.quit();
    });
});
