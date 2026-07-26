import { describe, expect, it, vi } from 'vitest';
import {
  SerializedLifecycle,
  type SerializedLifecycleContext,
} from '../src/ui/serializedLifecycle.js';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('SerializedLifecycle', () => {
  it('runs admitted work serially and exposes when an operation is superseded', async () => {
    const queue = new SerializedLifecycle();
    const firstGate = deferred();
    const firstStarted = deferred();
    const order: string[] = [];
    let firstContext: SerializedLifecycleContext | undefined;

    const first = queue.enqueue(async (context) => {
      firstContext = context;
      order.push('first:start');
      firstStarted.resolve();
      await firstGate.promise;
      order.push('first:end');
    });
    await firstStarted.promise;

    const second = queue.enqueue(async (context) => {
      expect(context.isLatest).toBe(true);
      order.push('second');
    });
    expect(firstContext?.isLatest).toBe(false);
    expect(order).toEqual(['first:start']);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('closes admission immediately, cancels queued work, and cleans up after in-flight work', async () => {
    const queue = new SerializedLifecycle();
    const activeGate = deferred();
    const activeStarted = deferred();
    const order: string[] = [];
    let activeContext: SerializedLifecycleContext | undefined;

    const active = queue.enqueue(async (context) => {
      activeContext = context;
      order.push('active:start');
      activeStarted.resolve();
      await activeGate.promise;
      order.push(context.isShuttingDown ? 'active:cancelled' : 'active:continued');
    });
    await activeStarted.promise;

    const queued = vi.fn(async () => {
      order.push('queued');
    });
    const queuedResult = queue.enqueue(queued);
    const cleanup = vi.fn(async () => {
      order.push('cleanup');
    });
    const shutdown = queue.shutdown(cleanup);

    expect(queue.isShuttingDown).toBe(true);
    expect(activeContext?.isShuttingDown).toBe(true);
    expect(await queue.enqueue(async () => 'late')).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();

    activeGate.resolve();
    await Promise.all([active, queuedResult, shutdown, queue.drain()]);

    expect(queued).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(order).toEqual(['active:start', 'active:cancelled', 'cleanup']);
  });

  it('runs shutdown cleanup once and is not poisoned by a failed operation', async () => {
    const queue = new SerializedLifecycle();
    await expect(
      queue.enqueue(async () => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');

    await expect(queue.enqueue(async () => 'recovered')).resolves.toBe('recovered');

    const cleanup = vi.fn(async () => undefined);
    const firstShutdown = queue.shutdown(cleanup);
    const secondShutdown = queue.shutdown(cleanup);
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
