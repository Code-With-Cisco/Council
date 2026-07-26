import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RosterConfigStore,
  parseRosterConfig,
  saveRosterConfig,
} from '../src/integration/roster/config.js';
import { MAX_PROFILE_ID_LENGTH } from '../src/profileIdentity.js';

const roots: string[] = [];

async function tempFile(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'council-profiles-'));
  roots.push(root);
  return path.join(root, 'roster.json');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('versioned profile preferences', () => {
  it('does not create a v2 file merely because missing preferences were opened', async () => {
    const file = await tempFile();
    const store = new RosterConfigStore(file, '/work/project', 'ws_workspace1');

    const loaded = await store.load();

    expect(loaded.source).toBe('missing');
    expect(loaded.createdDefault).toBe(false);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('normalizes v1 to stable opaque IDs without rewriting on open', async () => {
    const file = await tempFile();
    const source = `${JSON.stringify({
      version: 1,
      members: [{ key: 'builder-main', label: 'Builder', agent: 'builder', cwd: '.' }],
      pollIntervalMs: 10_000,
    }, null, 2)}\n`;
    await writeFile(file, source, 'utf8');
    const before = await stat(file);

    const first = new RosterConfigStore(file, '/work/project', 'ws_workspace1');
    const loaded = await first.load();
    const second = new RosterConfigStore(file, '/work/project', 'ws_workspace1');
    const reloaded = await second.load();

    expect(loaded.config.version).toBe(1);
    expect(loaded.config.members[0]?.key).toMatch(/^profile-v1-/);
    expect(reloaded.config.members[0]?.key).toBe(loaded.config.members[0]?.key);
    expect(await readFile(file, 'utf8')).toBe(source);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('round-trips every required v2 profile field and defaults autoStart false', async () => {
    const file = await tempFile();
    const parsed = parseRosterConfig(
      {
        version: 2,
        profiles: [
          {
            id: 'profile-configured123',
            workspaceId: 'ws_workspace1',
            catalogId: 'catalog_builder',
            agentName: 'builder',
            label: 'Forge',
            order: 3,
            visible: false,
            mode: 'internal',
            bootPrompt: 'Wait.',
            model: 'sonnet',
            effort: 'high',
          },
        ],
        pollIntervalMs: 5_000,
      },
      { version: 2, members: [], pollIntervalMs: 10_000 },
      '/work/project',
      'ws_workspace1',
    );
    expect(parsed.config.members[0]).toMatchObject({
      key: 'profile-configured123',
      workspaceId: 'ws_workspace1',
      catalogId: 'catalog_builder',
      agent: 'builder',
      label: 'Forge',
      order: 3,
      visible: false,
      mode: 'internal',
      autoStart: false,
    });
    await saveRosterConfig(file, parsed.config);
    const restarted = await new RosterConfigStore(
      file,
      '/work/project',
      'ws_workspace1',
    ).load();
    expect(restarted.config).toEqual(parsed.config);
  });

  it('rejects a v2 profile id that the IPC boundary cannot route', () => {
    const atLimit = `profile-${'a'.repeat(
      MAX_PROFILE_ID_LENGTH - 'profile-'.length,
    )}`;
    const fallback = {
      version: 2 as const,
      members: [],
      pollIntervalMs: 10_000,
    };
    const profile = (id: string) => ({
      version: 2,
      profiles: [
        {
          id,
          workspaceId: 'ws_workspace1',
          catalogId: 'catalog_builder',
          agentName: 'builder',
        },
      ],
      pollIntervalMs: 10_000,
    });

    expect(
      parseRosterConfig(
        profile(atLimit),
        fallback,
        '/work/project',
        'ws_workspace1',
      ).config.members,
    ).toHaveLength(1);

    const rejected = parseRosterConfig(
      profile(`${atLimit}a`),
      fallback,
      '/work/project',
      'ws_workspace1',
    );
    expect(rejected.config).toBe(fallback);
    expect(rejected.problems.join(' ')).toContain('invalid opaque "id"');
  });

  it.each(['virtual', 'internal'] as const)(
    'rejects the reserved generated %s profile namespace in v2 preferences',
    (kind) => {
      const fallback = {
        version: 2 as const,
        members: [],
        pollIntervalMs: 10_000,
      };
      const id = `profile-${kind}-12345678`;

      const rejected = parseRosterConfig(
        {
          version: 2,
          profiles: [
            {
              id,
              workspaceId: 'ws_workspace1',
              catalogId: 'catalog_builder',
              agentName: 'builder',
            },
          ],
          pollIntervalMs: 10_000,
        },
        fallback,
        '/work/project',
        'ws_workspace1',
      );

      expect(rejected.config).toBe(fallback);
      expect(rejected.problems.join(' ')).toContain(
        `reserved generated ${kind} profile namespace`,
      );
    },
  );

  it('retains last-known-good profiles and malformed bytes after an external edit', async () => {
    const file = await tempFile();
    await writeFile(
      file,
      `${JSON.stringify({ version: 2, profiles: [], pollIntervalMs: 10_000 })}\n`,
      'utf8',
    );
    const store = new RosterConfigStore(file, '/work', 'ws_workspace1');
    expect((await store.load()).source).toBe('disk');
    const malformed = '{ broken';
    await writeFile(file, malformed, 'utf8');

    const reloaded = await store.reload();

    expect(reloaded.source).toBe('last-known-good');
    expect(reloaded.writeBlocked).toBe(true);
    expect(reloaded.config).toBe(store.current);
    await expect(store.save(store.current)).rejects.toThrow(/Refusing to overwrite/);
    expect(await readFile(file, 'utf8')).toBe(malformed);
  });

  it('marks an initially malformed profile document as a blocked safe default', async () => {
    const file = await tempFile();
    const malformed = '{"version":2,"profiles":[';
    await writeFile(file, malformed, 'utf8');
    const store = new RosterConfigStore(file, '/work', 'ws_workspace1');

    const loaded = await store.load();

    expect(loaded.source).toBe('safe-default');
    expect(loaded.writeBlocked).toBe(true);
    expect(loaded.problems.join(' ')).toContain('not valid JSON');
    expect(loaded.config.members).toEqual([]);
    await expect(store.save(loaded.config)).rejects.toThrow(
      /Refusing to overwrite profile preferences/,
    );
    expect(await readFile(file, 'utf8')).toBe(malformed);
  });

  it('rejects a partially malformed edit instead of applying a valid subset', async () => {
    const file = await tempFile();
    const original = {
      version: 2,
      profiles: [
        {
          id: 'profile-original123',
          workspaceId: 'ws_workspace1',
          catalogId: 'catalog_original',
          agentName: 'original',
        },
      ],
      pollIntervalMs: 10_000,
    };
    await writeFile(file, `${JSON.stringify(original)}\n`, 'utf8');
    const store = new RosterConfigStore(file, '/work', 'ws_workspace1');
    const knownGood = (await store.load()).config;
    const partial = {
      ...original,
      profiles: [
        original.profiles[0],
        {
          id: 'not-opaque',
          workspaceId: 'ws_workspace1',
          catalogId: 'catalog_bad',
          agentName: 'bad',
        },
      ],
    };
    await writeFile(file, `${JSON.stringify(partial)}\n`, 'utf8');

    const reloaded = await store.reload();

    expect(reloaded.source).toBe('last-known-good');
    expect(reloaded.writeBlocked).toBe(true);
    expect(reloaded.config).toBe(knownGood);
    expect(reloaded.config.members).toHaveLength(1);
  });

  it('re-reads strictly before save and preserves a partial-invalid external edit', async () => {
    const file = await tempFile();
    const original = {
      version: 2,
      profiles: [
        {
          id: 'profile-original123',
          workspaceId: 'ws_workspace1',
          catalogId: 'catalog_original',
          agentName: 'original',
        },
      ],
      pollIntervalMs: 10_000,
    };
    await writeFile(file, `${JSON.stringify(original)}\n`, 'utf8');
    const store = new RosterConfigStore(file, '/work', 'ws_workspace1');
    const loaded = await store.load();
    const partial = {
      ...original,
      profiles: [
        original.profiles[0],
        {
          id: 'not-opaque',
          workspaceId: 'ws_workspace1',
          catalogId: 'catalog_bad',
          agentName: 'bad',
        },
      ],
    };
    const partialText = `${JSON.stringify(partial)}\n`;
    await writeFile(file, partialText, 'utf8');

    await expect(store.save(loaded.config)).rejects.toThrow(
      /Refusing to overwrite malformed profile preferences/,
    );

    expect(store.writeBlocked).toBe(true);
    expect(store.problems.join(' ')).toContain('invalid opaque');
    expect(await readFile(file, 'utf8')).toBe(partialText);
  });

  it('uses the loaded profile document as a compare-and-swap baseline', async () => {
    const file = await tempFile();
    const original = {
      version: 2,
      profiles: [
        {
          id: 'profile-original123',
          workspaceId: 'ws_workspace1',
          catalogId: 'catalog_original',
          agentName: 'original',
          label: 'Original',
        },
      ],
      pollIntervalMs: 10_000,
    };
    await writeFile(file, `${JSON.stringify(original)}\n`, 'utf8');
    const store = new RosterConfigStore(file, '/work', 'ws_workspace1');
    const loaded = await store.load();
    const external = {
      ...original,
      profiles: [{ ...original.profiles[0], label: 'Externally renamed' }],
    };
    const externalText = `${JSON.stringify(external)}\n`;
    await writeFile(file, externalText, 'utf8');

    await expect(store.save(loaded.config)).rejects.toThrow(
      /Refusing to overwrite externally changed profile preferences/,
    );

    expect(store.writeBlocked).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(externalText);
  });

  it('rejects wrong-typed optional v2 fields and retains full last-known-good config', async () => {
    const file = await tempFile();
    const original = {
      version: 2,
      profiles: [
        {
          id: 'profile-original123',
          workspaceId: 'ws_workspace1',
          catalogId: 'catalog_original',
          agentName: 'original',
          label: 'Original',
          visible: true,
          order: 0,
          autoStart: false,
        },
      ],
      pollIntervalMs: 10_000,
    };
    await writeFile(file, `${JSON.stringify(original)}\n`, 'utf8');
    const store = new RosterConfigStore(file, '/work', 'ws_workspace1');
    const knownGood = (await store.load()).config;
    const malformed = {
      ...original,
      profiles: [
        {
          ...original.profiles[0],
          label: 42,
          role: false,
          bootPrompt: [],
          model: {},
          effort: 7,
          visible: 'yes',
          order: 1.5,
          autoStart: 'no',
          permissionMode: 1,
          definitionFingerprint: false,
        },
      ],
    };
    const malformedText = `${JSON.stringify(malformed)}\n`;
    await writeFile(file, malformedText, 'utf8');

    const reloaded = await store.reload();

    expect(reloaded.source).toBe('last-known-good');
    expect(reloaded.writeBlocked).toBe(true);
    expect(reloaded.config).toBe(knownGood);
    expect(reloaded.problems.join(' ')).toMatch(/label/);
    expect(reloaded.problems.join(' ')).toMatch(/visible/);
    expect(reloaded.problems.join(' ')).toMatch(/order/);
    expect(reloaded.problems.join(' ')).toMatch(/autoStart/);
    expect(await readFile(file, 'utf8')).toBe(malformedText);
  });

  it('rejects unsupported versions without guessing their shape', () => {
    const fallback = { version: 2 as const, members: [], pollIntervalMs: 10_000 };
    const parsed = parseRosterConfig({ version: 99, profiles: [] }, fallback);
    expect(parsed.config).toBe(fallback);
    expect(parsed.problems.join(' ')).toContain('unsupported');
  });
});
