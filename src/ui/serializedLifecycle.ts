export interface SerializedLifecycleContext {
  /** True once a later operation has been requested. */
  readonly isLatest: boolean;
  /** True as soon as shutdown begins, including while this operation is in flight. */
  readonly isShuttingDown: boolean;
}

/**
 * Small, Electron-independent queue for application lifecycle work.
 *
 * Shutdown closes admission synchronously, invalidates every outstanding
 * context, skips work that had not started, and runs cleanup only after the
 * in-flight operation settles. Errors are returned to the individual caller
 * without poisoning later queue entries.
 */
export class SerializedLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private latestTicket = 0;
  private closing = false;
  private shutdownResult: Promise<void> | undefined;

  get isShuttingDown(): boolean {
    return this.closing;
  }

  enqueue<T>(
    operation: (context: SerializedLifecycleContext) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.closing) return Promise.resolve(undefined);

    const ticket = ++this.latestTicket;
    const thisQueue = this;
    const result = this.tail.then(async () => {
      if (this.closing) return undefined;
      const context: SerializedLifecycleContext = {
        get isLatest() {
          return !thisQueue.closing && ticket === thisQueue.latestTicket;
        },
        get isShuttingDown() {
          return thisQueue.closing;
        },
      };
      return operation(context);
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Closes the queue and drains it exactly once.
   *
   * Queued operations observe `closing` and are skipped. An operation already
   * awaiting I/O can observe `context.isShuttingDown` and exit early. Cleanup
   * still waits for that operation, so it is the last owner of app resources.
   */
  shutdown(cleanup: () => Promise<void>): Promise<void> {
    if (this.shutdownResult !== undefined) return this.shutdownResult;

    this.closing = true;
    this.latestTicket += 1;
    this.shutdownResult = this.tail.then(cleanup);
    this.tail = this.shutdownResult.then(
      () => undefined,
      () => undefined,
    );
    return this.shutdownResult;
  }

  /** Resolves after all admitted work (including shutdown cleanup) settles. */
  drain(): Promise<void> {
    return this.tail;
  }
}
