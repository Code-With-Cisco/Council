import { spawn } from 'node:child_process';
import { loadPty } from './pty/attach.js';
import { locateClaude, type LocateOptions, type LocatedCli } from './cli/locate.js';
import { generateGateConfig } from './gates/install.js';
import type { HooksConfig } from './hooks/generate.js';
import {
  runGuardSelfTest,
  type GuardSelfTestOptions,
  type GuardSelfTestResult,
} from './gates/selfTest.js';

export interface ExecutableStatus {
  readonly name: 'PowerShell' | 'git' | 'node';
  readonly available: boolean;
  readonly executable: string | undefined;
  readonly version: string | undefined;
  readonly discoveredVia: 'candidate-probe' | 'process' | 'not-found';
}

export interface LaunchPreflight {
  readonly checkedAt: string;
  readonly platform: NodeJS.Platform;
  readonly supportedPlatform: boolean;
  readonly claude: LocatedCli | null;
  readonly powershell: ExecutableStatus;
  readonly git: ExecutableStatus;
  readonly node: ExecutableStatus;
  readonly guardSelfTest: GuardSelfTestResult;
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
  const [claude, powershell, git, guardSelfTest, pty] = await Promise.all([
    locateClaude({ ...options.locate, env }),
    probeCandidates(
      'PowerShell',
      ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell'],
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      env,
    ),
    probeCandidates('git', ['git.exe', 'git'], ['--version'], env),
    runGuardSelfTest(projectDir, { ...options.guard, env }),
    loadPty(),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    supportedPlatform: process.platform === 'win32',
    claude,
    powershell,
    git,
    node: {
      name: 'node',
      available: true,
      executable: process.execPath,
      version: process.version,
      discoveredVia: 'process',
    },
    guardSelfTest,
    hookConfig: generateGateConfig({ scriptLocation: 'source' }),
    ptyAvailable: pty !== null,
  };
}
