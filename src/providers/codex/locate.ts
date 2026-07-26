import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface LocatedCodex {
  readonly executable: string;
  readonly version: string | undefined;
  readonly discoveredVia: 'override' | 'path' | 'well-known' | 'chatgpt';
}

export interface CodexProbeResult {
  readonly ok: boolean;
  readonly output: string;
  readonly missing: boolean;
}

export interface LocateCodexOptions {
  readonly override?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly home?: string | undefined;
  readonly resourcesPath?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly probe?: ((executable: string) => Promise<CodexProbeResult>) | undefined;
  readonly exists?: ((candidate: string) => Promise<boolean>) | undefined;
}

const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

export function parseCodexVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}

export function probeCodexExecutable(
  executable: string,
): Promise<CodexProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, output: 'Codex version probe timed out.', missing: false });
    }, 10_000);
    timer.unref?.();
    const collect = (chunk: Buffer): void => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > MAX_VERSION_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        output: error.message,
        missing: error.code === 'ENOENT',
      });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8').trim();
      resolve({
        ok: code === 0 && !overflow,
        output: overflow ? 'Codex version output exceeded its safety bound.' : output,
        missing: false,
      });
    });
  });
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function npmNativeCandidates(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const packageNames =
    platform === 'win32'
      ? ['@openai/codex-win32-x64', '@openai/codex-win32-arm64']
      : platform === 'darwin'
        ? ['@openai/codex-darwin-arm64', '@openai/codex-darwin-x64']
        : ['@openai/codex-linux-x64', '@openai/codex-linux-arm64'];
  const npmRoots = [
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    path.join(home, '.local', 'lib', 'node_modules'),
  ];
  const appData = env['APPDATA'];
  if (appData !== undefined && appData !== '') {
    npmRoots.push(path.join(appData, 'npm', 'node_modules'));
  }
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates: string[] = [];
  for (const root of npmRoots) {
    for (const packageName of packageNames) {
      const packageRoot = path.join(
        root,
        '@openai',
        'codex',
        'node_modules',
        ...packageName.split('/'),
      );
      let architectures: string[] = [];
      try {
        architectures = await readdir(path.join(packageRoot, 'vendor'));
      } catch {
        // Optional native packages and layouts vary by release.
      }
      for (const architecture of architectures.sort()) {
        candidates.push(
          path.join(packageRoot, 'vendor', architecture, 'codex', executable),
        );
      }
    }
  }
  return candidates;
}

export async function locateCodex(
  options: LocateCodexOptions = {},
): Promise<LocatedCodex | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const probe = options.probe ?? probeCodexExecutable;
  const candidateExists = options.exists ?? exists;
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates: Array<{
    executable: string;
    via: LocatedCodex['discoveredVia'];
    requiresExistence: boolean;
  }> = [];
  if (options.override !== undefined && options.override.trim() !== '') {
    candidates.push({
      executable: path.resolve(options.override.trim()),
      via: 'override',
      requiresExistence: true,
    });
  }
  candidates.push({
    executable: binaryName,
    via: 'path',
    requiresExistence: false,
  });
  if (options.resourcesPath !== undefined) {
    candidates.push(
      {
        executable: path.join(options.resourcesPath, binaryName),
        via: 'chatgpt',
        requiresExistence: true,
      },
      {
        executable: path.join(
          options.resourcesPath,
          'app.asar.unpacked',
          binaryName,
        ),
        via: 'chatgpt',
        requiresExistence: true,
      },
    );
  }
  if (platform === 'darwin') {
    candidates.push({
      executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
      via: 'chatgpt',
      requiresExistence: true,
    });
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData !== '') {
      candidates.push(
        {
          executable: path.join(
            localAppData,
            'Programs',
            'ChatGPT',
            'resources',
            'codex.exe',
          ),
          via: 'chatgpt',
          requiresExistence: true,
        },
        {
          executable: path.join(
            localAppData,
            'OpenAI',
            'ChatGPT',
            'resources',
            'codex.exe',
          ),
          via: 'chatgpt',
          requiresExistence: true,
        },
      );
    }
  }
  candidates.push({
    executable: path.join(home, '.local', 'bin', binaryName),
    via: 'well-known',
    requiresExistence: true,
  });
  for (const executable of await npmNativeCandidates(home, env, platform)) {
    candidates.push({
      executable,
      via: 'well-known',
      requiresExistence: true,
    });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const identity =
      platform === 'win32'
        ? candidate.executable.toLocaleLowerCase('en-US')
        : candidate.executable;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (
      candidate.requiresExistence &&
      !(await candidateExists(candidate.executable))
    ) {
      continue;
    }
    const result = await probe(candidate.executable);
    if (!result.ok) {
      if (result.missing) continue;
      continue;
    }
    return {
      executable: candidate.executable,
      version: parseCodexVersion(result.output),
      discoveredVia: candidate.via,
    };
  }
  return null;
}
