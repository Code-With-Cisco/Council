import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliResult } from '../integration/types.js';
import { ClaudeClient } from '../integration/client.js';
import { ClaudePaths } from '../integration/paths.js';
import { runLaunchPreflight, type LaunchPreflight } from '../integration/preflight.js';
import { sendReply } from '../integration/pty/attach.js';
import { loadRosterConfig } from '../integration/roster/config.js';
import { DecagramCouncilRuntime, type Snapshot } from '../integration/runtime.js';
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
let runtime: DecagramCouncilRuntime | undefined;
let client: ClaudeClient | undefined;
let currentState: UiState | undefined;
let shutdownStarted = false;

function unavailable(message: string): UiFailure {
  return { ok: false, message };
}

function toUiResult<T>(result: CliResult<T>): UiResult<T> {
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, message: result.message, details: result.raw };
}

function isKnownActionableSession(id: string): boolean {
  return currentState?.snapshot?.roster.sessions.some((session) => session.id === id) === true;
}

function publishSnapshot(snapshot: Snapshot): void {
  if (currentState !== undefined) currentState = { ...currentState, snapshot };
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.snapshot, snapshot);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    frame: true,
    backgroundColor: '#0b1020',
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
  ipcMain.handle(IPC_CHANNELS.getState, () => {
    if (currentState === undefined) throw new Error('Application startup is not complete');
    return currentState;
  });

  ipcMain.handle(IPC_CHANNELS.startMember, async (_event, key: unknown) => {
    if (runtime === undefined || currentState?.snapshot === undefined) {
      return unavailable('Claude integration is unavailable. Review Diagnostics.');
    }
    if (typeof key !== 'string') return unavailable('Invalid specialist key.');
    const slot = currentState.snapshot.roster.squad.find((entry) => entry.member.key === key);
    if (slot === undefined) return unavailable(`No configured specialist matches "${key}".`);
    if (!slot.missing) return unavailable(`${slot.member.label} already has a session.`);
    return toUiResult(await runtime.startMember(slot.member));
  });

  ipcMain.handle(IPC_CHANNELS.stopSession, async (_event, id: unknown) => {
    if (client === undefined) return unavailable('Claude CLI is unavailable. Review Diagnostics.');
    if (typeof id !== 'string' || id.trim() === '') return unavailable('Invalid session id.');
    if (!isKnownActionableSession(id)) return unavailable('That session is not in the current roster.');
    return toUiResult(await client.stop(id));
  });

  ipcMain.handle(IPC_CHANNELS.wakeSquad, async () => {
    if (runtime === undefined) return unavailable('Claude integration is unavailable. Review Diagnostics.');
    return toUiResult(await runtime.wakeSquad());
  });

  ipcMain.handle(IPC_CHANNELS.logs, async (_event, id: unknown) => {
    if (client === undefined) return unavailable('Claude CLI is unavailable. Review Diagnostics.');
    if (typeof id !== 'string' || id.trim() === '') return unavailable('Invalid session id.');
    if (!isKnownActionableSession(id)) return unavailable('That session is not in the current roster.');
    return toUiResult(await client.logs(id));
  });

  ipcMain.handle(IPC_CHANNELS.reply, async (_event, id: unknown, message: unknown) => {
    if (client === undefined) return unavailable('Claude CLI is unavailable. Review Diagnostics.');
    if (currentState?.preflight.ptyAvailable !== true) {
      return unavailable('Reply is disabled because the optional node-pty bridge is unavailable.');
    }
    if (typeof id !== 'string' || id.trim() === '') return unavailable('Invalid session id.');
    if (!isKnownActionableSession(id)) return unavailable('That session is not in the current roster.');
    if (typeof message !== 'string' || message.trim() === '') return unavailable('Reply cannot be empty.');
    return toUiResult(await sendReply(client.cli.bin, id, message));
  });

  ipcMain.handle(
    IPC_CHANNELS.council,
    async (_event, question: unknown, cwd: unknown) => {
      if (runtime === undefined) return unavailable('Claude integration is unavailable. Review Diagnostics.');
      if (typeof question !== 'string' || question.trim() === '') {
        return unavailable('Council question cannot be empty.');
      }
      if (typeof cwd !== 'string' || cwd.trim() === '') return unavailable('Project path is required.');
      return toUiResult(await runtime.startCouncilReview(question, path.resolve(cwd)));
    },
  );
}

async function initializeWindowsApp(): Promise<void> {
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

  const rosterFile = path.join(app.getPath('userData'), 'roster.json');
  const roster = await loadRosterConfig(rosterFile, projectDir);
  if (roster.createdDefault) startupMessages.push(`Created roster config at ${rosterFile}`);

  currentState = {
    projectDir,
    preflight,
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

  client = ClaudeClient.fromBinary(preflight.claude.bin);
  runtime = new DecagramCouncilRuntime({
    client,
    paths: new ClaudePaths(),
    config: roster.config,
    onSnapshot: publishSnapshot,
    onNeedsInput: (delivery) => {
      if (!Notification.isSupported()) return;
      const message = 'message' in delivery.payload ? delivery.payload.message : undefined;
      new Notification({
        title: `${APP_NAME} needs you`,
        body: message ?? 'A specialist is waiting for input.',
      }).show();
    },
    onError: (error) => {
      startupMessages.push(error.message);
      if (currentState !== undefined) {
        currentState = { ...currentState, startupMessages: [...startupMessages] };
      }
    },
  });

  try {
    const report = await runtime.boot();
    publishSnapshot(report.snapshot);
    if (report.invalidAgents.length > 0) {
      startupMessages.push(
        `Missing agent definitions: ${report.invalidAgents.map((entry) => entry.agent).join(', ')}`,
      );
    }
    currentState = { ...currentState, startupMessages: [...startupMessages] };
    await runtime.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startupMessages.push(`Runtime startup failed: ${message}`);
    currentState = { ...currentState, startupMessages: [...startupMessages] };
  }
}

if (process.platform !== 'win32') {
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
      await initializeWindowsApp();
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
  if (runtime === undefined || shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void runtime.stop().finally(() => app.quit());
});
