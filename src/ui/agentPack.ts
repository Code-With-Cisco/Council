import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const AGENT_PACK_VERSION = 2;

const MANIFEST_PATH = path.join('.claude', 'decagram-council-agent-pack.json');
const SETTINGS_PATH = path.join('.claude', 'settings.json');
const SETTINGS_BACKUP_PATH = path.join('.claude', '.decagram-council', 'agent-pack-settings.backup');

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
  readonly action: 'create' | 'update' | 'merge' | 'unchanged' | 'conflict';
  readonly detail: string;
}

export interface AgentPackPreview {
  readonly version: number;
  readonly operation: 'install' | 'update';
  readonly items: readonly AgentPackPreviewItem[];
  readonly canInstall: boolean;
}

export interface AgentPackInstallResult {
  readonly version: number;
  readonly operation: 'install' | 'update';
  readonly created: number;
  readonly updated: number;
  readonly merged: number;
  readonly unchanged: number;
}

export interface AgentPackUninstallPreviewItem {
  readonly relativePath: string;
  readonly action: 'remove' | 'restore' | 'leave' | 'conflict';
  readonly detail: string;
}

export interface AgentPackUninstallPreview {
  readonly version: number;
  readonly items: readonly AgentPackUninstallPreviewItem[];
  readonly canUninstall: boolean;
}

export interface AgentPackUninstallResult {
  readonly version: number;
  readonly removed: number;
  readonly restored: number;
  readonly leftUnchanged: number;
}

interface AgentPackManifestFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly owned: boolean;
}

interface AgentPackManifestSettings {
  readonly managed: boolean;
  readonly existedBeforeInstall: boolean;
  readonly installedSha256: string | undefined;
  readonly backupRelativePath: string | undefined;
}

interface AgentPackManifest {
  readonly version: number;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly files: readonly AgentPackManifestFile[];
  readonly settings: AgentPackManifestSettings;
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

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function optionalBytes(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function optionalJson(file: string): Promise<unknown | undefined> {
  const bytes = await optionalBytes(file);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Managed Agent Pack metadata is not valid JSON: ${file}`);
  }
}

function parseManifest(value: unknown): AgentPackManifest | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value['version'] !== 'number') {
    throw new Error('Managed Agent Pack metadata has an unsupported shape.');
  }
  if (value['version'] !== AGENT_PACK_VERSION) {
    throw new Error(
      `Agent Pack v${String(value['version'])} predates safe ownership and settings backups. `
      + 'Remove it manually or restore from version control before installing this version.',
    );
  }
  const files = value['files'];
  const settings = value['settings'];
  if (!Array.isArray(files) || !isRecord(settings)) {
    throw new Error('Managed Agent Pack metadata has an unsupported shape.');
  }
  const parsedFiles: AgentPackManifestFile[] = files.map((entry) => {
    if (!isRecord(entry)
      || typeof entry['relativePath'] !== 'string'
      || typeof entry['sha256'] !== 'string'
      || typeof entry['owned'] !== 'boolean') {
      throw new Error('Managed Agent Pack file metadata has an unsupported shape.');
    }
    return {
      relativePath: entry['relativePath'],
      sha256: entry['sha256'],
      owned: entry['owned'],
    };
  });
  const allowedFiles = new Set<string>(PACK_FILES);
  if (parsedFiles.some((entry) => !allowedFiles.has(entry.relativePath))
    || new Set(parsedFiles.map((entry) => entry.relativePath)).size !== parsedFiles.length) {
    throw new Error('Managed Agent Pack metadata contains an unexpected or duplicate file path.');
  }
  if (typeof settings['managed'] !== 'boolean'
    || typeof settings['existedBeforeInstall'] !== 'boolean'
    || (settings['installedSha256'] !== undefined && typeof settings['installedSha256'] !== 'string')
    || (settings['backupRelativePath'] !== undefined && settings['backupRelativePath'] !== SETTINGS_BACKUP_PATH)) {
    throw new Error('Managed Agent Pack settings metadata has an unsupported shape.');
  }
  return {
    version: AGENT_PACK_VERSION,
    installedAt: typeof value['installedAt'] === 'string' ? value['installedAt'] : '',
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '',
    files: parsedFiles,
    settings: {
      managed: settings['managed'],
      existedBeforeInstall: settings['existedBeforeInstall'],
      installedSha256: settings['installedSha256'] as string | undefined,
      backupRelativePath: settings['backupRelativePath'] as string | undefined,
    },
  };
}

async function writeAtomic(file: string, bytes: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export class AgentPackInstaller {
  constructor(
    private readonly sourceRoot: string,
    private readonly workspaceRoot: string,
  ) {}

  private async manifest(): Promise<AgentPackManifest | undefined> {
    return parseManifest(await optionalJson(path.join(this.workspaceRoot, MANIFEST_PATH)));
  }

  async preview(): Promise<AgentPackPreview> {
    const manifest = await this.manifest();
    const operation = manifest === undefined ? 'install' : 'update';
    const items: AgentPackPreviewItem[] = [];
    for (const relativePath of PACK_FILES) {
      const source = await readFile(path.join(this.sourceRoot, relativePath));
      const target = await optionalBytes(path.join(this.workspaceRoot, relativePath));
      const previous = manifest?.files.find((entry) => entry.relativePath === relativePath);
      const sameAsSource = target !== undefined && source.equals(target);
      const matchesPrevious = target !== undefined && previous !== undefined && sha256(target) === previous.sha256;
      const action = target === undefined
        ? 'create'
        : sameAsSource
          ? 'unchanged'
          : previous?.owned === true && matchesPrevious
            ? 'update'
            : 'conflict';
      items.push({
        relativePath,
        action,
        detail: action === 'create'
          ? 'New managed file.'
          : action === 'update'
            ? 'Managed file matches the installed version and can be updated safely.'
            : action === 'unchanged'
              ? 'Already matches this pack.'
              : previous === undefined || !matchesPrevious
                ? 'Existing file differs and will not be overwritten.'
                : 'This matching file was not created by Council and will not be replaced.',
      });
    }
    const suppliedText = await readFile(path.join(this.sourceRoot, SETTINGS_PATH), 'utf8');
    const targetText = await optionalBytes(path.join(this.workspaceRoot, SETTINGS_PATH));
    if (targetText === undefined) {
      items.push({ relativePath: SETTINGS_PATH, action: 'create', detail: 'New Claude project settings.' });
    } else if (manifest?.settings.managed === true
      && manifest.settings.installedSha256 !== undefined
      && sha256(targetText) !== manifest.settings.installedSha256) {
      items.push({
        relativePath: SETTINGS_PATH,
        action: 'conflict',
        detail: 'Settings changed after Agent Pack installation. They will not be overwritten.',
      });
    } else {
      try {
        const merged = mergeSettings(JSON.parse(targetText.toString('utf8')), JSON.parse(suppliedText));
        items.push({
          relativePath: SETTINGS_PATH,
          action: merged.problem ? 'conflict' : merged.changed ? 'merge' : 'unchanged',
          detail: merged.problem ?? (merged.changed ? 'Add missing guarded hooks while preserving existing settings.' : 'Required settings are already present.'),
        });
      } catch {
        items.push({ relativePath: SETTINGS_PATH, action: 'conflict', detail: 'Existing settings are not valid JSON and will not be overwritten.' });
      }
    }
    return {
      version: AGENT_PACK_VERSION,
      operation,
      items,
      canInstall: !items.some((item) => item.action === 'conflict'),
    };
  }

  async install(expectedPreview: AgentPackPreview): Promise<AgentPackInstallResult> {
    const fresh = await this.preview();
    if (JSON.stringify(fresh) !== JSON.stringify(expectedPreview) || !fresh.canInstall) {
      throw new Error('Agent Pack preview changed or contains conflicts. Review it again.');
    }
    const previousManifest = await this.manifest();
    const installedAt = previousManifest?.installedAt || new Date().toISOString();
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const files: AgentPackManifestFile[] = [];
    for (const relativePath of PACK_FILES) {
      const item = fresh.items.find((entry) => entry.relativePath === relativePath)!;
      const source = await readFile(path.join(this.sourceRoot, relativePath));
      const previous = previousManifest?.files.find((entry) => entry.relativePath === relativePath);
      if (item.action === 'unchanged') {
        unchanged += 1;
      } else {
        await writeAtomic(path.join(this.workspaceRoot, relativePath), source);
        if (item.action === 'update') updated += 1;
        else created += 1;
      }
      files.push({
        relativePath,
        sha256: sha256(source),
        owned: previous?.owned === true || item.action === 'create',
      });
    }

    const settingsItem = fresh.items.find((entry) => entry.relativePath === SETTINGS_PATH)!;
    const existingSettings = await optionalBytes(path.join(this.workspaceRoot, SETTINGS_PATH));
    let installedSettings = existingSettings;
    let merged = 0;
    if (settingsItem.action !== 'unchanged') {
      const supplied = JSON.parse(await readFile(path.join(this.sourceRoot, SETTINGS_PATH), 'utf8')) as unknown;
      const value = existingSettings === undefined
        ? supplied
        : mergeSettings(JSON.parse(existingSettings.toString('utf8')), supplied).value;
      installedSettings = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      if (previousManifest?.settings.managed !== true && existingSettings !== undefined) {
        await writeAtomic(path.join(this.workspaceRoot, SETTINGS_BACKUP_PATH), existingSettings);
      }
      await writeAtomic(path.join(this.workspaceRoot, SETTINGS_PATH), installedSettings);
      if (settingsItem.action === 'create') created += 1;
      else merged += 1;
    } else {
      unchanged += 1;
    }

    const settingsManaged = previousManifest?.settings.managed === true || settingsItem.action !== 'unchanged';
    const manifest: AgentPackManifest = {
      version: AGENT_PACK_VERSION,
      installedAt,
      updatedAt: new Date().toISOString(),
      files,
      settings: previousManifest?.settings.managed === true
        ? {
            ...previousManifest.settings,
            installedSha256: installedSettings === undefined ? undefined : sha256(installedSettings),
          }
        : {
            managed: settingsManaged,
            existedBeforeInstall: existingSettings !== undefined,
            installedSha256: settingsManaged && installedSettings !== undefined ? sha256(installedSettings) : undefined,
            backupRelativePath: settingsManaged && existingSettings !== undefined
              ? SETTINGS_BACKUP_PATH
              : undefined,
          },
    };
    await writeAtomic(
      path.join(this.workspaceRoot, MANIFEST_PATH),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return { version: AGENT_PACK_VERSION, operation: fresh.operation, created, updated, merged, unchanged };
  }

  async previewUninstall(): Promise<AgentPackUninstallPreview> {
    const manifest = await this.manifest();
    if (manifest === undefined) throw new Error('No managed Agent Pack installation was found.');
    const items: AgentPackUninstallPreviewItem[] = [];
    for (const entry of manifest.files) {
      const target = await optionalBytes(path.join(this.workspaceRoot, entry.relativePath));
      if (!entry.owned) {
        items.push({
          relativePath: entry.relativePath,
          action: 'leave',
          detail: 'This file existed before installation and will be left in place.',
        });
      } else if (target === undefined) {
        items.push({
          relativePath: entry.relativePath,
          action: 'leave',
          detail: 'Managed file is already absent.',
        });
      } else if (sha256(target) !== entry.sha256) {
        items.push({
          relativePath: entry.relativePath,
          action: 'conflict',
          detail: 'Managed file changed after installation and will not be deleted.',
        });
      } else {
        items.push({ relativePath: entry.relativePath, action: 'remove', detail: 'Remove unchanged managed file.' });
      }
    }

    if (!manifest.settings.managed) {
      items.push({
        relativePath: SETTINGS_PATH,
        action: 'leave',
        detail: 'Settings already contained the required configuration before installation.',
      });
    } else {
      const current = await optionalBytes(path.join(this.workspaceRoot, SETTINGS_PATH));
      const currentMatches = current !== undefined
        && manifest.settings.installedSha256 !== undefined
        && sha256(current) === manifest.settings.installedSha256;
      const backup = manifest.settings.backupRelativePath === undefined
        ? undefined
        : await optionalBytes(path.join(this.workspaceRoot, manifest.settings.backupRelativePath));
      if (!currentMatches) {
        items.push({
          relativePath: SETTINGS_PATH,
          action: 'conflict',
          detail: 'Settings changed after installation and cannot be restored without risking user changes.',
        });
      } else if (manifest.settings.existedBeforeInstall && backup === undefined) {
        items.push({
          relativePath: SETTINGS_PATH,
          action: 'conflict',
          detail: 'The pre-install settings backup is missing, so uninstall cannot restore it safely.',
        });
      } else {
        items.push({
          relativePath: SETTINGS_PATH,
          action: manifest.settings.existedBeforeInstall ? 'restore' : 'remove',
          detail: manifest.settings.existedBeforeInstall
            ? 'Restore the exact pre-install settings backup.'
            : 'Remove settings created by Agent Pack installation.',
        });
      }
    }
    return {
      version: manifest.version,
      items,
      canUninstall: !items.some((item) => item.action === 'conflict'),
    };
  }

  async uninstall(expectedPreview: AgentPackUninstallPreview): Promise<AgentPackUninstallResult> {
    const fresh = await this.previewUninstall();
    if (JSON.stringify(fresh) !== JSON.stringify(expectedPreview) || !fresh.canUninstall) {
      throw new Error('Agent Pack uninstall preview changed or contains conflicts. Review it again.');
    }
    const manifest = (await this.manifest())!;
    let removed = 0;
    let restored = 0;
    let leftUnchanged = 0;
    for (const entry of manifest.files) {
      const item = fresh.items.find((candidate) => candidate.relativePath === entry.relativePath)!;
      if (item.action === 'remove') {
        await unlinkIfPresent(path.join(this.workspaceRoot, entry.relativePath));
        removed += 1;
      } else {
        leftUnchanged += 1;
      }
    }
    const settingsItem = fresh.items.find((candidate) => candidate.relativePath === SETTINGS_PATH)!;
    if (settingsItem.action === 'restore') {
      const backupPath = path.join(this.workspaceRoot, manifest.settings.backupRelativePath!);
      await writeAtomic(path.join(this.workspaceRoot, SETTINGS_PATH), await readFile(backupPath));
      restored += 1;
    } else if (settingsItem.action === 'remove') {
      await unlinkIfPresent(path.join(this.workspaceRoot, SETTINGS_PATH));
      removed += 1;
    } else {
      leftUnchanged += 1;
    }
    if (manifest.settings.backupRelativePath !== undefined) {
      await unlinkIfPresent(path.join(this.workspaceRoot, manifest.settings.backupRelativePath));
    }
    await unlinkIfPresent(path.join(this.workspaceRoot, MANIFEST_PATH));
    return { version: manifest.version, removed, restored, leftUnchanged };
  }
}
