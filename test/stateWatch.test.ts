import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeClient } from '../src/integration/client.js';
import { ClaudeStateWatcher } from '../src/integration/fs/watch.js';
import { ClaudePaths } from '../src/integration/paths.js';
import { DecagramCouncilRuntime } from '../src/integration/runtime.js';

interface NativeWatcher {
  emit(event: 'error', error: unknown): boolean;
}

interface StateWatcherInternals {
  watcher: NativeWatcher | undefined;
}

interface RuntimeInternals {
  watcher: ClaudeStateWatcher;
}

const temporaryRoots: string[] = [];
const activeWatchers: ClaudeStateWatcher[] = [];

async function createPaths(): Promise<ClaudePaths> {
  const root = await mkdtemp(path.join(tmpdir(), 'decagram-state-watch-'));
  temporaryRoots.push(root);
  const configDir = path.join(root, '.claude');
  await mkdir(configDir);
  return new ClaudePaths({ configDir });
}

function nativeWatcher(watcher: ClaudeStateWatcher): NativeWatcher {
  const native = (watcher as unknown as StateWatcherInternals).watcher;
  if (native === undefined) throw new Error('Expected state watcher to be running');
  return native;
}

afterEach(async () => {
  await Promise.all(activeWatchers.splice(0).map((watcher) => watcher.stop()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('ClaudeStateWatcher diagnostics', () => {
  it('normalizes errors, isolates diagnostic listeners, and supports unsubscribe', async () => {
    const watcher = new ClaudeStateWatcher(await createPaths());
    activeWatchers.push(watcher);
    const persistent = vi.fn();
    const removed = vi.fn();
    watcher.onError(() => {
      throw new Error('diagnostic renderer failed');
    });
    watcher.onError(persistent);
    const unsubscribe = watcher.onError(removed);

    watcher.start();
    expect(() => nativeWatcher(watcher).emit('error', 'native watch failed')).not.toThrow();

    expect(persistent).toHaveBeenCalledTimes(1);
    expect(persistent.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(persistent.mock.calls[0]?.[0]).toMatchObject({
      message: 'native watch failed',
    });
    expect(removed).toHaveBeenCalledTimes(1);

    unsubscribe();
    nativeWatcher(watcher).emit('error', new Error('second failure'));
    expect(persistent).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(1);

    await watcher.stop();
    watcher.start();
    nativeWatcher(watcher).emit('error', new Error('after restart'));
    expect(persistent).toHaveBeenCalledTimes(3);
  });

  it('forwards watcher errors through the runtime error channel', async () => {
    const paths = await createPaths();
    const onError = vi.fn();
    const runtime = new DecagramCouncilRuntime({
      client: {} as ClaudeClient,
      paths,
      config: { version: 2, members: [], pollIntervalMs: 10_000 },
      onSnapshot: () => undefined,
      onError,
    });
    const watcher = (runtime as unknown as RuntimeInternals).watcher;
    activeWatchers.push(watcher);

    watcher.start();
    nativeWatcher(watcher).emit('error', new Error('provider state unavailable'));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'provider state unavailable' }),
    );
  });
});
