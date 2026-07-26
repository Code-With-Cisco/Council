/**
 * Installing the story gates into a project.
 *
 * The gate scripts live in this repo (scripts/gates/) and are copied into
 * `<project>/.claude/hooks/` by an explicit app action, then wired into
 * `<project>/.claude/settings.json`.
 *
 * Unlike the notification forwarders these hooks are synchronous and blocking —
 * that is their whole purpose. `async` would make exit code 2 meaningless.
 */

import { mkdir, readFile, writeFile, rename, chmod, copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectPaths } from '../paths.js';
import { mergeHookConfig, type HooksConfig } from '../hooks/generate.js';

export const GATE_BASH = 'story-gate.sh';
export const GATE_POWERSHELL = 'story-gate.ps1';

/** Identifies gate handlers so re-installing replaces rather than duplicates. */
export const GATE_MARKER = 'muster-story-gate';

/** Locates this repo's `scripts/gates` directory from the compiled module. */
export function bundledGatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/integration/gates -> repo root, and dist/... resolves the same way.
  return path.resolve(here, '..', '..', '..', 'scripts', 'gates');
}

/**
 * Builds the project hook config for the gates.
 *
 * Deliberately NOT async, and with a generous timeout: an acceptance command is
 * usually a test run, and killing it at the default would report a passing
 * story as a gate failure.
 */
export function generateGateConfig(projectDir: string, windows = process.platform === 'win32'): HooksConfig {
  const paths = new ProjectPaths(projectDir);
  const script = path.join(paths.gateScriptsDir(), windows ? GATE_POWERSHELL : GATE_BASH);

  const handler = (event: 'TaskCompleted' | 'TeammateIdle') => ({
    type: 'command' as const,
    command: script,
    args: [event],
    ...(windows ? { shell: 'powershell' as const } : {}),
    timeout: 600,
    statusMessage: GATE_MARKER,
  });

  return {
    TaskCompleted: [{ hooks: [handler('TaskCompleted')] }],
    TeammateIdle: [{ hooks: [handler('TeammateIdle')] }],
  };
}

export interface GateInstallPlan {
  readonly projectDir: string;
  readonly scriptTargets: readonly { from: string; to: string; mode: number }[];
  readonly settingsFile: string;
  readonly mergedSettings: Record<string, unknown>;
  readonly diffPreview: string;
}

export async function planGateInstall(projectDir: string): Promise<GateInstallPlan> {
  const paths = new ProjectPaths(projectDir);
  const source = bundledGatesDir();

  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.projectSettingsFile(), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) current = parsed as Record<string, unknown>;
  } catch {
    // Missing or unparseable: treated as empty here, and installGates refuses
    // to overwrite a file it could not parse.
  }

  const merged = mergeHookConfig(current, generateGateConfig(projectDir));

  return {
    projectDir,
    // Both dialects are installed so the project works for collaborators on
    // either OS — these files are checked into the project repo.
    scriptTargets: [
      {
        from: path.join(source, GATE_BASH),
        to: path.join(paths.gateScriptsDir(), GATE_BASH),
        mode: 0o755,
      },
      {
        from: path.join(source, GATE_POWERSHELL),
        to: path.join(paths.gateScriptsDir(), GATE_POWERSHELL),
        mode: 0o644,
      },
    ],
    settingsFile: paths.projectSettingsFile(),
    mergedSettings: merged,
    diffPreview: JSON.stringify({ hooks: merged['hooks'] }, null, 2),
  };
}

export async function installGates(plan: GateInstallPlan): Promise<{ written: readonly string[] }> {
  const written: string[] = [];

  for (const target of plan.scriptTargets) {
    await mkdir(path.dirname(target.to), { recursive: true });
    await copyFile(target.from, target.to);
    await chmod(target.to, target.mode).catch(() => undefined);
    written.push(target.to);
  }

  let existing: string | undefined;
  try {
    existing = await readFile(plan.settingsFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== undefined) {
    try {
      JSON.parse(existing);
    } catch {
      throw new Error(
        `${plan.settingsFile} is not valid JSON; refusing to overwrite it. Fix or move the file, then retry.`,
      );
    }
  }

  await mkdir(path.dirname(plan.settingsFile), { recursive: true });
  const temp = `${plan.settingsFile}.muster.tmp`;
  await writeFile(temp, `${JSON.stringify(plan.mergedSettings, null, 2)}\n`, 'utf8');
  await rename(temp, plan.settingsFile);
  written.push(plan.settingsFile);

  return { written };
}
