/**
 * Small Electron-light single-instance bootstrap so the behavior can be
 * verified without starting a second Electron process in unit tests.
 */
export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(
    event: 'second-instance',
    listener: (
      event: unknown,
      argv: readonly string[],
      workingDirectory: string,
      additionalData: unknown,
    ) => void,
  ): void;
}

export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface SingleInstanceController {
  readonly primary: boolean;
  /** Delivers a focus request that arrived before the primary window existed. */
  notifyWindowReady(): void;
}

/**
 * Acquires the lock before application initialization. Arguments and the
 * working directory supplied by a second process are intentionally ignored;
 * a future workspace deep-link must pass through the primary process's normal
 * chooser and validation path.
 */
export function acquireSingleInstance(
  application: SingleInstanceApplication,
  getWindow: () => FocusableWindow | undefined,
): SingleInstanceController {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return { primary: false, notifyWindowReady: () => undefined };
  }

  let focusPending = false;
  const focus = (): void => {
    const window = getWindow();
    if (window === undefined || window.isDestroyed()) {
      focusPending = true;
      return;
    }
    focusPending = false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  application.on('second-instance', focus);
  return {
    primary: true,
    notifyWindowReady: () => {
      if (focusPending) focus();
    },
  };
}
