import { describe, expect, it, vi } from 'vitest';
import {
  acquireSingleInstance,
  type FocusableWindow,
  type SingleInstanceApplication,
} from '../src/ui/singleInstance.js';

function fakeApplication(lock: boolean): {
  app: SingleInstanceApplication;
  emitSecondInstance(): void;
  quit: ReturnType<typeof vi.fn>;
} {
  let listener:
    | ((
        event: unknown,
        argv: readonly string[],
        workingDirectory: string,
        additionalData: unknown,
      ) => void)
    | undefined;
  const quit = vi.fn<() => void>();
  return {
    app: {
      requestSingleInstanceLock: () => lock,
      quit,
      on: (_event, next) => {
        listener = next;
      },
    },
    emitSecondInstance: () => listener?.({}, ['ignored'], '/ignored', {}),
    quit,
  };
}

function fakeWindow(minimized = false): FocusableWindow & {
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: vi.fn<() => void>(),
    show: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
  };
}

describe('acquireSingleInstance', () => {
  it('quits before initialization when another runtime owns the lock', () => {
    const fixture = fakeApplication(false);
    expect(acquireSingleInstance(fixture.app, () => undefined).primary).toBe(false);
    expect(fixture.quit).toHaveBeenCalledOnce();
  });

  it('restores and focuses the existing window on a second launch', () => {
    const fixture = fakeApplication(true);
    const window = fakeWindow(true);
    expect(acquireSingleInstance(fixture.app, () => window).primary).toBe(true);

    fixture.emitSecondInstance();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it('queues a second-launch focus until the primary window exists', () => {
    const fixture = fakeApplication(true);
    let window: ReturnType<typeof fakeWindow> | undefined;
    const controller = acquireSingleInstance(fixture.app, () => window);
    expect(controller.primary).toBe(true);
    fixture.emitSecondInstance();
    window = fakeWindow();
    controller.notifyWindowReady();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(fixture.quit).not.toHaveBeenCalled();
  });
});
