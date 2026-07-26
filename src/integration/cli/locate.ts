/**
 * Finding the `claude` binary.
 *
 * A desktop app is not launched from the user's login shell, so PATH is often
 * missing the entries a terminal would have — on macOS a GUI process typically
 * gets `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Relying on PATH alone
 * strands users whose CLI came from nvm, Homebrew, or the VS Code extension, so
 * known install locations are probed directly.
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
 * versions; every command and JSON field used here was probed against 2.1.220.
 * Earlier versions are untested rather than known-broken.
 */
export const MINIMUM_CLAUDE_VERSION = '2.1.220';

const isWindows = process.platform === 'win32';
const BIN = isWindows ? 'claude.exe' : 'claude';

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
    await access(candidate, isWindows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Directories the CLI installs itself into, ordered by how current they tend to be. */
function wellKnownDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  if (isWindows) {
    const localAppData = env['LOCALAPPDATA'];
    const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')];
    if (localAppData !== undefined && localAppData !== '') {
      dirs.unshift(path.join(localAppData, 'Programs', 'claude'));
    }
    return dirs;
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
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

/** Extracts `2.1.220` from `2.1.220 (Claude Code)`. */
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
      bin: candidate.bin,
      version,
      meetsMinimum: version === undefined || compareVersions(version, MINIMUM_CLAUDE_VERSION) >= 0,
      discoveredVia: candidate.via,
    };
  }

  return null;
}
