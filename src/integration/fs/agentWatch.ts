/**
 * Replaceable watcher for agent-definition inventory roots.
 *
 * The watcher emits invalidations only. It has no Claude client, supervisor, or
 * lifecycle dependency, so filesystem activity cannot start or stop sessions.
 */

import { watch, type FSWatcher } from 'chokidar';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

export type AgentDefinitionWatchEvent =
  | 'add'
  | 'change'
  | 'unlink'
  | 'addDir'
  | 'unlinkDir';

export interface AgentDefinitionChange {
  readonly event: AgentDefinitionWatchEvent;
  readonly path: string;
}

export interface AgentDefinitionWatcherOptions {
  /** Coalesces editor write bursts into one catalog rebuild. */
  readonly debounceMs?: number | undefined;
  /** Waits for in-place writes to settle before invalidating inventory. */
  readonly stabilityThresholdMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  /** Primarily useful for constrained test/remote filesystems. */
  readonly usePolling?: boolean | undefined;
  readonly watchIntervalMs?: number | undefined;
}

type ChangeListener = (changes: readonly AgentDefinitionChange[]) => void;
type ErrorListener = (error: Error) => void;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizedRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(root)))].sort(compareText);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isSameOrInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRelevantPath(target: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(target);
  return roots.some(
    (root) => isSameOrInside(root, resolved) || isSameOrInside(resolved, root),
  );
}

async function nearestExistingDirectory(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const currentStat = await stat(current);
      if (currentStat.isDirectory()) return current;
    } catch {
      // Missing and inaccessible path components are both handled by watching
      // the nearest parent that can be observed.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Watches project, ancestor, and optional user definition roots.
 *
 * `start()` resolves after Chokidar's ready event. `replaceRoots()` fully closes
 * the old watcher before publishing events from the replacement. Listener
 * registrations survive replacement and an explicit stop/start cycle.
 */
export class AgentDefinitionWatcher {
  private roots: string[];
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending = new Map<string, AgentDefinitionChange>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly debounceMs: number;
  private readonly stabilityThresholdMs: number;
  private readonly pollIntervalMs: number;
  private readonly usePolling: boolean;
  private readonly watchIntervalMs: number;
  private generation = 0;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    roots: readonly string[],
    options: AgentDefinitionWatcherOptions = {},
  ) {
    this.roots = normalizedRoots(roots);
    this.debounceMs = options.debounceMs ?? 150;
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? 60;
    this.pollIntervalMs = options.pollIntervalMs ?? 20;
    this.usePolling = options.usePolling ?? false;
    this.watchIntervalMs = options.watchIntervalMs ?? 100;
  }

  get watchedRoots(): readonly string[] {
    return this.roots;
  }

  get running(): boolean {
    return this.watcher !== undefined;
  }

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Resolves only after the current root set has completed initial discovery. */
  start(): Promise<void> {
    return this.transition(() => this.startInternal());
  }

  /**
   * Atomically replaces the watched inventory roots.
   *
   * Events already queued by the old watcher are discarded, and generation
   * checks prevent a late old-watcher callback from reaching consumers.
   */
  replaceRoots(roots: readonly string[]): Promise<void> {
    const replacement = normalizedRoots(roots);
    return this.transition(async () => {
      await this.stopInternal();
      this.roots = replacement;
      await this.startInternal();
    });
  }

  /** Fully closes the native watcher and discards pending invalidations. */
  stop(): Promise<void> {
    return this.transition(() => this.stopInternal());
  }

  private transition(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  private async startInternal(): Promise<void> {
    if (this.watcher !== undefined) return;

    const generation = ++this.generation;
    if (this.roots.length === 0) return;

    const watchTargets = normalizedRoots(
      await Promise.all(this.roots.map((root) => nearestExistingDirectory(root))),
    );
    const watcher = watch(watchTargets, {
      ignoreInitial: true,
      atomic: true,
      usePolling: this.usePolling,
      interval: this.watchIntervalMs,
      awaitWriteFinish: {
        stabilityThreshold: this.stabilityThresholdMs,
        pollInterval: this.pollIntervalMs,
      },
      // Missing `.claude/agents` roots are observed through their nearest
      // existing parent. Keep only exact path chains to requested roots so this
      // never turns an ancestor (especially a filesystem root) into a broad
      // recursive watch.
      ignored: (target) => !isRelevantPath(target, this.roots),
    });
    this.watcher = watcher;

    const handle =
      (event: AgentDefinitionWatchEvent) =>
      (target: string): void => {
        if (generation !== this.generation || watcher !== this.watcher) return;
        if (
          (event === 'add' || event === 'change' || event === 'unlink') &&
          !target.endsWith('.md')
        ) {
          return;
        }
        this.enqueue({ event, path: path.resolve(target) });
      };

    watcher.on('add', handle('add'));
    watcher.on('change', handle('change'));
    watcher.on('unlink', handle('unlink'));
    watcher.on('addDir', handle('addDir'));
    watcher.on('unlinkDir', handle('unlinkDir'));
    watcher.on('error', (error) => {
      if (generation !== this.generation || watcher !== this.watcher) return;
      const normalized = asError(error);
      for (const listener of this.errorListeners) listener(normalized);
    });

    await new Promise<void>((resolve) => {
      watcher.once('ready', resolve);
    });
  }

  private async stopInternal(): Promise<void> {
    this.generation += 1;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();

    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher !== undefined) await watcher.close();
  }

  private enqueue(change: AgentDefinitionChange): void {
    this.pending.set(change.path, change);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const changes = [...this.pending.values()].sort(
        (a, b) => compareText(a.path, b.path) || compareText(a.event, b.event),
      );
      this.pending.clear();
      for (const listener of this.changeListeners) listener(changes);
    }, this.debounceMs);
    this.timer.unref();
  }
}
