/**
 * Installing Decagram Council's Windows-only PowerShell guards into a project.
 *
 * Scripts are copied into `<project>/.claude/hooks/` by an explicit app action.
 * Hook registration is generated rather than hand-authored so the write,
 * shell, and story gates stay one coherent unit.
 */

import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectPaths } from '../paths.js';
import { mergeHookConfig, type CommandHookHandler, type HooksConfig } from '../hooks/generate.js';

export const GATE_POWERSHELL = 'story-gate.ps1';
export const WRITE_DISPATCH_POWERSHELL = 'agent-write-dispatch.ps1';
export const SHELL_DISPATCH_POWERSHELL = 'agent-shell-dispatch.ps1';

export const POWERSHELL_GUARD_FILES = [
  '_guard-lib.ps1',
  WRITE_DISPATCH_POWERSHELL,
  SHELL_DISPATCH_POWERSHELL,
  'builder-write-guard.ps1',
  'test-engineer-write-guard.ps1',
  'prd-lead-write-guard.ps1',
  'guard-self-test.ps1',
  GATE_POWERSHELL,
] as const;

/** Identifies handlers so re-installing replaces rather than duplicates. */
export const GATE_MARKER = 'decagram-council-story-gate';

export type GateScriptLocation = 'installed' | 'source';

export interface GenerateGateOptions {
  /**
   * `installed` targets `.claude/hooks` in an app-managed project.
   * `source` targets this repository's checked-in `scripts/gates` directory.
   */
  readonly scriptLocation?: GateScriptLocation | undefined;
}

/** Locates this repo's checked-in PowerShell scripts. */
export function bundledGatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'scripts', 'gates');
}

function powershellCommand(
  filename: string,
  args: readonly string[],
  location: GateScriptLocation,
): string {
  const directory = location === 'source' ? 'scripts/gates' : '.claude/hooks';
  const script = `\${CLAUDE_PROJECT_DIR}/${directory}/${filename}`;
  const quotedArgs = args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(' ');
  return `& "${script}"${quotedArgs === '' ? '' : ` ${quotedArgs}`}`;
}

function handler(
  filename: string,
  args: readonly string[],
  location: GateScriptLocation,
  statusMessage = GATE_MARKER,
): CommandHookHandler {
  return {
    type: 'command',
    command: powershellCommand(filename, args, location),
    shell: 'powershell',
    timeout: filename === GATE_POWERSHELL ? 600 : 30,
    statusMessage,
  };
}

/**
 * Builds all enforcement hooks for a Windows host.
 *
 * Shell form is deliberate. Claude Code ignores `shell: "powershell"` when
 * `args` is present, and Windows cannot spawn a `.ps1` file directly.
 */
export function generateGateConfig(options: GenerateGateOptions = {}): HooksConfig {
  const location = options.scriptLocation ?? 'installed';

  return {
    PreToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          handler(
            WRITE_DISPATCH_POWERSHELL,
            [],
            location,
            'decagram-council-write-guard',
          ),
        ],
      },
      {
        matcher: 'PowerShell',
        hooks: [
          handler(
            SHELL_DISPATCH_POWERSHELL,
            [],
            location,
            'decagram-council-shell-guard',
          ),
        ],
      },
    ],
    TaskCompleted: [
      { hooks: [handler(GATE_POWERSHELL, ['TaskCompleted'], location)] },
    ],
    TeammateIdle: [
      { hooks: [handler(GATE_POWERSHELL, ['TeammateIdle'], location)] },
    ],
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
    // Missing or unparseable is treated as empty for planning. installGates
    // still refuses to overwrite an existing file it cannot parse.
  }

  const merged = mergeHookConfig(current, generateGateConfig());

  return {
    projectDir,
    scriptTargets: POWERSHELL_GUARD_FILES.map((filename) => ({
      from: path.join(source, filename),
      to: path.join(paths.gateScriptsDir(), filename),
      mode: 0o644,
    })),
    settingsFile: paths.projectSettingsFile(),
    mergedSettings: merged,
    diffPreview: JSON.stringify({ hooks: merged['hooks'] }, null, 2),
  };
}

export async function installGates(
  plan: GateInstallPlan,
): Promise<{ written: readonly string[] }> {
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
  const temp = `${plan.settingsFile}.decagram.tmp`;
  await writeFile(temp, `${JSON.stringify(plan.mergedSettings, null, 2)}\n`, 'utf8');
  await rename(temp, plan.settingsFile);
  written.push(plan.settingsFile);

  return { written };
}
