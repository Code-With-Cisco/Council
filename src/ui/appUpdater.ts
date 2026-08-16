export type AppUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface AppUpdateState {
  readonly status: AppUpdateStatus;
  readonly currentVersion: string;
  readonly availableVersion: string | undefined;
  readonly checkedAt: string | undefined;
  readonly releaseDate: string | undefined;
  readonly progress:
    | {
        readonly percent: number;
        readonly transferred: number;
        readonly total: number;
      }
    | undefined;
  readonly message: string;
}

export interface UpdateInfoLike {
  readonly version: string;
  readonly releaseDate?: string | undefined;
}

export interface ProgressInfoLike {
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
}

export interface AppUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (info: ProgressInfoLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdateControllerOptions {
  readonly updater: AppUpdaterPort | undefined;
  readonly currentVersion: string;
  readonly enabled: boolean;
  readonly now?: (() => Date) | undefined;
  readonly onState?: ((state: AppUpdateState) => void) | undefined;
}

function boundedPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** Manual, renderer-safe state machine around electron-updater. */
export class AppUpdateController {
  private readonly now: () => Date;
  private stateValue: AppUpdateState;
  private operation: Promise<AppUpdateState> | undefined;

  constructor(private readonly options: AppUpdateControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.stateValue = {
      status: options.enabled && options.updater !== undefined ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      availableVersion: undefined,
      checkedAt: undefined,
      releaseDate: undefined,
      progress: undefined,
      message: options.enabled
        ? 'Ready to check for updates.'
        : 'Updates are available only in the installed Windows application.',
    };
    const updater = options.updater;
    if (!options.enabled || updater === undefined) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = options.currentVersion.includes('-');
    updater.on('checking-for-update', () => {
      this.setState({ status: 'checking', message: 'Checking GitHub Releases for updates.' });
    });
    updater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        availableVersion: info.version,
        releaseDate: info.releaseDate,
        progress: undefined,
        message: `Version ${info.version} is available.`,
      });
    });
    updater.on('update-not-available', (info) => {
      this.setState({
        status: 'not-available',
        availableVersion: undefined,
        releaseDate: info.releaseDate,
        progress: undefined,
        message: `Version ${options.currentVersion} is up to date.`,
      });
    });
    updater.on('download-progress', (progress) => {
      this.setState({
        status: 'downloading',
        progress: {
          percent: boundedPercent(progress.percent),
          transferred: Math.max(0, progress.transferred),
          total: Math.max(0, progress.total),
        },
        message: `Downloading version ${this.stateValue.availableVersion ?? 'update'}.`,
      });
    });
    updater.on('update-downloaded', (info) => {
      this.setState({
        status: 'downloaded',
        availableVersion: info.version,
        releaseDate: info.releaseDate,
        progress: { percent: 100, transferred: this.stateValue.progress?.total ?? 0, total: this.stateValue.progress?.total ?? 0 },
        message: `Version ${info.version} is ready to install and relaunch.`,
      });
    });
    updater.on('error', () => {
      this.setState({
        status: 'error',
        progress: undefined,
        message: 'The update action failed. Check your internet connection and try again.',
      });
    });
  }

  get state(): AppUpdateState {
    return this.stateValue;
  }

  check(): Promise<AppUpdateState> {
    if (!this.options.enabled || this.options.updater === undefined) return Promise.resolve(this.stateValue);
    if (this.operation !== undefined) return this.operation;
    this.setState({
      status: 'checking',
      checkedAt: this.now().toISOString(),
      progress: undefined,
      message: 'Checking GitHub Releases for updates.',
    });
    return this.run(async () => {
      await this.options.updater!.checkForUpdates();
      return this.stateValue;
    });
  }

  download(): Promise<AppUpdateState> {
    if (this.stateValue.status !== 'available' || this.options.updater === undefined) {
      return Promise.resolve(this.stateValue);
    }
    if (this.operation !== undefined) return this.operation;
    this.setState({ status: 'downloading', progress: undefined, message: 'Starting update download.' });
    return this.run(async () => {
      await this.options.updater!.downloadUpdate();
      return this.stateValue;
    });
  }

  get installReady(): boolean {
    return this.stateValue.status === 'downloaded' && this.options.updater !== undefined;
  }

  quitAndInstall(): void {
    if (!this.installReady) throw new Error('No downloaded update is ready to install.');
    this.options.updater!.quitAndInstall(false, true);
  }

  private run(action: () => Promise<AppUpdateState>): Promise<AppUpdateState> {
    const operation = action()
      .catch(() => {
        this.setState({
          status: 'error',
          progress: undefined,
          message: 'The update action failed. Check your internet connection and try again.',
        });
        return this.stateValue;
      })
      .finally(() => {
        if (this.operation === operation) this.operation = undefined;
      });
    this.operation = operation;
    return operation;
  }

  private setState(change: Partial<AppUpdateState>): void {
    this.stateValue = { ...this.stateValue, ...change };
    this.options.onState?.(this.stateValue);
  }
}
