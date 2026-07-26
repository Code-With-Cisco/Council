import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { bundledGatesDir } from './install.js';

export type GuardSelfTestStatus = 'passed' | 'failed' | 'unavailable';

export interface GuardSelfTestResult {
  readonly status: GuardSelfTestStatus;
  readonly interpreter: string | undefined;
  readonly message: string;
  readonly output: string;
}

export interface GuardSelfTestOptions {
  readonly interpreterCandidates?: readonly string[] | undefined;
  readonly scriptsDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError: NodeJS.ErrnoException | undefined;
}

function run(
  executable: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...argv], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnError: NodeJS.ErrnoException | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr, spawnError }));
  });
}

export async function runGuardSelfTest(
  projectDir: string,
  options: GuardSelfTestOptions = {},
): Promise<GuardSelfTestResult> {
  const scriptsDir = options.scriptsDir ?? bundledGatesDir();
  const script = path.join(scriptsDir, 'guard-self-test.ps1');
  try {
    await access(script);
  } catch {
    return {
      status: 'failed',
      interpreter: undefined,
      message: `Guard self-test script is missing: ${script}`,
      output: '',
    };
  }

  const candidates = options.interpreterCandidates ?? ['pwsh.exe', 'powershell.exe', 'pwsh'];
  const env = { ...process.env, ...options.env, CLAUDE_PROJECT_DIR: projectDir };

  for (const interpreter of candidates) {
    const result = await run(
      interpreter,
      ['-NoProfile', '-NonInteractive', '-File', script, '-ProjectDir', projectDir],
      env,
    );
    if (result.spawnError?.code === 'ENOENT') continue;

    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    if (result.spawnError !== undefined) {
      return {
        status: 'failed',
        interpreter,
        message: result.spawnError.message,
        output,
      };
    }
    if (result.code === 0) {
      return {
        status: 'passed',
        interpreter,
        message: 'PowerShell guards blocked both canary payloads.',
        output,
      };
    }
    return {
      status: 'failed',
      interpreter,
      message: `Guard self-test exited ${result.code ?? 'without a code'}.`,
      output,
    };
  }

  return {
    status: 'unavailable',
    interpreter: undefined,
    message: 'Neither PowerShell 7 (pwsh.exe) nor Windows PowerShell (powershell.exe) was found.',
    output: '',
  };
}
