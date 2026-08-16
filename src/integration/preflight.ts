import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { loadPty } from './pty/attach.js';
import { locateClaude, type LocateOptions, type LocatedCli } from './cli/locate.js';
import { generateGateConfig } from './gates/install.js';
import type { HooksConfig } from './hooks/generate.js';
import { parseDaemonStatus } from './parse/daemon.js';
import type { DaemonStatus } from './types.js';
import {
  runGuardSelfTest,
  type GuardSelfTestOptions,
  type GuardSelfTestResult,
} from './gates/selfTest.js';

export interface ExecutableStatus {
  readonly name: 'PowerShell' | 'Git Bash' | 'git' | 'node';
  readonly available: boolean;
  readonly executable: string | undefined;
  readonly version: string | undefined;
  readonly discoveredVia: 'candidate-probe' | 'process' | 'not-found';
}

export interface SupervisorPreflight {
  readonly status: DaemonStatus | undefined;
  readonly reachable: boolean;
  readonly versionMismatch: boolean;
  readonly diagnostic: string | undefined;
}

export interface LaunchPreflight {
  readonly checkedAt: string;
  readonly platform: NodeJS.Platform;
  readonly supportedPlatform: boolean;
  readonly claude: LocatedCli | null;
  readonly powershell: ExecutableStatus;
  readonly bash: ExecutableStatus;
  readonly git: ExecutableStatus;
  readonly node: ExecutableStatus;
  readonly guardSelfTest: GuardSelfTestResult;
  readonly supervisor: SupervisorPreflight;
  readonly hookConfig: HooksConfig;
  readonly ptyAvailable: boolean;
}

export interface LaunchPreflightOptions {
  readonly locate?: LocateOptions | undefined;
  readonly guard?: GuardSelfTestOptions | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

interface ProbeResult {
  readonly code: number | null;
  readonly output: string;
  readonly missing: boolean;
}

function probe(
  executable: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...argv], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let missing = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      missing = error.code === 'ENOENT';
    });
    child.on('close', (code) => resolve({ code, output: output.trim(), missing }));
  });
}

async function probeCandidates(
  name: ExecutableStatus['name'],
  candidates: readonly string[],
  versionArgs: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ExecutableStatus> {
  for (const executable of candidates) {
    const result = await probe(executable, versionArgs, env);
    if (result.missing) continue;
    return {
      name,
      available: result.code === 0,
      executable,
      version: result.output === '' ? undefined : result.output.split(/\r?\n/)[0],
      discoveredVia: 'candidate-probe',
    };
  }
  return {
    name,
    available: false,
    executable: undefined,
    version: undefined,
    discoveredVia: 'not-found',
  };
}

export async function runLaunchPreflight(
  projectDir: string,
  options: LaunchPreflightOptions = {},
): Promise<LaunchPreflight> {
  const env = { ...process.env, ...options.env };
  const [claude, powershell, bash, git, guardSelfTest, pty] = await Promise.all([
    locateClaude({ ...options.locate, env }),
    probeCandidates(
      'PowerShell',
      ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell'],
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      env,
    ),
    probeCandidates(
      'Git Bash',
      [
        ...(env['ProgramFiles']
          ? [path.join(env['ProgramFiles'], 'Git', 'bin', 'bash.exe')]
          : []),
        ...(env['LOCALAPPDATA']
          ? [path.join(env['LOCALAPPDATA'], 'Programs', 'Git', 'bin', 'bash.exe')]
          : []),
        'bash.exe',
        'bash',
      ],
      ['--version'],
      env,
    ),
    probeCandidates('git', ['git.exe', 'git'], ['--version'], env),
    runGuardSelfTest(projectDir, { ...options.guard, env }),
    loadPty(),
  ]);

  let supervisor: SupervisorPreflight = {
    status: undefined,
    reachable: false,
    versionMismatch: false,
    diagnostic: claude === null ? 'Claude CLI is unavailable, so supervisor status was not queried.' : undefined,
  };
  if (claude !== null) {
    const result = await probe(claude.bin, ['daemon', 'status'], env);
    const status = result.output === '' ? undefined : parseDaemonStatus(result.output);
    supervisor = {
      status,
      reachable: status?.controlSocketReachable === true,
      versionMismatch:
        status?.version !== undefined &&
        claude.version !== undefined &&
        status.version !== claude.version,
      diagnostic:
        result.missing
          ? 'Claude CLI disappeared before supervisor status could be queried.'
          : status === undefined
            ? 'Supervisor status returned no output.'
            : status.recognized
              ? undefined
              : 'Supervisor status used an unrecognized output shape; raw output is retained.',
    };
  }

  return {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    supportedPlatform: process.platform === 'win32',
    claude,
    powershell,
    bash,
    git,
    node: {
      name: 'node',
      available: true,
      executable: process.execPath,
      version: process.version,
      discoveredVia: 'process',
    },
    guardSelfTest,
    supervisor,
    hookConfig: generateGateConfig({ scriptLocation: 'source' }),
    ptyAvailable: pty !== null,
  };
}
