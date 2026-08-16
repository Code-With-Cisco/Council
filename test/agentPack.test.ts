import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentPackInstaller } from '../src/ui/agentPack.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('repository Agent Pack', () => {
  it('previews, confirms by exact preview, and installs without replacing settings', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'council-pack-'));
    await mkdir(path.join(workspace, '.claude'), { recursive: true });
    await writeFile(
      path.join(workspace, '.claude', 'settings.json'),
      `${JSON.stringify({ customSetting: true, hooks: { Notification: [{ matcher: 'all', hooks: [] }] } }, null, 2)}\n`,
      'utf8',
    );
    const installer = new AgentPackInstaller(REPO_ROOT, workspace);
    const preview = await installer.preview();

    expect(preview.canInstall).toBe(true);
    expect(preview.items).toContainEqual(expect.objectContaining({
      relativePath: path.join('.claude', 'settings.json'),
      action: 'merge',
    }));
    const result = await installer.install(preview);
    expect(result.created).toBeGreaterThan(10);
    expect(result.merged).toBe(1);
    const settings = JSON.parse(
      await readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(settings['customSetting']).toBe(true);
    expect(settings['hooks']).toBeDefined();
    expect(await readFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), 'utf8'))
      .toContain('name: reviewer');
    expect(await readFile(path.join(workspace, '.claude', 'decagram-council-agent-pack.json'), 'utf8'))
      .toContain('"version": 1');
  });

  it('blocks a differing existing definition instead of overwriting it', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'council-pack-conflict-'));
    await mkdir(path.join(workspace, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), 'user owned\n');
    const preview = await new AgentPackInstaller(REPO_ROOT, workspace).preview();
    expect(preview.canInstall).toBe(false);
    expect(preview.items).toContainEqual(expect.objectContaining({
      relativePath: path.join('.claude', 'agents', 'reviewer.md'),
      action: 'conflict',
    }));
  });
});
