import { describe, expect, it, vi } from 'vitest';
import {
  AppUpdateController,
  type AppUpdaterPort,
  type ProgressInfoLike,
  type UpdateInfoLike,
} from '../src/ui/appUpdater.js';

class FakeUpdater implements AppUpdaterPort {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  readonly quitAndInstall = vi.fn();
  private readonly listeners = new Map<string, ((value?: unknown) => void)[]>();

  on(event: 'checking-for-update', listener: () => void): this;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): this;
  on(event: 'download-progress', listener: (info: ProgressInfoLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: string,
    listener:
      | (() => void)
      | ((info: UpdateInfoLike) => void)
      | ((info: ProgressInfoLike) => void)
      | ((error: Error) => void),
  ): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (value?: unknown) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  async checkForUpdates(): Promise<void> {
    this.emit('checking-for-update');
    this.emit('update-available', {
      version: '0.2.0',
      releaseDate: '2026-08-17T00:00:00.000Z',
    });
  }

  async downloadUpdate(): Promise<void> {
    this.emit('download-progress', { percent: 42.4, transferred: 424, total: 1000 });
    this.emit('update-downloaded', {
      version: '0.2.0',
      releaseDate: '2026-08-17T00:00:00.000Z',
    });
  }
}

describe('AppUpdateController', () => {
  it('disables updates outside an installed Windows build', async () => {
    const controller = new AppUpdateController({
      updater: undefined,
      currentVersion: '0.1.0',
      enabled: false,
    });
    expect(controller.state.status).toBe('unsupported');
    expect((await controller.check()).status).toBe('unsupported');
  });

  it('requires separate manual check and download steps', async () => {
    const updater = new FakeUpdater();
    const states: string[] = [];
    const controller = new AppUpdateController({
      updater,
      currentVersion: '0.1.0',
      enabled: true,
      now: () => new Date('2026-08-16T12:00:00.000Z'),
      onState: (state) => states.push(state.status),
    });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);

    expect((await controller.check()).status).toBe('available');
    expect(controller.state.checkedAt).toBe('2026-08-16T12:00:00.000Z');
    expect(controller.state.availableVersion).toBe('0.2.0');
    expect((await controller.download()).status).toBe('downloaded');
    expect(controller.state.progress?.percent).toBe(100);
    expect(states).toContain('downloading');
    expect(controller.installReady).toBe(true);

    controller.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it('returns a bounded generic failure instead of exposing updater errors', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      throw new Error('C:\\secret\\path token=private');
    };
    const controller = new AppUpdateController({
      updater,
      currentVersion: '0.1.0',
      enabled: true,
    });
    const state = await controller.check();
    expect(state.status).toBe('error');
    expect(state.message).not.toContain('secret');
    expect(state.message).not.toContain('private');
  });
});
