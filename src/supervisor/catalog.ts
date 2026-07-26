/**
 * Resolved inventory of Claude agent definitions visible from one workspace.
 *
 * This module deliberately has no lifecycle or Electron dependency. Discovery
 * reads files and returns data; it never starts, stops, resumes, or otherwise
 * mutates a provider session.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

export type AgentDefinitionScope = 'project' | 'ancestor' | 'user';

export interface CatalogRoot {
  readonly path: string;
  readonly scope: AgentDefinitionScope;
  /** Zero is the selected workspace. Larger values have lower precedence. */
  readonly precedenceTier: number;
}

export type CatalogDiagnosticCode =
  | 'root-unreadable'
  | 'definition-unreadable'
  | 'missing-frontmatter'
  | 'malformed-frontmatter'
  | 'missing-name'
  | 'invalid-name'
  | 'invalid-metadata'
  | 'ambiguous-definition'
  | 'precedence-uncertain';

export interface CatalogDiagnostic {
  readonly id: string;
  readonly code: CatalogDiagnosticCode;
  readonly severity: 'error';
  readonly path: string;
  readonly message: string;
}

export type CatalogStringList = string | readonly string[];

/** Useful, launch-relevant metadata copied from definition frontmatter. */
export interface CatalogAgentMetadata {
  readonly model: string | undefined;
  readonly tools: CatalogStringList | undefined;
  readonly disallowedTools: CatalogStringList | undefined;
  readonly permissionMode: string | undefined;
  readonly maxTurns: number | undefined;
  readonly memory: string | undefined;
  readonly effort: string | undefined;
  readonly skills: readonly string[] | undefined;
}

export type CatalogAgentMode = 'normal' | 'internal';

/** One parseable definition file before precedence is resolved. */
export interface CatalogDefinitionSource {
  readonly name: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly definitionPath: string;
  readonly canonicalDefinitionPath: string;
  readonly rootPath: string;
  readonly scope: AgentDefinitionScope;
  readonly precedenceTier: number;
  readonly fingerprint: string;
  readonly metadata: CatalogAgentMetadata;
  readonly hidden: boolean;
  readonly mode: CatalogAgentMode;
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export type CatalogLaunchability =
  | {
      readonly launchable: true;
      readonly state: 'launchable';
      readonly message: undefined;
    }
  | {
      readonly launchable: false;
      readonly state: 'ambiguous' | 'malformed';
      readonly message: string;
    };

/**
 * One identity per exact frontmatter name in a workspace.
 *
 * Ambiguous entries intentionally have no selected `definitionPath`,
 * `fingerprint`, or effective metadata. The candidates are exposed without
 * allowing deterministic sorting to accidentally choose one.
 */
export interface ResolvedCatalogEntry {
  readonly catalogId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly launchCwd: string;
  readonly agentName: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly definitionPath: string | undefined;
  readonly canonicalDefinitionPath: string | undefined;
  readonly scope: AgentDefinitionScope | undefined;
  readonly precedenceTier: number | undefined;
  readonly fingerprint: string | undefined;
  readonly metadata: CatalogAgentMetadata | undefined;
  readonly hidden: boolean;
  readonly mode: CatalogAgentMode;
  readonly launchability: CatalogLaunchability;
  readonly ambiguousDefinitions: readonly CatalogDefinitionSource[];
  readonly shadowedDefinitions: readonly CatalogDefinitionSource[];
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export interface ResolvedAgentCatalog {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly includeUser: boolean;
  readonly roots: readonly CatalogRoot[];
  readonly entries: readonly ResolvedCatalogEntry[];
  readonly diagnostics: readonly CatalogDiagnostic[];
  /** SHA-256 over deterministic inventory state; timestamps are not included. */
  readonly revision: string;
}

export interface CatalogDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Injectable filesystem boundary. Tests can report EACCES portably on Windows,
 * where chmod-based unreadability fixtures are unreliable.
 */
export interface CatalogFileSystem {
  readDirectory(directory: string): Promise<readonly CatalogDirectoryEntry[]>;
  readBytes(file: string): Promise<Uint8Array>;
  canonicalPath(target: string): Promise<string>;
}

export interface ResolveAgentCatalogOptions {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly userAgentsDir?: string | undefined;
  readonly includeUser?: boolean | undefined;
  readonly fileSystem?: Partial<CatalogFileSystem> | undefined;
}

interface ScanResult {
  readonly definitions: CatalogDefinitionSource[];
  readonly diagnostics: CatalogDiagnostic[];
  /**
   * At least one possible definition in this tier could not be identified.
   * A lower/equal-tier candidate therefore cannot safely be selected.
   */
  readonly precedenceUncertain: boolean;
}

const EMPTY_METADATA: CatalogAgentMetadata = {
  model: undefined,
  tools: undefined,
  disallowedTools: undefined,
  permissionMode: undefined,
  maxTurns: undefined,
  memory: undefined,
  effort: undefined,
  skills: undefined,
};

const nodeFileSystem: CatalogFileSystem = {
  async readDirectory(directory) {
    return readdir(directory, { withFileTypes: true });
  },
  async readBytes(file) {
    return readFile(file);
  },
  async canonicalPath(target) {
    return realpath(target);
  },
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSources(a: CatalogDefinitionSource, b: CatalogDefinitionSource): number {
  return (
    a.precedenceTier - b.precedenceTier ||
    compareText(a.canonicalDefinitionPath, b.canonicalDefinitionPath) ||
    compareText(a.definitionPath, b.definitionPath)
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnostic(
  code: CatalogDiagnosticCode,
  target: string,
  message: string,
): CatalogDiagnostic {
  const id = createHash('sha256')
    .update(`${code}\0${target}\0${message}`, 'utf8')
    .digest('hex');
  return { id: `catalog-diagnostic_${id}`, code, severity: 'error', path: target, message };
}

function uniqueDiagnostics(values: readonly CatalogDiagnostic[]): CatalogDiagnostic[] {
  const unique = new Map<string, CatalogDiagnostic>();
  for (const value of values) unique.set(value.id, value);
  return [...unique.values()].sort(
    (a, b) =>
      compareText(a.path, b.path) ||
      compareText(a.code, b.code) ||
      compareText(a.message, b.message),
  );
}

function normalizeDefinitionText(bytes: Uint8Array): string {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** SHA-256 over BOM- and newline-normalized UTF-8 definition content. */
export function fingerprintAgentDefinition(bytes: Uint8Array): string {
  return createHash('sha256').update(normalizeDefinitionText(bytes), 'utf8').digest('hex');
}

/** Stable across content edits and source-precedence changes. */
export function stableCatalogId(workspaceId: string, exactAgentName: string): string {
  const digest = createHash('sha256')
    .update(`claude-code\0${workspaceId}\0${exactAgentName}`, 'utf8')
    .digest('hex');
  return `catalog_${digest}`;
}

function displayName(agentName: string): string {
  const acronyms = new Map([
    ['ai', 'AI'],
    ['llm', 'LLM'],
    ['prd', 'PRD'],
    ['qa', 'QA'],
    ['ui', 'UI'],
  ]);
  return agentName
    .split(/[-_\s]+/)
    .filter((part) => part !== '')
    .map(
      (part) =>
        acronyms.get(part.toLowerCase()) ??
        `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`,
    )
    .join(' ');
}

/**
 * Builds precedence roots without touching disk.
 *
 * The caller supplies the canonical workspace when available. User scope is
 * appended after every project/ancestor tier and may be disabled explicitly.
 */
export function catalogRootsForWorkspace(
  workspaceRoot: string,
  userAgentsDir?: string | undefined,
  includeUser = true,
): CatalogRoot[] {
  let roots: CatalogRoot[] = [];
  let current = path.resolve(workspaceRoot);
  let tier = 0;
  for (;;) {
    roots.push({
      path: path.join(current, '.claude', 'agents'),
      scope: tier === 0 ? 'project' : 'ancestor',
      precedenceTier: tier,
    });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    tier += 1;
  }

  if (userAgentsDir !== undefined) {
    const resolvedUserRoot = path.resolve(userAgentsDir);
    const identity = (value: string): string => {
      const normalized = path.normalize(value);
      return process.platform === 'win32'
        ? normalized.toLocaleLowerCase('en-US')
        : normalized;
    };
    // A workspace beneath the home directory naturally encounters
    // ~/.claude/agents during ancestor traversal. It is still user scope, not
    // an ancestor override, and disabling user definitions must really remove
    // it rather than scanning the same directory through another label.
    roots = roots.filter(
      (root) => identity(root.path) !== identity(resolvedUserRoot),
    );
    if (!includeUser) return roots;
    roots.push({
      path: resolvedUserRoot,
      scope: 'user',
      precedenceTier:
        Math.max(-1, ...roots.map((root) => root.precedenceTier)) + 1,
    });
  }
  return roots;
}

function frontmatterBlock(text: string): string | undefined {
  const match = /^---[ \t]*\n([\s\S]*?)\n---(?:[ \t]*\n|[ \t]*$)/.exec(text);
  return match?.[1];
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  file: string,
  problems: CatalogDiagnostic[],
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  problems.push(
    diagnostic('invalid-metadata', file, `Frontmatter "${key}" must be a string.`),
  );
  return undefined;
}

function optionalStringList(
  record: Readonly<Record<string, unknown>>,
  key: string,
  file: string,
  problems: CatalogDiagnostic[],
): CatalogStringList | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return [...value] as string[];
  }
  problems.push(
    diagnostic(
      'invalid-metadata',
      file,
      `Frontmatter "${key}" must be a string or an array of strings.`,
    ),
  );
  return undefined;
}

function parseMetadata(
  record: Readonly<Record<string, unknown>>,
  file: string,
  problems: CatalogDiagnostic[],
): {
  label: string | undefined;
  description: string | undefined;
  metadata: CatalogAgentMetadata;
  hidden: boolean;
  mode: CatalogAgentMode;
} {
  const model = optionalString(record, 'model', file, problems);
  const tools = optionalStringList(record, 'tools', file, problems);
  const disallowedTools = optionalStringList(record, 'disallowedTools', file, problems);
  const permissionMode = optionalString(record, 'permissionMode', file, problems);
  const memory = optionalString(record, 'memory', file, problems);
  const effort = optionalString(record, 'effort', file, problems);
  const label = optionalString(record, 'label', file, problems);
  const description = optionalString(record, 'description', file, problems);

  let maxTurns: number | undefined;
  const rawMaxTurns = record['maxTurns'];
  if (rawMaxTurns !== undefined) {
    if (
      typeof rawMaxTurns === 'number' &&
      Number.isInteger(rawMaxTurns) &&
      rawMaxTurns > 0
    ) {
      maxTurns = rawMaxTurns;
    } else {
      problems.push(
        diagnostic(
          'invalid-metadata',
          file,
          'Frontmatter "maxTurns" must be a positive integer.',
        ),
      );
    }
  }

  let skills: readonly string[] | undefined;
  const rawSkills = record['skills'];
  if (rawSkills !== undefined) {
    if (Array.isArray(rawSkills) && rawSkills.every((entry) => typeof entry === 'string')) {
      skills = [...rawSkills] as string[];
    } else {
      problems.push(
        diagnostic(
          'invalid-metadata',
          file,
          'Frontmatter "skills" must be an array of strings.',
        ),
      );
    }
  }

  let hidden = false;
  const rawHidden = record['hidden'];
  if (rawHidden !== undefined) {
    if (typeof rawHidden === 'boolean') hidden = rawHidden;
    else {
      problems.push(
        diagnostic('invalid-metadata', file, 'Frontmatter "hidden" must be a boolean.'),
      );
    }
  }

  let mode: CatalogAgentMode = 'normal';
  const rawMode = record['mode'];
  if (rawMode !== undefined) {
    if (rawMode === 'normal' || rawMode === 'internal') mode = rawMode;
    else {
      problems.push(
        diagnostic(
          'invalid-metadata',
          file,
          'Frontmatter "mode" must be "normal" or "internal".',
        ),
      );
    }
  }

  return {
    label,
    description,
    metadata: {
      model,
      tools,
      disallowedTools,
      permissionMode,
      maxTurns,
      memory,
      effort,
      skills,
    },
    hidden,
    mode,
  };
}

async function readDefinition(
  file: string,
  root: CatalogRoot,
  fileSystem: CatalogFileSystem,
): Promise<
  | { readonly definition: CatalogDefinitionSource; readonly diagnostics: CatalogDiagnostic[] }
  | { readonly definition: undefined; readonly diagnostics: CatalogDiagnostic[] }
> {
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readBytes(file);
  } catch (error) {
    return {
      definition: undefined,
      diagnostics: [
        diagnostic(
          'definition-unreadable',
          file,
          `Could not read agent definition: ${errorMessage(error)}`,
        ),
      ],
    };
  }

  let text: string;
  let fingerprint: string;
  try {
    text = normalizeDefinitionText(bytes);
    fingerprint = fingerprintAgentDefinition(bytes);
  } catch (error) {
    return {
      definition: undefined,
      diagnostics: [
        diagnostic(
          'malformed-frontmatter',
          file,
          `Agent definition is not valid UTF-8: ${errorMessage(error)}`,
        ),
      ],
    };
  }

  const yaml = frontmatterBlock(text);
  if (yaml === undefined) {
    return {
      definition: undefined,
      diagnostics: [
        diagnostic(
          'missing-frontmatter',
          file,
          'Agent definition has no complete YAML frontmatter block.',
        ),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (error) {
    return {
      definition: undefined,
      diagnostics: [
        diagnostic(
          'malformed-frontmatter',
          file,
          `Agent definition frontmatter is invalid YAML: ${errorMessage(error)}`,
        ),
      ],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      definition: undefined,
      diagnostics: [
        diagnostic(
          'malformed-frontmatter',
          file,
          'Agent definition frontmatter must be a YAML mapping.',
        ),
      ],
    };
  }

  const record = parsed as Record<string, unknown>;
  const rawName = record['name'];
  if (rawName === undefined) {
    return {
      definition: undefined,
      diagnostics: [
        diagnostic('missing-name', file, 'Agent definition frontmatter has no "name".'),
      ],
    };
  }
  if (
    typeof rawName !== 'string' ||
    rawName === '' ||
    rawName !== rawName.trim() ||
    /[\u0000-\u001f\u007f]/.test(rawName)
  ) {
    return {
      definition: undefined,
      diagnostics: [
        diagnostic(
          'invalid-name',
          file,
          'Agent definition "name" must be a non-empty string without surrounding whitespace or control characters.',
        ),
      ],
    };
  }

  const metadataProblems: CatalogDiagnostic[] = [];
  const values = parseMetadata(record, file, metadataProblems);
  let canonicalDefinitionPath: string;
  try {
    canonicalDefinitionPath = await fileSystem.canonicalPath(file);
  } catch {
    // The file was readable, so a concurrent rename or a platform without
    // reliable realpath should not erase its diagnostic/inventory record.
    canonicalDefinitionPath = path.resolve(file);
  }

  const definition: CatalogDefinitionSource = {
    name: rawName,
    label:
      values.label === undefined || values.label.trim() === ''
        ? displayName(rawName)
        : values.label,
    description: values.description,
    definitionPath: path.resolve(file),
    canonicalDefinitionPath,
    rootPath: root.path,
    scope: root.scope,
    precedenceTier: root.precedenceTier,
    fingerprint,
    metadata: values.metadata,
    hidden: values.hidden,
    mode: values.mode,
    diagnostics: metadataProblems,
  };
  return { definition, diagnostics: metadataProblems };
}

async function scanRoot(
  root: CatalogRoot,
  fileSystem: CatalogFileSystem,
): Promise<ScanResult> {
  const definitions: CatalogDefinitionSource[] = [];
  const diagnostics: CatalogDiagnostic[] = [];
  let precedenceUncertain = false;

  const walk = async (directory: string): Promise<void> => {
    let entries: readonly CatalogDirectoryEntry[];
    try {
      entries = await fileSystem.readDirectory(directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      precedenceUncertain = true;
      diagnostics.push(
        diagnostic(
          'root-unreadable',
          directory,
          `Could not enumerate agent-definition directory: ${errorMessage(error)}`,
        ),
      );
      return;
    }

    const sorted = [...entries].sort((a, b) => compareText(a.name, b.name));
    for (const entry of sorted) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const result = await readDefinition(target, root, fileSystem);
        diagnostics.push(...result.diagnostics);
        if (result.definition !== undefined) {
          definitions.push(result.definition);
        } else {
          // The unreadable/malformed file may have declared any agent name.
          // Falling through to a lower-precedence definition would silently
          // guess at precedence, so block those launches until this tier is
          // readable again.
          precedenceUncertain = true;
        }
      }
    }
  };

  await walk(root.path);
  return { definitions, diagnostics, precedenceUncertain };
}

function emptyMetadataForRevision(
  metadata: CatalogAgentMetadata | undefined,
): CatalogAgentMetadata {
  return metadata ?? EMPTY_METADATA;
}

function catalogRevision(
  roots: readonly CatalogRoot[],
  entries: readonly ResolvedCatalogEntry[],
  diagnostics: readonly CatalogDiagnostic[],
): string {
  const state = {
    roots,
    entries: entries.map((entry) => ({
      catalogId: entry.catalogId,
      agentName: entry.agentName,
      definitionPath: entry.definitionPath,
      scope: entry.scope,
      precedenceTier: entry.precedenceTier,
      fingerprint: entry.fingerprint,
      metadata: emptyMetadataForRevision(entry.metadata),
      hidden: entry.hidden,
      mode: entry.mode,
      launchability: entry.launchability,
      ambiguous: entry.ambiguousDefinitions.map((source) => ({
        path: source.canonicalDefinitionPath,
        tier: source.precedenceTier,
        fingerprint: source.fingerprint,
        diagnostics: source.diagnostics.map((problem) => problem.id),
      })),
      shadowed: entry.shadowedDefinitions.map((source) => ({
        path: source.canonicalDefinitionPath,
        tier: source.precedenceTier,
        fingerprint: source.fingerprint,
        diagnostics: source.diagnostics.map((problem) => problem.id),
      })),
    })),
    diagnostics: diagnostics.map((problem) => problem.id),
  };
  return createHash('sha256').update(JSON.stringify(state), 'utf8').digest('hex');
}

function effectiveEntry(
  workspaceId: string,
  workspaceRoot: string,
  winner: CatalogDefinitionSource,
  shadowed: readonly CatalogDefinitionSource[],
  precedenceProblems: readonly CatalogDiagnostic[] = [],
): ResolvedCatalogEntry {
  const malformed = winner.diagnostics.length > 0;
  const precedenceUncertain = precedenceProblems.length > 0;
  return {
    catalogId: stableCatalogId(workspaceId, winner.name),
    workspaceId,
    workspaceRoot,
    launchCwd: workspaceRoot,
    agentName: winner.name,
    label: winner.label,
    description: winner.description,
    definitionPath: winner.definitionPath,
    canonicalDefinitionPath: winner.canonicalDefinitionPath,
    scope: winner.scope,
    precedenceTier: winner.precedenceTier,
    fingerprint: winner.fingerprint,
    metadata: winner.metadata,
    hidden: winner.hidden,
    mode: winner.mode,
    launchability: precedenceUncertain
      ? {
          launchable: false,
          state: 'malformed',
          message: precedenceProblems[0]?.message ??
            `Definition precedence for "${winner.name}" could not be verified.`,
        }
      : malformed
      ? {
          launchable: false,
          state: 'malformed',
          message: `The effective definition for "${winner.name}" has invalid frontmatter metadata.`,
        }
      : { launchable: true, state: 'launchable', message: undefined },
    ambiguousDefinitions: [],
    shadowedDefinitions: shadowed,
    diagnostics: [...winner.diagnostics, ...precedenceProblems],
  };
}

function ambiguousEntry(
  workspaceId: string,
  workspaceRoot: string,
  name: string,
  candidates: readonly CatalogDefinitionSource[],
  shadowed: readonly CatalogDefinitionSource[],
  precedenceProblems: readonly CatalogDiagnostic[] = [],
): ResolvedCatalogEntry {
  const conflictPath = candidates[0]?.rootPath ?? workspaceRoot;
  const problem = diagnostic(
    'ambiguous-definition',
    conflictPath,
    `Multiple definitions named "${name}" exist at precedence tier ${candidates[0]?.precedenceTier ?? 0}; none was selected.`,
  );
  return {
    catalogId: stableCatalogId(workspaceId, name),
    workspaceId,
    workspaceRoot,
    launchCwd: workspaceRoot,
    agentName: name,
    label: displayName(name),
    description: undefined,
    definitionPath: undefined,
    canonicalDefinitionPath: undefined,
    scope: candidates[0]?.scope,
    precedenceTier: candidates[0]?.precedenceTier,
    fingerprint: undefined,
    metadata: undefined,
    hidden: false,
    mode: 'normal',
    launchability: {
      launchable: false,
      state: 'ambiguous',
      message: problem.message,
    },
    ambiguousDefinitions: candidates,
    shadowedDefinitions: shadowed,
    diagnostics: [problem, ...precedenceProblems],
  };
}

function uncertainPrecedenceProblem(
  name: string,
  uncertainRoots: readonly CatalogRoot[],
): CatalogDiagnostic | undefined {
  if (uncertainRoots.length === 0) return undefined;
  const tiers = [...new Set(uncertainRoots.map((root) => root.precedenceTier))]
    .sort((a, b) => a - b)
    .join(', ');
  const first = uncertainRoots[0];
  if (first === undefined) return undefined;
  return diagnostic(
    'precedence-uncertain',
    first.path,
    `Definition "${name}" cannot launch because agent-definition precedence is unreadable or malformed at tier${tiers.includes(',') ? 's' : ''} ${tiers}.`,
  );
}

/** Resolves effective definitions without performing any provider action. */
export async function resolveAgentCatalog(
  options: ResolveAgentCatalogOptions,
): Promise<ResolvedAgentCatalog> {
  if (options.workspaceId.trim() === '') {
    throw new Error('resolveAgentCatalog() requires a non-empty workspaceId');
  }
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const includeUser = options.includeUser ?? true;
  const roots = catalogRootsForWorkspace(
    workspaceRoot,
    options.userAgentsDir,
    includeUser,
  );
  const fileSystem: CatalogFileSystem = {
    ...nodeFileSystem,
    ...options.fileSystem,
  };

  const scans = await Promise.all(roots.map((root) => scanRoot(root, fileSystem)));
  const diagnostics = scans.flatMap((scan) => scan.diagnostics);
  const orderedDefinitions = scans
    .flatMap((scan) => scan.definitions)
    .sort(compareSources);

  // The same physical file can be reachable through overlapping configured
  // roots. Preserve its highest-precedence occurrence instead of inventing a
  // same-tier conflict.
  const uniqueSources = new Map<string, CatalogDefinitionSource>();
  for (const source of orderedDefinitions) {
    if (!uniqueSources.has(source.canonicalDefinitionPath)) {
      uniqueSources.set(source.canonicalDefinitionPath, source);
    }
  }

  const byName = new Map<string, CatalogDefinitionSource[]>();
  for (const source of uniqueSources.values()) {
    const group = byName.get(source.name) ?? [];
    group.push(source);
    byName.set(source.name, group);
  }

  const entries: ResolvedCatalogEntry[] = [];
  for (const name of [...byName.keys()].sort(compareText)) {
    const candidates = (byName.get(name) ?? []).sort(compareSources);
    const winningTier = candidates[0]?.precedenceTier;
    if (winningTier === undefined) continue;
    const winners = candidates.filter(
      (candidate) => candidate.precedenceTier === winningTier,
    );
    const shadowed = candidates.filter(
      (candidate) => candidate.precedenceTier > winningTier,
    );
    const uncertainRoots = roots.filter(
      (root, index) =>
        root.precedenceTier <= winningTier &&
        scans[index]?.precedenceUncertain === true,
    );
    const precedenceProblem = uncertainPrecedenceProblem(name, uncertainRoots);
    const precedenceProblems =
      precedenceProblem === undefined ? [] : [precedenceProblem];
    const entry =
      winners.length === 1 && winners[0] !== undefined
        ? effectiveEntry(
            workspaceIdOrThrow(options.workspaceId),
            workspaceRoot,
            winners[0],
            shadowed,
            precedenceProblems,
          )
        : ambiguousEntry(
            workspaceIdOrThrow(options.workspaceId),
            workspaceRoot,
            name,
            winners,
            shadowed,
            precedenceProblems,
          );
    entries.push(entry);
    diagnostics.push(...entry.diagnostics);
  }

  const catalogDiagnostics = uniqueDiagnostics(diagnostics);
  return {
    workspaceId: options.workspaceId,
    workspaceRoot,
    includeUser,
    roots,
    entries,
    diagnostics: catalogDiagnostics,
    revision: catalogRevision(roots, entries, catalogDiagnostics),
  };
}

function workspaceIdOrThrow(workspaceId: string): string {
  // Kept as a separate boundary so catalog IDs always use the exact persisted
  // opaque ID after the public non-empty check.
  if (workspaceId.trim() === '') throw new Error('workspaceId cannot be empty');
  return workspaceId;
}
