import { constants } from 'node:fs';
import {
  access as nodeAccess,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  stat as nodeStat,
} from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomicJson.js';

export const APP_CONFIG_VERSION = 1;
export const APP_CONFIG_FILENAME = 'app-config.json';
export const DEFAULT_INCLUDE_USER_DEFINITIONS = true;

const WORKSPACE_ID = /^ws_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceId = string;

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly label: string;
  /** Absolute path selected by the user, retained for a useful display/retry. */
  readonly selectedPath: string;
  /** Filesystem-resolved identity, including symlink and junction resolution. */
  readonly canonicalPath: string;
  readonly lastValidatedAt: string;
  /** Set only by a separate explicit confirmation after repository selection. */
  readonly trusted: boolean;
}

export interface AppConfig {
  readonly version: typeof APP_CONFIG_VERSION;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly activeWorkspaceId: WorkspaceId | null;
  readonly includeUserDefinitions: boolean;
}

export type AppConfigDiagnosticCode =
  | 'invalid-json'
  | 'invalid-config'
  | 'read-error';

export interface AppConfigDiagnostic {
  readonly code: AppConfigDiagnosticCode;
  readonly file: string;
  readonly message: string;
}

export type AppConfigLoadSource =
  | 'disk'
  | 'missing'
  | 'last-known-good'
  | 'safe-default';

export interface AppConfigLoad {
  readonly config: AppConfig;
  readonly activeWorkspace: WorkspaceRecord | undefined;
  readonly setupRequired: boolean;
  readonly source: AppConfigLoadSource;
  readonly diagnostic: AppConfigDiagnostic | undefined;
  readonly writeBlocked: boolean;
}

export type WorkspaceValidationCode =
  | 'path-not-absolute'
  | 'missing'
  | 'inaccessible'
  | 'not-directory'
  | 'canonicalization-failed'
  | 'canonical-path-changed';

export class WorkspaceValidationError extends Error {
  constructor(
    readonly code: WorkspaceValidationCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'WorkspaceValidationError';
  }
}

export class AppConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppConfigParseError';
  }
}

export class AppConfigWriteBlockedError extends Error {
  constructor(readonly diagnostic: AppConfigDiagnostic) {
    super(
      `Refusing to overwrite malformed application configuration at ${diagnostic.file}: ${diagnostic.message}`,
    );
    this.name = 'AppConfigWriteBlockedError';
  }
}

interface WorkspaceStat {
  isDirectory(): boolean;
}

export interface WorkspaceValidationFileSystem {
  stat(target: string): Promise<WorkspaceStat>;
  access(target: string, mode: number): Promise<unknown>;
  realpath(target: string): Promise<string>;
}

const NODE_VALIDATION_FILE_SYSTEM: WorkspaceValidationFileSystem = {
  stat: nodeStat,
  access: nodeAccess,
  realpath: nodeRealpath,
};

export interface WorkspaceValidation {
  readonly selectedPath: string;
  readonly canonicalPath: string;
  readonly label: string;
  readonly validatedAt: string;
}

export interface ValidateWorkspaceOptions {
  readonly fileSystem?: WorkspaceValidationFileSystem | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface AppConfigStoreOptions {
  readonly readText?: ((file: string) => Promise<string>) | undefined;
  readonly writeConfig?: ((file: string, config: AppConfig) => Promise<void>) | undefined;
  readonly validateWorkspace?: ((selectedPath: string) => Promise<WorkspaceValidation>) | undefined;
  readonly workspaceId?: (() => WorkspaceId) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function validationFailure(
  error: unknown,
  target: string,
  fallbackCode: WorkspaceValidationCode,
): WorkspaceValidationError {
  const code = errno(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new WorkspaceValidationError('missing', `Workspace does not exist: ${target}`, {
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkspaceValidationError('inaccessible', `Workspace is not readable: ${target}`, {
      cause: error,
    });
  }
  return new WorkspaceValidationError(
    fallbackCode,
    `Could not validate workspace "${target}": ${messageFor(error)}`,
    { cause: error },
  );
}

/**
 * Verifies a user-selected directory without ever falling back to process.cwd().
 * `realpath` supplies the canonical identity used for workspace/session scope.
 */
export async function validateWorkspaceDirectory(
  selectedPath: string,
  options: ValidateWorkspaceOptions = {},
): Promise<WorkspaceValidation> {
  if (typeof selectedPath !== 'string' || selectedPath.trim() === '') {
    throw new WorkspaceValidationError('missing', 'Workspace path is empty.');
  }
  if (!path.isAbsolute(selectedPath)) {
    throw new WorkspaceValidationError(
      'path-not-absolute',
      `Workspace path must be absolute: ${selectedPath}`,
    );
  }

  const fileSystem = options.fileSystem ?? NODE_VALIDATION_FILE_SYSTEM;
  const normalizedSelection = path.normalize(selectedPath);

  let information: WorkspaceStat;
  try {
    information = await fileSystem.stat(normalizedSelection);
  } catch (error) {
    throw validationFailure(error, normalizedSelection, 'inaccessible');
  }
  if (!information.isDirectory()) {
    throw new WorkspaceValidationError(
      'not-directory',
      `Workspace path is not a directory: ${normalizedSelection}`,
    );
  }

  try {
    await fileSystem.access(normalizedSelection, constants.R_OK);
  } catch (error) {
    throw validationFailure(error, normalizedSelection, 'inaccessible');
  }

  let canonicalPath: string;
  try {
    canonicalPath = path.normalize(await fileSystem.realpath(normalizedSelection));
  } catch (error) {
    throw validationFailure(error, normalizedSelection, 'canonicalization-failed');
  }

  return {
    selectedPath: normalizedSelection,
    canonicalPath,
    label: path.basename(canonicalPath) || canonicalPath,
    validatedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

export function createWorkspaceId(): WorkspaceId {
  return `ws_${randomUUID()}`;
}

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID.test(value);
}

export function appConfigPath(userDataDirectory: string): string {
  if (!path.isAbsolute(userDataDirectory)) {
    throw new TypeError('Electron userData directory must be absolute.');
  }
  return path.join(userDataDirectory, APP_CONFIG_FILENAME);
}

export function defaultAppConfig(): AppConfig {
  return {
    version: APP_CONFIG_VERSION,
    workspaces: [],
    activeWorkspaceId: null,
    includeUserDefinitions: DEFAULT_INCLUDE_USER_DEFINITIONS,
  };
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppConfigParseError(`${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  location: string,
): void {
  const allowed = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new AppConfigParseError(
      `${location} contains unsupported field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}.`,
    );
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppConfigParseError(`${location} must be a non-empty string.`);
  }
  return value;
}

function parseWorkspace(value: unknown, index: number): WorkspaceRecord {
  const location = `workspaces[${index}]`;
  const raw = record(value, location);
  exactKeys(
    raw,
    ['id', 'label', 'selectedPath', 'canonicalPath', 'lastValidatedAt', 'trusted'],
    location,
  );

  const id = nonEmptyString(raw['id'], `${location}.id`);
  if (!isWorkspaceId(id)) {
    throw new AppConfigParseError(`${location}.id is not a Council workspace ID.`);
  }
  const lastValidatedAt = nonEmptyString(
    raw['lastValidatedAt'],
    `${location}.lastValidatedAt`,
  );
  if (Number.isNaN(Date.parse(lastValidatedAt))) {
    throw new AppConfigParseError(`${location}.lastValidatedAt is not a valid timestamp.`);
  }
  if (typeof raw['trusted'] !== 'boolean') {
    throw new AppConfigParseError(`${location}.trusted must be a boolean.`);
  }
  const selectedPath = nonEmptyString(raw['selectedPath'], `${location}.selectedPath`);
  const canonicalPath = nonEmptyString(raw['canonicalPath'], `${location}.canonicalPath`);
  if (!path.isAbsolute(selectedPath)) {
    throw new AppConfigParseError(`${location}.selectedPath must be absolute.`);
  }
  if (!path.isAbsolute(canonicalPath)) {
    throw new AppConfigParseError(`${location}.canonicalPath must be absolute.`);
  }

  return {
    id,
    label: nonEmptyString(raw['label'], `${location}.label`),
    selectedPath,
    canonicalPath,
    lastValidatedAt,
    trusted: raw['trusted'],
  };
}

/** Strictly parses the current on-disk schema. Unknown versions are not guessed. */
export function parseAppConfig(value: unknown): AppConfig {
  const raw = record(value, 'app config');
  exactKeys(
    raw,
    ['version', 'workspaces', 'activeWorkspaceId', 'includeUserDefinitions'],
    'app config',
  );

  if (raw['version'] !== APP_CONFIG_VERSION) {
    throw new AppConfigParseError(
      `Unsupported app config version ${String(raw['version'])}; expected ${APP_CONFIG_VERSION}.`,
    );
  }
  if (!Array.isArray(raw['workspaces'])) {
    throw new AppConfigParseError('app config workspaces must be an array.');
  }
  if (typeof raw['includeUserDefinitions'] !== 'boolean') {
    throw new AppConfigParseError('app config includeUserDefinitions must be a boolean.');
  }

  const workspaces = raw['workspaces'].map(parseWorkspace);
  const seenIds = new Set<string>();
  const seenCanonicalPaths = new Set<string>();
  for (const workspace of workspaces) {
    if (seenIds.has(workspace.id)) {
      throw new AppConfigParseError(`Duplicate workspace ID "${workspace.id}".`);
    }
    if (seenCanonicalPaths.has(workspace.canonicalPath)) {
      throw new AppConfigParseError(
        `Duplicate canonical workspace path "${workspace.canonicalPath}".`,
      );
    }
    seenIds.add(workspace.id);
    seenCanonicalPaths.add(workspace.canonicalPath);
  }

  const activeValue = raw['activeWorkspaceId'];
  if (activeValue !== null && typeof activeValue !== 'string') {
    throw new AppConfigParseError('app config activeWorkspaceId must be a workspace ID or null.');
  }
  const activeWorkspaceId = activeValue as string | null;
  if (activeWorkspaceId !== null && !seenIds.has(activeWorkspaceId)) {
    throw new AppConfigParseError(
      `Active workspace ID "${activeWorkspaceId}" does not exist in workspaces.`,
    );
  }

  return {
    version: APP_CONFIG_VERSION,
    workspaces,
    activeWorkspaceId,
    includeUserDefinitions: raw['includeUserDefinitions'],
  };
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(value);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function loadView(
  config: AppConfig,
  source: AppConfigLoadSource,
  diagnostic: AppConfigDiagnostic | undefined,
  writeBlocked: boolean,
): AppConfigLoad {
  const activeWorkspace =
    config.activeWorkspaceId === null
      ? undefined
      : config.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId);
  return {
    config,
    activeWorkspace,
    setupRequired: activeWorkspace === undefined,
    source,
    diagnostic,
    writeBlocked,
  };
}

/**
 * Stateful application-config store.
 *
 * A malformed external edit never replaces the in-memory known-good snapshot
 * and blocks every write until a later reload observes valid JSON again.
 */
export class AppConfigStore {
  readonly file: string;

  private config: AppConfig = defaultAppConfig();
  private lastDiagnostic: AppConfigDiagnostic | undefined;
  private hasKnownGood = false;
  private blocked = false;

  private readonly readText: (file: string) => Promise<string>;
  private readonly writeConfig: (file: string, config: AppConfig) => Promise<void>;
  private readonly validateSelectedWorkspace: (
    selectedPath: string,
  ) => Promise<WorkspaceValidation>;
  private readonly workspaceId: () => WorkspaceId;
  private readonly platform: NodeJS.Platform;

  constructor(
    readonly userDataDirectory: string,
    options: AppConfigStoreOptions = {},
  ) {
    this.file = appConfigPath(userDataDirectory);
    this.readText = options.readText ?? ((file) => nodeReadFile(file, 'utf8'));
    this.writeConfig =
      options.writeConfig ?? ((file, config) => writeJsonAtomic(file, config));
    this.validateSelectedWorkspace =
      options.validateWorkspace ?? ((selectedPath) => validateWorkspaceDirectory(selectedPath));
    this.workspaceId = options.workspaceId ?? createWorkspaceId;
    this.platform = options.platform ?? process.platform;
  }

  get current(): AppConfig {
    return this.config;
  }

  get diagnostic(): AppConfigDiagnostic | undefined {
    return this.lastDiagnostic;
  }

  get writeBlocked(): boolean {
    return this.blocked;
  }

  get activeWorkspace(): WorkspaceRecord | undefined {
    return this.config.activeWorkspaceId === null
      ? undefined
      : this.config.workspaces.find(
          (workspace) => workspace.id === this.config.activeWorkspaceId,
        );
  }

  async load(): Promise<AppConfigLoad> {
    let text: string;
    try {
      text = await this.readText(this.file);
    } catch (error) {
      if (errno(error) === 'ENOENT') {
        this.config = defaultAppConfig();
        this.hasKnownGood = true;
        this.blocked = false;
        this.lastDiagnostic = undefined;
        return loadView(this.config, 'missing', undefined, false);
      }
      return this.retainAfterInvalidDisk('read-error', messageFor(error));
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return this.retainAfterInvalidDisk(
        'invalid-json',
        `Application configuration is not valid JSON: ${messageFor(error)}`,
      );
    }

    try {
      this.config = parseAppConfig(value);
      this.hasKnownGood = true;
      this.blocked = false;
      this.lastDiagnostic = undefined;
      return loadView(this.config, 'disk', undefined, false);
    } catch (error) {
      return this.retainAfterInvalidDisk('invalid-config', messageFor(error));
    }
  }

  /** Alias that documents the intended use after an external file change. */
  reload(): Promise<AppConfigLoad> {
    return this.load();
  }

  async save(nextConfig: AppConfig): Promise<AppConfig> {
    if (this.blocked && this.lastDiagnostic !== undefined) {
      throw new AppConfigWriteBlockedError(this.lastDiagnostic);
    }

    // A filesystem notification can race an explicit save. Re-read immediately
    // before writing so a malformed external edit is protected even when the
    // watcher has not delivered its reload yet.
    try {
      const currentText = await this.readText(this.file);
      try {
        parseAppConfig(JSON.parse(currentText) as unknown);
      } catch (error) {
        const code: AppConfigDiagnosticCode =
          error instanceof SyntaxError ? 'invalid-json' : 'invalid-config';
        this.retainAfterInvalidDisk(code, messageFor(error));
        throw new AppConfigWriteBlockedError(this.lastDiagnostic!);
      }
    } catch (error) {
      if (error instanceof AppConfigWriteBlockedError) throw error;
      if (errno(error) !== 'ENOENT') {
        this.retainAfterInvalidDisk('read-error', messageFor(error));
        throw new AppConfigWriteBlockedError(this.lastDiagnostic!);
      }
    }

    // Re-parse a plain JSON copy so even an `as AppConfig` caller cannot place
    // an invalid or unsupported schema on disk.
    const validated = parseAppConfig(JSON.parse(JSON.stringify(nextConfig)) as unknown);
    await this.writeConfig(this.file, validated);
    this.config = validated;
    this.hasKnownGood = true;
    this.lastDiagnostic = undefined;
    return this.config;
  }

  /**
   * Validates and activates a selected directory. A genuinely new canonical
   * repository is always untrusted until `confirmWorkspaceTrust` is called.
   */
  async selectWorkspace(selectedPath: string): Promise<WorkspaceRecord> {
    const validation = await this.validateSelectedWorkspace(selectedPath);
    const identity = pathIdentity(validation.canonicalPath, this.platform);
    const existing = this.config.workspaces.find(
      (workspace) => pathIdentity(workspace.canonicalPath, this.platform) === identity,
    );

    const workspace: WorkspaceRecord =
      existing === undefined
        ? {
            id: this.newWorkspaceId(),
            label: validation.label,
            selectedPath: validation.selectedPath,
            canonicalPath: validation.canonicalPath,
            lastValidatedAt: validation.validatedAt,
            trusted: false,
          }
        : {
            ...existing,
            label: validation.label,
            selectedPath: validation.selectedPath,
            canonicalPath: validation.canonicalPath,
            lastValidatedAt: validation.validatedAt,
          };

    const workspaces =
      existing === undefined
        ? [...this.config.workspaces, workspace]
        : this.config.workspaces.map((entry) => (entry.id === existing.id ? workspace : entry));
    await this.save({
      ...this.config,
      workspaces,
      activeWorkspaceId: workspace.id,
    });
    return workspace;
  }

  async confirmWorkspaceTrust(workspaceId: WorkspaceId): Promise<WorkspaceRecord> {
    if (workspaceId !== this.config.activeWorkspaceId) {
      throw new Error('Only the active workspace can be trusted.');
    }
    const existing = this.activeWorkspace;
    if (existing === undefined) {
      throw new Error(`Unknown workspace ID "${workspaceId}".`);
    }
    const trusted = { ...existing, trusted: true };
    await this.save({
      ...this.config,
      workspaces: this.config.workspaces.map((workspace) =>
        workspace.id === workspaceId ? trusted : workspace,
      ),
    });
    return trusted;
  }

  async setIncludeUserDefinitions(include: boolean): Promise<AppConfig> {
    if (typeof include !== 'boolean') {
      throw new TypeError('includeUserDefinitions must be a boolean.');
    }
    return this.save({ ...this.config, includeUserDefinitions: include });
  }

  /**
   * Rechecks the saved selection before preflight/discovery. A changed realpath
   * is treated as a different repository and must go through selection/trust.
   */
  async revalidateActiveWorkspace(): Promise<WorkspaceRecord> {
    const existing = this.activeWorkspace;
    if (existing === undefined) {
      throw new WorkspaceValidationError('missing', 'No active workspace is selected.');
    }

    const validation = await this.validateSelectedWorkspace(existing.selectedPath);
    if (
      pathIdentity(validation.canonicalPath, this.platform) !==
      pathIdentity(existing.canonicalPath, this.platform)
    ) {
      throw new WorkspaceValidationError(
        'canonical-path-changed',
        `Workspace now resolves to a different directory: ${existing.selectedPath}`,
      );
    }

    const refreshed: WorkspaceRecord = {
      ...existing,
      label: validation.label,
      selectedPath: validation.selectedPath,
      canonicalPath: validation.canonicalPath,
      lastValidatedAt: validation.validatedAt,
    };
    await this.save({
      ...this.config,
      workspaces: this.config.workspaces.map((workspace) =>
        workspace.id === existing.id ? refreshed : workspace,
      ),
    });
    return refreshed;
  }

  private retainAfterInvalidDisk(
    code: AppConfigDiagnosticCode,
    message: string,
  ): AppConfigLoad {
    this.lastDiagnostic = { code, file: this.file, message };
    this.blocked = true;
    return loadView(
      this.config,
      this.hasKnownGood ? 'last-known-good' : 'safe-default',
      this.lastDiagnostic,
      true,
    );
  }

  private newWorkspaceId(): WorkspaceId {
    const id = this.workspaceId();
    if (!isWorkspaceId(id)) {
      throw new Error('Workspace ID generator returned an invalid opaque ID.');
    }
    if (this.config.workspaces.some((workspace) => workspace.id === id)) {
      throw new Error('Workspace ID generator returned a duplicate opaque ID.');
    }
    return id;
  }
}
