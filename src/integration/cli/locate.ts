/**
 * Finding the `claude` binary.
 *
 * A desktop app can inherit a different PATH from the user's terminal.
 * Relying on PATH alone strands users whose CLI came from the native installer,
 * npm, or a VS Code-family extension, so known Windows locations are probed.
 */

import { readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { runClaude } from './exec.js';

/**
 * Lowest Claude Code version this app has been verified against.
 *
 * The agent-view CLI is a research preview whose surface changes between
 * versions; every command and JSON field used here was probed against 2.1.233 on
 * Windows. Earlier versions are untested rather than known-broken — though note
 * that `claude agents --json` does not exist at all as far back as 2.1.143, so
 * the roster is genuinely unreadable there rather than merely unverified.
 */
export const MINIMUM_CLAUDE_VERSION = '2.1.233';

const BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

export interface LocatedCli {
  readonly bin: string;
  readonly version: string | undefined;
  /** False when `version` is present and below MINIMUM_CLAUDE_VERSION. */
  readonly meetsMinimum: boolean;
  /** How the binary was found, for the diagnostics panel. */
  readonly discoveredVia: 'override' | 'path' | 'well-known' | 'vscode-extension';
}

export interface LocateOptions {
  /** Explicit path from app settings. Probed first and reported as `override`. */
  readonly override?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly home?: string | undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

/**
 * Converts a PATH-discovered command into a stable absolute executable path.
 * Native Windows PTY creation is less forgiving than child_process PATH lookup,
 * and desktop processes may later observe a different working directory.
 */
export async function resolvePathExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return executable;
  }
  const searchPath = environmentValue(env, 'PATH');
  if (searchPath === undefined) return executable;
  for (const rawDirectory of searchPath.split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (directory === '') continue;
    const candidate = path.resolve(directory, executable);
    if (await isExecutable(candidate)) return candidate;
  }
  return executable;
}

/** Directories the CLI installs itself into, ordered by how current they tend to be. */
function wellKnownDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')];
  const localAppData = env['LOCALAPPDATA'];
  if (localAppData !== undefined && localAppData !== '') {
    dirs.unshift(
      path.join(localAppData, 'Programs', 'claude'),
      path.join(localAppData, 'AnthropicClaude'),
    );
  }
  const appData = env['APPDATA'];
  if (appData !== undefined && appData !== '') {
    dirs.push(path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code'));
  }
  return dirs;
}

/**
 * The VS Code extension ships its own native binary and is frequently the only
 * copy on a machine that has never installed the standalone CLI. Multiple
 * extension versions coexist, so the highest is chosen.
 */
async function vscodeExtensionBinaries(home: string): Promise<string[]> {
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ];

  const found: { dir: string; version: string }[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(entry);
      if (match?.[1] === undefined) continue;
      found.push({
        dir: path.join(root, entry, 'resources', 'native-binary', BIN),
        version: match[1],
      });
    }
  }

  found.sort((a, b) => compareVersions(b.version, a.version));
  return found.map((f) => f.dir);
}

/** Semver-ish numeric compare. Returns >0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (Number.isNaN(na) || Number.isNaN(nb)) return 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Extracts `2.1.233` from `2.1.233 (Claude Code)`. */
export function parseVersion(raw: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(raw)?.[1];
}

/**
 * Locates the CLI and reads its version.
 *
 * Returns null only when no candidate exists at all — that is a first-class UI
 * state ("Claude Code not found"), not an error.
 */
export async function locateClaude(opts: LocateOptions = {}): Promise<LocatedCli | null> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  const candidates: { bin: string; via: LocatedCli['discoveredVia'] }[] = [];

  if (opts.override !== undefined && opts.override.trim() !== '') {
    candidates.push({ bin: opts.override.trim(), via: 'override' });
  }

  // Bare name first: if PATH does resolve it, that is the user's chosen copy.
  candidates.push({ bin: BIN, via: 'path' });

  for (const dir of wellKnownDirs(home, env)) {
    candidates.push({ bin: path.join(dir, BIN), via: 'well-known' });
  }
  for (const bin of await vscodeExtensionBinaries(home)) {
    candidates.push({ bin, via: 'vscode-extension' });
  }

  for (const candidate of candidates) {
    // The bare name has no path to stat; let the spawn attempt resolve it.
    if (candidate.via !== 'path' && !(await isExecutable(candidate.bin))) continue;

    const result = await runClaude(candidate.bin, ['--version'], { timeoutMs: 10_000 });
    if (!result.ok) {
      if (result.kind === 'cli-missing' || result.kind === 'spawn-failed') continue;
      // Reachable but unhappy: still the right binary, version simply unknown.
      return {
        bin: candidate.bin,
        version: undefined,
        meetsMinimum: true,
        discoveredVia: candidate.via,
      };
    }

    const version = parseVersion(result.value);
    return {
      bin:
        candidate.via === 'path'
          ? await resolvePathExecutable(candidate.bin, env)
          : candidate.bin,
      version,
      meetsMinimum: version === undefined || compareVersions(version, MINIMUM_CLAUDE_VERSION) >= 0,
      discoveredVia: candidate.via,
    };
  }

  return null;
}
