import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const AGENT_PACK_VERSION = 1;

const PACK_FILES = [
  ...[
    'builder.md',
    'prd-lead.md',
    'reviewer.md',
    'test-engineer.md',
    'council-chairman.md',
    'council-contrarian.md',
    'council-executor.md',
    'council-expansionist.md',
    'council-first-principles.md',
    'council-lead.md',
    'council-outsider.md',
  ].map((name) => path.join('.claude', 'agents', name)),
  ...[
    'agent-shell-dispatch.ps1',
    'agent-write-dispatch.ps1',
    'builder-write-guard.ps1',
    'guard-self-test.ps1',
    'prd-lead-write-guard.ps1',
    'README.md',
    'story-gate.ps1',
    'test-engineer-write-guard.ps1',
    '_guard-lib.ps1',
  ].map((name) => path.join('scripts', 'gates', name)),
] as const;

export interface AgentPackPreviewItem {
  readonly relativePath: string;
  readonly action: 'create' | 'merge' | 'unchanged' | 'conflict';
  readonly detail: string;
}

export interface AgentPackPreview {
  readonly version: number;
  readonly items: readonly AgentPackPreviewItem[];
  readonly canInstall: boolean;
}

export interface AgentPackInstallResult {
  readonly version: number;
  readonly created: number;
  readonly merged: number;
  readonly unchanged: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSettings(current: unknown, supplied: unknown): { value?: unknown; changed: boolean; problem?: string } {
  if (!isRecord(current) || !isRecord(supplied)) {
    return { changed: false, problem: 'Settings must contain JSON objects.' };
  }
  const merged: Record<string, unknown> = structuredClone(current);
  let changed = false;
  for (const [key, suppliedValue] of Object.entries(supplied)) {
    const currentValue = merged[key];
    if (currentValue === undefined) {
      merged[key] = structuredClone(suppliedValue);
      changed = true;
      continue;
    }
    if (key === 'hooks' && isRecord(currentValue) && isRecord(suppliedValue)) {
      const hooks: Record<string, unknown> = structuredClone(currentValue);
      for (const [eventName, suppliedGroups] of Object.entries(suppliedValue)) {
        if (!Array.isArray(suppliedGroups)) return { changed: false, problem: `Hook ${eventName} is not an array.` };
        const existingGroups = hooks[eventName];
        if (existingGroups !== undefined && !Array.isArray(existingGroups)) {
          return { changed: false, problem: `Existing hook ${eventName} is not an array.` };
        }
        const next = [...(existingGroups ?? [])] as unknown[];
        for (const group of suppliedGroups) {
          const serialized = JSON.stringify(group);
          if (!next.some((entry) => JSON.stringify(entry) === serialized)) {
            next.push(structuredClone(group));
            changed = true;
          }
        }
        hooks[eventName] = next;
      }
      merged[key] = hooks;
      continue;
    }
    if (isRecord(currentValue) && isRecord(suppliedValue)) {
      const nested = mergeSettings(currentValue, suppliedValue);
      if (nested.problem !== undefined) return nested;
      merged[key] = nested.value;
      changed ||= nested.changed;
      continue;
    }
    if (JSON.stringify(currentValue) !== JSON.stringify(suppliedValue)) {
      return { changed: false, problem: `Existing setting ${key} conflicts with the Agent Pack.` };
    }
  }
  return { value: merged, changed };
}

async function optionalBytes(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAtomic(file: string, bytes: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

export class AgentPackInstaller {
  constructor(
    private readonly sourceRoot: string,
    private readonly workspaceRoot: string,
  ) {}

  async preview(): Promise<AgentPackPreview> {
    const items: AgentPackPreviewItem[] = [];
    for (const relativePath of PACK_FILES) {
      const source = await readFile(path.join(this.sourceRoot, relativePath));
      const target = await optionalBytes(path.join(this.workspaceRoot, relativePath));
      const same = target !== undefined && source.equals(target);
      items.push({
        relativePath,
        action: target === undefined ? 'create' : same ? 'unchanged' : 'conflict',
        detail: target === undefined
          ? 'New managed file.'
          : same
            ? 'Already matches this pack.'
            : 'Existing file differs and will not be overwritten.',
      });
    }
    const settingsPath = path.join('.claude', 'settings.json');
    const suppliedText = await readFile(path.join(this.sourceRoot, settingsPath), 'utf8');
    const targetText = await optionalBytes(path.join(this.workspaceRoot, settingsPath));
    if (targetText === undefined) {
      items.push({ relativePath: settingsPath, action: 'create', detail: 'New Claude project settings.' });
    } else {
      try {
        const merged = mergeSettings(JSON.parse(targetText.toString('utf8')), JSON.parse(suppliedText));
        items.push({
          relativePath: settingsPath,
          action: merged.problem ? 'conflict' : merged.changed ? 'merge' : 'unchanged',
          detail: merged.problem ?? (merged.changed ? 'Add missing guarded hooks while preserving existing settings.' : 'Required settings are already present.'),
        });
      } catch {
        items.push({ relativePath: settingsPath, action: 'conflict', detail: 'Existing settings are not valid JSON and will not be overwritten.' });
      }
    }
    return {
      version: AGENT_PACK_VERSION,
      items,
      canInstall: !items.some((item) => item.action === 'conflict'),
    };
  }

  async install(expectedPreview: AgentPackPreview): Promise<AgentPackInstallResult> {
    const fresh = await this.preview();
    if (JSON.stringify(fresh) !== JSON.stringify(expectedPreview) || !fresh.canInstall) {
      throw new Error('Agent Pack preview changed or contains conflicts. Review it again.');
    }
    let created = 0;
    let unchanged = 0;
    for (const relativePath of PACK_FILES) {
      const item = fresh.items.find((entry) => entry.relativePath === relativePath)!;
      if (item.action === 'unchanged') {
        unchanged += 1;
        continue;
      }
      await writeAtomic(
        path.join(this.workspaceRoot, relativePath),
        await readFile(path.join(this.sourceRoot, relativePath)),
      );
      created += 1;
    }
    const settingsPath = path.join('.claude', 'settings.json');
    const settingsItem = fresh.items.find((entry) => entry.relativePath === settingsPath)!;
    let merged = 0;
    if (settingsItem.action !== 'unchanged') {
      const supplied = JSON.parse(await readFile(path.join(this.sourceRoot, settingsPath), 'utf8')) as unknown;
      const existing = await optionalBytes(path.join(this.workspaceRoot, settingsPath));
      const value = existing === undefined
        ? supplied
        : mergeSettings(JSON.parse(existing.toString('utf8')), supplied).value;
      await writeAtomic(path.join(this.workspaceRoot, settingsPath), `${JSON.stringify(value, null, 2)}\n`);
      if (settingsItem.action === 'create') created += 1;
      else merged += 1;
    } else {
      unchanged += 1;
    }
    const manifest = {
      version: AGENT_PACK_VERSION,
      installedAt: new Date().toISOString(),
      files: await Promise.all(PACK_FILES.map(async (relativePath) => ({
        relativePath,
        sha256: createHash('sha256').update(await readFile(path.join(this.sourceRoot, relativePath))).digest('hex'),
      }))),
    };
    await writeAtomic(
      path.join(this.workspaceRoot, '.claude', 'decagram-council-agent-pack.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return { version: AGENT_PACK_VERSION, created, merged, unchanged };
  }
}
