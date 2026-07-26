/**
 * Filesystem watching for Claude Code state.
 *
 * `<config>/jobs`, `<config>/teams` and `<config>/tasks` do not exist on a
 * fresh machine — they are created on the first background dispatch or the
 * first team. Watching them directly would silently no-op, so the config
 * directory is watched at bounded depth and paths are filtered instead. That
 * way the app starts working the moment those directories appear.
 *
 * Read-only: nothing here writes.
 */

import { watch, type FSWatcher } from 'chokidar';
import * as path from 'node:path';
import type { ClaudePaths } from '../paths.js';

/** Which area of Claude state changed. Consumers reload only what moved. */
export type StateChangeArea = 'jobs' | 'pins' | 'teams' | 'tasks' | 'settings';

export interface StateChange {
  readonly area: StateChangeArea;
  readonly path: string;
}

export interface WatchOptions {
  /**
   * Coalescing window. The supervisor rewrites `state.json` in bursts, and a
   * roster reload per write would thrash; 150ms collapses a burst into one
   * update while staying well inside a frame budget for perceived liveness.
   */
  readonly debounceMs?: number | undefined;
}

/**
 * Watches Claude state and emits coalesced change notifications.
 *
 * Delivers areas, not file contents: callers re-read through the normal reader
 * functions so a watch event and a poll tick converge on the same snapshot.
 */
export class ClaudeStateWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending = new Map<StateChangeArea, string>();
  private readonly listeners = new Set<(changes: readonly StateChange[]) => void>();
  private readonly debounceMs: number;

  constructor(
    private readonly paths: ClaudePaths,
    options: WatchOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
  }

  onChange(listener: (changes: readonly StateChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.watcher !== undefined) return;

    this.watcher = watch(this.paths.configDir, {
      // jobs/<id>/state.json is three levels below the config root; anything
      // deeper (per-session tmp/ scratch) is noise.
      depth: 3,
      ignoreInitial: true,
      // The supervisor writes state.json in place rather than via atomic
      // rename, so a change event can precede a complete file. Settling avoids
      // handing readers a torn document on every burst.
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
      ignored: (target: string) => this.classify(target) === undefined && !this.isAncestor(target),
    });

    const handle = (target: string): void => {
      const area = this.classify(target);
      if (area !== undefined) this.enqueue(area, target);
    };

    this.watcher.on('add', handle);
    this.watcher.on('change', handle);
    this.watcher.on('unlink', handle);
    this.watcher.on('addDir', handle);
    this.watcher.on('unlinkDir', handle);
    // A watch error must not take the app down; polling remains the safety net.
    this.watcher.on('error', () => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher !== undefined) await watcher.close();
  }

  /** Keeps directories on the path to a watched area traversable. */
  private isAncestor(target: string): boolean {
    const roots = [
      this.paths.configDir,
      this.paths.jobsDir(),
      this.paths.teamsDir(),
      path.join(this.paths.configDir, 'tasks'),
    ];
    if (roots.includes(target)) return true;
    // A job or team directory itself, whose children carry the real state.
    return roots.some((root) => path.dirname(target) === root);
  }

  private classify(target: string): StateChangeArea | undefined {
    const relative = path.relative(this.paths.configDir, target);
    if (relative === '' || relative.startsWith('..')) return undefined;

    const [head, ...rest] = relative.split(path.sep);
    switch (head) {
      case 'jobs':
        return rest[0] === 'pins.json' ? 'pins' : 'jobs';
      case 'teams':
        return 'teams';
      case 'tasks':
        return 'tasks';
      case 'settings.json':
        return 'settings';
      default:
        return undefined;
    }
  }

  private enqueue(area: StateChangeArea, target: string): void {
    this.pending.set(area, target);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const changes = [...this.pending].map(([a, p]) => ({ area: a, path: p }));
      this.pending.clear();
      for (const listener of this.listeners) listener(changes);
    }, this.debounceMs);
    this.timer.unref();
  }
}
