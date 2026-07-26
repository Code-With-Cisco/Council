import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_CONFIG_FILENAME,
  AppConfigParseError,
  AppConfigStore,
  AppConfigWriteBlockedError,
  defaultAppConfig,
  parseAppConfig,
  validateWorkspaceDirectory,
} from '../src/config/appConfig.js';
import {
  writeJsonAtomic,
  type AtomicJsonFileSystem,
} from '../src/config/atomicJson.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `council-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('AppConfigStore', () => {
  it('returns first-run setup without writing a config or consulting process cwd', async () => {
    const userData = await temporaryRoot('first-run');
    const writeConfig = vi.fn();
    const store = new AppConfigStore(userData, { writeConfig });

    const loaded = await store.load();

    expect(loaded).toMatchObject({
      config: defaultAppConfig(),
      setupRequired: true,
      source: 'missing',
      diagnostic: undefined,
      writeBlocked: false,
    });
    expect(writeConfig).not.toHaveBeenCalled();
    expect(await readdir(userData)).toEqual([]);
  });

  it('persists an opaque, initially untrusted workspace with spaces and Unicode', async () => {
    const root = await temporaryRoot('unicode');
    const userData = path.join(root, 'user data');
    const workspace = path.join(root, 'projects', 'Méridian 工作 tree');
    await mkdir(workspace, { recursive: true });
    const firstId = 'ws_11111111-1111-4111-8111-111111111111';
    const now = new Date('2026-07-26T12:34:56.000Z');
    const store = new AppConfigStore(userData, {
      workspaceId: () => firstId,
      validateWorkspace: (selected) => validateWorkspaceDirectory(selected, { now: () => now }),
    });

    expect((await store.load()).source).toBe('missing');
    const selected = await store.selectWorkspace(workspace);

    expect(selected).toEqual({
      id: firstId,
      label: 'Méridian 工作 tree',
      selectedPath: path.normalize(workspace),
      canonicalPath: await realpath(workspace),
      lastValidatedAt: now.toISOString(),
      trusted: false,
    });

    const restarted = new AppConfigStore(userData);
    const loaded = await restarted.load();
    expect(loaded.source).toBe('disk');
    expect(loaded.setupRequired).toBe(false);
    expect(loaded.activeWorkspace).toEqual(selected);
    expect(loaded.config.includeUserDefinitions).toBe(true);
  });

  it('persists explicit trust and the user-definition preference separately', async () => {
    const root = await temporaryRoot('trust');
    const userData = path.join(root, 'userData');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const workspaceId = 'ws_22222222-2222-4222-8222-222222222222';
    const store = new AppConfigStore(userData, { workspaceId: () => workspaceId });
    await store.load();
    await store.selectWorkspace(workspace);

    const trusted = await store.confirmWorkspaceTrust(workspaceId);
    await store.setIncludeUserDefinitions(false);

    expect(trusted.trusted).toBe(true);
    const restarted = await new AppConfigStore(userData).load();
    expect(restarted.activeWorkspace?.trusted).toBe(true);
    expect(restarted.config.includeUserDefinitions).toBe(false);
  });

  it('treats canonical path casing as one workspace under Windows semantics', async () => {
    const userData = await temporaryRoot('windows-case');
    let canonicalPath = '/Projects/Council';
    const store = new AppConfigStore(userData, {
      platform: 'win32',
      workspaceId: () => 'ws_66666666-6666-4666-8666-666666666666',
      validateWorkspace: async (selectedPath) => ({
        selectedPath,
        canonicalPath,
        label: 'Council',
        validatedAt: '2026-07-26T00:00:00.000Z',
      }),
    });
    await store.load();
    const original = await store.selectWorkspace('/Projects/Council');
    await store.confirmWorkspaceTrust(original.id);
    canonicalPath = '/projects/council';

    const selectedAgain = await store.selectWorkspace('/projects/council');

    expect(selectedAgain.id).toBe(original.id);
    expect(selectedAgain.trusted).toBe(true);
    expect(store.current.workspaces).toHaveLength(1);
  });

  it('retains the last-known-good config and refuses to overwrite malformed bytes', async () => {
    const root = await temporaryRoot('malformed');
    const userData = path.join(root, 'userData');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const store = new AppConfigStore(userData, {
      workspaceId: () => 'ws_33333333-3333-4333-8333-333333333333',
    });
    await store.load();
    const selected = await store.selectWorkspace(workspace);
    const malformed = '{ "version": 1, definitely not JSON';
    await writeFile(path.join(userData, APP_CONFIG_FILENAME), malformed, 'utf8');

    await expect(store.setIncludeUserDefinitions(false)).rejects.toBeInstanceOf(
      AppConfigWriteBlockedError,
    );
    const reloaded = await store.reload();

    expect(reloaded.source).toBe('last-known-good');
    expect(reloaded.activeWorkspace).toEqual(selected);
    expect(reloaded.diagnostic?.code).toBe('invalid-json');
    expect(reloaded.writeBlocked).toBe(true);
    expect(await readFile(path.join(userData, APP_CONFIG_FILENAME), 'utf8')).toBe(malformed);
  });

  it('allows saving again only after an external repair reloads successfully', async () => {
    const root = await temporaryRoot('repair');
    const userData = path.join(root, 'userData');
    await mkdir(userData, { recursive: true });
    const configFile = path.join(userData, APP_CONFIG_FILENAME);
    await writeFile(configFile, '{bad', 'utf8');
    const store = new AppConfigStore(userData);
    expect((await store.load()).source).toBe('safe-default');
    await expect(store.save(defaultAppConfig())).rejects.toBeInstanceOf(
      AppConfigWriteBlockedError,
    );

    await writeFile(configFile, `${JSON.stringify(defaultAppConfig())}\n`, 'utf8');
    expect((await store.reload()).source).toBe('disk');
    await expect(store.setIncludeUserDefinitions(false)).resolves.toMatchObject({
      includeUserDefinitions: false,
    });
  });

  it('detects a deleted saved workspace during validation without discarding its record', async () => {
    const root = await temporaryRoot('deleted');
    const userData = path.join(root, 'userData');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const store = new AppConfigStore(userData, {
      workspaceId: () => 'ws_44444444-4444-4444-8444-444444444444',
    });
    await store.load();
    const selected = await store.selectWorkspace(workspace);
    await rm(workspace, { recursive: true });

    await expect(store.revalidateActiveWorkspace()).rejects.toMatchObject({
      code: 'missing',
    });
    expect(store.activeWorkspace).toEqual(selected);
  });
});

describe('workspace validation', () => {
  it('canonicalizes a portable directory symlink while retaining the selected path', async () => {
    const root = await temporaryRoot('symlink');
    const target = path.join(root, 'actual repository');
    const selected = path.join(root, 'selected repository');
    await mkdir(target, { recursive: true });
    try {
      await symlink(target, selected, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    const validated = await validateWorkspaceDirectory(selected);

    expect(validated.selectedPath).toBe(path.normalize(selected));
    expect(validated.canonicalPath).toBe(await realpath(target));
    expect(validated.label).toBe('actual repository');
  });

  it('rejects relative, missing, non-directory, and inaccessible selections specifically', async () => {
    const root = await temporaryRoot('invalid-workspace');
    const ordinaryFile = path.join(root, 'not-a-directory.txt');
    await writeFile(ordinaryFile, 'x', 'utf8');

    await expect(validateWorkspaceDirectory('relative/repository')).rejects.toMatchObject({
      code: 'path-not-absolute',
    });
    await expect(validateWorkspaceDirectory(path.join(root, 'missing'))).rejects.toMatchObject({
      code: 'missing',
    });
    await expect(validateWorkspaceDirectory(ordinaryFile)).rejects.toMatchObject({
      code: 'not-directory',
    });
    await expect(
      validateWorkspaceDirectory(root, {
        fileSystem: {
          stat: async () => ({ isDirectory: () => true }),
          access: async () => {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          },
          realpath: async (target) => target,
        },
      }),
    ).rejects.toMatchObject({ code: 'inaccessible' });
  });
});

describe('strict application config parsing', () => {
  it('rejects unsupported versions, missing required fields, and stray fields', () => {
    expect(() => parseAppConfig({ ...defaultAppConfig(), version: 2 })).toThrow(
      AppConfigParseError,
    );
    expect(() => {
      const { includeUserDefinitions: _omitted, ...missing } = defaultAppConfig();
      parseAppConfig(missing);
    }).toThrow(/includeUserDefinitions/);
    expect(() => parseAppConfig({ ...defaultAppConfig(), surprise: true })).toThrow(
      /unsupported field/,
    );
  });

  it('rejects relative workspace paths instead of resolving them against process cwd', () => {
    expect(() =>
      parseAppConfig({
        ...defaultAppConfig(),
        workspaces: [
          {
            id: 'ws_55555555-5555-4555-8555-555555555555',
            label: 'relative',
            selectedPath: 'relative/project',
            canonicalPath: 'relative/project',
            lastValidatedAt: '2026-07-26T00:00:00.000Z',
            trusted: false,
          },
        ],
      }),
    ).toThrow(/must be absolute/);
  });
});

describe('writeJsonAtomic', () => {
  it('preserves the prior file when rename is interrupted and cleans its unique temp file', async () => {
    const root = await temporaryRoot('atomic');
    const target = path.join(root, 'config.json');
    await writeFile(target, 'prior contents\n', 'utf8');
    const fileSystem: AtomicJsonFileSystem = {
      mkdir,
      writeFile,
      rename: async () => {
        throw new Error('simulated interruption before rename');
      },
      unlink,
    };

    await expect(
      writeJsonAtomic(target, { version: 1 }, { fileSystem, temporaryId: () => 'test-id' }),
    ).rejects.toThrow('simulated interruption');

    expect(await readFile(target, 'utf8')).toBe('prior contents\n');
    expect(await readdir(root)).toEqual(['config.json']);
  });

  it('uses rename as the final step for a successful write', async () => {
    const root = await temporaryRoot('atomic-success');
    const target = path.join(root, 'config.json');
    const renameSpy = vi.fn(rename);
    const fileSystem: AtomicJsonFileSystem = {
      mkdir,
      writeFile,
      rename: renameSpy,
      unlink,
    };

    await writeJsonAtomic(target, { ok: true }, { fileSystem });

    expect(renameSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ok: true });
    await expect(access(target)).resolves.toBeUndefined();
    expect((await stat(target)).isFile()).toBe(true);
  });
});
