import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentDefinitionWatcher,
  type AgentDefinitionChange,
} from '../src/integration/fs/agentWatch.js';
import { resolveAgentCatalog } from '../src/supervisor/catalog.js';

const temporaryRoots: string[] = [];
const activeWatchers: AgentDefinitionWatcher[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'decagram-agent-watch-'));
  temporaryRoots.push(root);
  return root;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForChanges(
  watcher: AgentDefinitionWatcher,
  predicate: (changes: readonly AgentDefinitionChange[]) => boolean,
  timeoutMs = 4_000,
): Promise<readonly AgentDefinitionChange[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for an agent-definition watch event'));
    }, timeoutMs);
    const unsubscribe = watcher.onChange((changes) => {
      if (!predicate(changes)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(changes);
    });
  });
}

afterEach(async () => {
  await Promise.all(activeWatchers.splice(0).map((watcher) => watcher.stop()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('AgentDefinitionWatcher', () => {
  it('reports add, edit, rename, and removal after ready', async () => {
    const root = await temporaryRoot();
    const agents = path.join(root, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    const watcher = new AgentDefinitionWatcher([agents], {
      debounceMs: 20,
      stabilityThresholdMs: 20,
      pollIntervalMs: 5,
      usePolling: true,
      watchIntervalMs: 10,
    });
    activeWatchers.push(watcher);
    await watcher.start();

    expect(watcher.running).toBe(true);
    expect(watcher.watchedRoots).toEqual([agents]);

    const first = path.join(agents, 'first.md');
    const added = waitForChanges(
      watcher,
      (changes) => changes.some((change) => change.event === 'add' && change.path === first),
    );
    await writeFile(first, '---\nname: first\n---\n', 'utf8');
    expect(await added).toContainEqual({ event: 'add', path: first });

    const changed = waitForChanges(
      watcher,
      (changes) =>
        changes.some((change) => change.event === 'change' && change.path === first),
    );
    await writeFile(first, '---\nname: first\nmodel: sonnet\n---\n', 'utf8');
    expect(await changed).toContainEqual({ event: 'change', path: first });

    const renamedFile = path.join(agents, 'renamed.md');
    const renamed = waitForChanges(
      watcher,
      (changes) =>
        changes.some(
          (change) =>
            (change.event === 'add' && change.path === renamedFile) ||
            (change.event === 'unlink' && change.path === first),
        ),
    );
    await rename(first, renamedFile);
    const renameChanges = await renamed;
    expect(
      renameChanges.some(
        (change) => change.path === first || change.path === renamedFile,
      ),
    ).toBe(true);

    const removed = waitForChanges(
      watcher,
      (changes) =>
        changes.some(
          (change) => change.event === 'unlink' && change.path === renamedFile,
        ),
    );
    await unlink(renamedFile);
    expect(await removed).toContainEqual({ event: 'unlink', path: renamedFile });
  });

  it('detects creation beneath a definition root that was absent at startup', async () => {
    const root = await temporaryRoot();
    const agents = path.join(root, 'new-project', '.claude', 'agents');
    const watcher = new AgentDefinitionWatcher([agents], {
      debounceMs: 20,
      stabilityThresholdMs: 20,
      pollIntervalMs: 5,
      usePolling: true,
      watchIntervalMs: 10,
    });
    activeWatchers.push(watcher);
    await watcher.start();

    const definition = path.join(agents, 'new-agent.md');
    const observed = waitForChanges(
      watcher,
      (changes) => changes.some((change) => change.path === definition),
    );
    await mkdir(agents, { recursive: true });
    await writeFile(definition, '---\nname: new-agent\n---\n', 'utf8');

    expect((await observed).some((change) => change.path === definition)).toBe(true);
  });

  it('coalesces write bursts and ignores unrelated files', async () => {
    const root = await temporaryRoot();
    const agents = path.join(root, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    const definition = path.join(agents, 'agent.md');
    await writeFile(definition, '---\nname: agent\n---\n', 'utf8');

    const watcher = new AgentDefinitionWatcher([agents], {
      debounceMs: 40,
      stabilityThresholdMs: 20,
      pollIntervalMs: 5,
      usePolling: true,
      watchIntervalMs: 10,
    });
    activeWatchers.push(watcher);
    const batches: (readonly AgentDefinitionChange[])[] = [];
    watcher.onChange((changes) => batches.push(changes));
    await watcher.start();

    await writeFile(path.join(agents, 'notes.txt'), 'unrelated', 'utf8');
    await writeFile(definition, '---\nname: agent\nmodel: one\n---\n', 'utf8');
    await writeFile(definition, '---\nname: agent\nmodel: two\n---\n', 'utf8');
    await writeFile(definition, '---\nname: agent\nmodel: three\n---\n', 'utf8');
    await delay(250);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([{ event: 'change', path: definition }]);
  });

  it('replaces roots without leaking late events from the old watcher', async () => {
    const root = await temporaryRoot();
    const oldRoot = path.join(root, 'old-agents');
    const newRoot = path.join(root, 'new-agents');
    await mkdir(oldRoot, { recursive: true });
    await mkdir(newRoot, { recursive: true });
    const watcher = new AgentDefinitionWatcher([oldRoot], {
      debounceMs: 20,
      stabilityThresholdMs: 20,
      pollIntervalMs: 5,
      usePolling: true,
      watchIntervalMs: 10,
    });
    activeWatchers.push(watcher);
    await watcher.start();
    await watcher.replaceRoots([newRoot]);

    const oldFile = path.join(oldRoot, 'old.md');
    const newFile = path.join(newRoot, 'new.md');
    const observed: AgentDefinitionChange[] = [];
    watcher.onChange((changes) => observed.push(...changes));
    const newEvent = waitForChanges(
      watcher,
      (changes) => changes.some((change) => change.path === newFile),
    );
    await writeFile(oldFile, '---\nname: old\n---\n', 'utf8');
    await writeFile(newFile, '---\nname: new\n---\n', 'utf8');
    await newEvent;
    await delay(120);

    expect(watcher.watchedRoots).toEqual([newRoot]);
    expect(observed.some((change) => change.path === newFile)).toBe(true);
    expect(observed.some((change) => change.path === oldFile)).toBe(false);
  });

  it('stops fully without deleting listeners or publishing later changes', async () => {
    const root = await temporaryRoot();
    const agents = path.join(root, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    const watcher = new AgentDefinitionWatcher([agents], {
      debounceMs: 20,
      stabilityThresholdMs: 20,
      pollIntervalMs: 5,
      usePolling: true,
      watchIntervalMs: 10,
    });
    activeWatchers.push(watcher);
    const observed: AgentDefinitionChange[] = [];
    watcher.onChange((changes) => observed.push(...changes));
    await watcher.start();
    await watcher.stop();

    await writeFile(
      path.join(agents, 'after-stop.md'),
      '---\nname: after-stop\n---\n',
      'utf8',
    );
    await delay(120);

    expect(watcher.running).toBe(false);
    expect(observed).toEqual([]);
  });

  it('rebuilds catalog inventory on change', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'workspace');
    const agents = path.join(workspace, '.claude', 'agents');
    const definition = path.join(agents, 'builder.md');
    await mkdir(agents, { recursive: true });
    await writeFile(
      definition,
      '---\nname: builder\nmodel: sonnet\n---\n# Builder\n',
      'utf8',
    );
    const watcher = new AgentDefinitionWatcher([agents], {
      debounceMs: 20,
      stabilityThresholdMs: 20,
      pollIntervalMs: 5,
      usePolling: true,
      watchIntervalMs: 10,
    });
    activeWatchers.push(watcher);
    let rebuilt!: (model: string | undefined) => void;
    const rebuild = new Promise<string | undefined>((resolve) => {
      rebuilt = resolve;
    });
    watcher.onChange(() => {
      void resolveAgentCatalog({
        workspaceId: 'ws_catalog_watch',
        workspaceRoot: workspace,
        includeUser: false,
      }).then((catalog) => {
        rebuilt(
          catalog.entries.find((entry) => entry.agentName === 'builder')?.metadata
            ?.model,
        );
      });
    });
    await watcher.start();

    await writeFile(
      definition,
      '---\nname: builder\nmodel: opus\n---\n# Builder\n',
      'utf8',
    );

    await expect(rebuild).resolves.toBe('opus');
  });
});
