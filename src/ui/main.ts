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
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliResult } from '../integration/types.js';
import { ClaudeClient } from '../integration/client.js';
import { listAgentDefinitions } from '../integration/fs/agentDefs.js';
import { ClaudePaths } from '../integration/paths.js';
import { runLaunchPreflight, type LaunchPreflight } from '../integration/preflight.js';
import { loadRosterConfig, mergeDiscoveredAgents } from '../integration/roster/config.js';
import type { Snapshot } from '../integration/runtime.js';
import {
  ClaudeCodeAgentSupervisor,
  type AgentRuntimeCapabilities,
  type AgentSupervisorPort,
} from '../supervisor/index.js';
import {
  IPC_CHANNELS,
  type UiFailure,
  type UiResult,
  type UiState,
} from './ipc.js';

const APP_ID = 'com.PLACEHOLDER.decagram-council';
const APP_NAME = 'Decagram Council';
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sourceUiDir = path.resolve(currentDir, '../../../src/ui');

app.setName(APP_NAME);

let mainWindow: BrowserWindow | undefined;
let supervisor: AgentSupervisorPort | undefined;
let currentState: UiState | undefined;
let shutdownStarted = false;

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

function toUiResult<T>(result: CliResult<T>): UiResult<T> {
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, message: result.message, details: result.raw };
}

function publishSnapshot(snapshot: Snapshot): void {
  if (currentState !== undefined) currentState = { ...currentState, snapshot };
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.snapshot, snapshot);
  }
}

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  return mainWindow !== undefined && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
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

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.getState, (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Untrusted IPC sender');
    if (currentState === undefined) throw new Error('Application startup is not complete');
    return currentState;
  });

  ipcMain.handle(IPC_CHANNELS.startMember, async (event, key: unknown) => {
    if (!isTrustedIpcSender(event)) return unavailable('Untrusted IPC sender.');
    if (supervisor === undefined || currentState?.snapshot === undefined) {
      return unavailable('Claude integration is unavailable. Review Diagnostics.');
    }
    if (typeof key !== 'string') return unavailable('Invalid specialist key.');
    return toUiResult(await supervisor.startMember(key));
  });

  ipcMain.handle(IPC_CHANNELS.stopSession, async (event, id: unknown) => {
    if (!isTrustedIpcSender(event)) return unavailable('Untrusted IPC sender.');
    if (supervisor === undefined) return unavailable('Claude CLI is unavailable. Review Diagnostics.');
    if (typeof id !== 'string' || id.trim() === '') return unavailable('Invalid session id.');
    return toUiResult(await supervisor.stopSession(id));
  });

  ipcMain.handle(IPC_CHANNELS.wakeSquad, async (event) => {
    if (!isTrustedIpcSender(event)) return unavailable('Untrusted IPC sender.');
    if (supervisor === undefined) return unavailable('Claude integration is unavailable. Review Diagnostics.');
    return toUiResult(await supervisor.wakeSquad());
  });

  ipcMain.handle(IPC_CHANNELS.logs, async (event, id: unknown) => {
    if (!isTrustedIpcSender(event)) return unavailable('Untrusted IPC sender.');
    if (supervisor === undefined) return unavailable('Claude CLI is unavailable. Review Diagnostics.');
    if (typeof id !== 'string' || id.trim() === '') return unavailable('Invalid session id.');
    return toUiResult(await supervisor.logs(id));
  });

  ipcMain.handle(IPC_CHANNELS.reply, async (event, id: unknown, message: unknown) => {
    if (!isTrustedIpcSender(event)) return unavailable('Untrusted IPC sender.');
    if (supervisor === undefined) return unavailable('Claude CLI is unavailable. Review Diagnostics.');
    if (!supervisor.capabilities.plainTextReply) {
      return unavailable('Reply is disabled because the optional node-pty bridge is unavailable.');
    }
    if (typeof id !== 'string' || id.trim() === '') return unavailable('Invalid session id.');
    if (typeof message !== 'string' || message.trim() === '') return unavailable('Reply cannot be empty.');
    if (message.length > 8_000) return unavailable('Reply must be 8,000 characters or fewer.');
    if (/[\u0000-\u001f\u007f]/.test(message)) {
      return unavailable('Reply must be one line of plain text without control characters.');
    }
    return toUiResult(await supervisor.reply(id, message));
  });

  ipcMain.handle(
    IPC_CHANNELS.council,
    async (event, question: unknown) => {
      if (!isTrustedIpcSender(event)) return unavailable('Untrusted IPC sender.');
      if (supervisor === undefined) return unavailable('Claude integration is unavailable. Review Diagnostics.');
      if (typeof question !== 'string' || question.trim() === '') {
        return unavailable('Council question cannot be empty.');
      }
      const projectDir = currentState?.projectDir;
      if (projectDir === undefined) return unavailable('Project path is unavailable.');
      return toUiResult(await supervisor.startCouncilReview(question, projectDir));
    },
  );
}

async function initializeApp(): Promise<void> {
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  const projectDir = path.resolve(process.env['DECAGRAM_COUNCIL_PROJECT_DIR'] ?? process.cwd());
  const startupMessages: string[] = [];
  let preflight: LaunchPreflight;

  try {
    preflight = await runLaunchPreflight(projectDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startupMessages.push(`Preflight failed unexpectedly: ${message}`);
    throw error;
  }

  const claudePaths = new ClaudePaths();
  const definitions = await listAgentDefinitions(claudePaths, projectDir);
  const rosterFile = path.join(app.getPath('userData'), 'roster.json');
  const roster = await loadRosterConfig(rosterFile, projectDir);
  const mergedRoster = mergeDiscoveredAgents(roster.config, definitions, projectDir);
  if (roster.createdDefault) startupMessages.push(`Created roster config at ${rosterFile}`);
  if (mergedRoster.discoveredAgents.length > 0) {
    startupMessages.push(
      `Discovered ${mergedRoster.discoveredAgents.length} launchable agent definition${mergedRoster.discoveredAgents.length === 1 ? '' : 's'} for this project.`,
    );
  }
  if (mergedRoster.ignoredLegacyPlaceholders) {
    startupMessages.push(
      'Ignored the obsolete Arden/Bram/Rook/Tess/Sage placeholder roster; using discovered agent definitions.',
    );
  }

  let capabilities = UNAVAILABLE_CAPABILITIES;
  if (preflight.claude !== null && preflight.claude.meetsMinimum) {
    const client = ClaudeClient.fromBinary(preflight.claude.bin);
    supervisor = new ClaudeCodeAgentSupervisor({
      client,
      paths: claudePaths,
      config: mergedRoster.config,
      ptyAvailable: preflight.ptyAvailable,
      onSnapshot: publishSnapshot,
      onNeedsInput: (delivery) => {
        if (!Notification.isSupported()) return;
        const message = 'message' in delivery.payload ? delivery.payload.message : undefined;
        new Notification({
          title: `${APP_NAME} needs you`,
          body: message ?? 'An agent is waiting for input.',
        }).show();
      },
      onError: (error) => {
        startupMessages.push(error.message);
        if (currentState !== undefined) {
          currentState = { ...currentState, startupMessages: [...startupMessages] };
        }
      },
    });
    capabilities = supervisor.capabilities;
  }

  currentState = {
    projectDir,
    preflight,
    capabilities,
    rosterProblems: roster.problems,
    startupMessages,
    snapshot: undefined,
  };

  registerIpc();
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  if (preflight.claude === null) {
    startupMessages.push('Claude CLI was not found. Session controls are disabled.');
    currentState = { ...currentState, startupMessages: [...startupMessages] };
    return;
  }
  if (!preflight.claude.meetsMinimum) {
    startupMessages.push(
      `Claude Code ${preflight.claude.version ?? '(unknown)'} is below the supported minimum. Session controls are disabled.`,
    );
    currentState = { ...currentState, startupMessages: [...startupMessages] };
    return;
  }

  try {
    if (supervisor === undefined) return;
    const report = await supervisor.boot();
    publishSnapshot(report.snapshot);
    if (report.invalidAgents.length > 0) {
      startupMessages.push(
        `Missing agent definitions: ${report.invalidAgents.map((entry) => entry.agent).join(', ')}`,
      );
    }
    currentState = { ...currentState, startupMessages: [...startupMessages] };
    await supervisor.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startupMessages.push(`Runtime startup failed: ${message}`);
    currentState = { ...currentState, startupMessages: [...startupMessages] };
  }
}

const allowUnsupportedDevelopment =
  !app.isPackaged && process.env['DECAGRAM_COUNCIL_ALLOW_NON_WINDOWS_DEV'] !== '0';

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
      await initializeApp();
    } catch (error) {
      dialog.showErrorBox(
        `${APP_NAME} could not start`,
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    }
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (supervisor === undefined || shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void supervisor.stop().finally(() => app.quit());
});
