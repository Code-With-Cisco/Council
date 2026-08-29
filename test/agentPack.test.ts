import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentPackInstaller } from '../src/ui/agentPack.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('repository Agent Pack', () => {
  it('includes every non-script Agent Pack resource in the packaged app', async () => {
    const packageDocument = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { build?: { files?: unknown[] } };
    expect(packageDocument.build?.files).toContain('scripts/gates/README.md');
  });

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
      .toContain('"version": 2');
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

  it('updates only unchanged managed files', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'council-pack-source-'));
    await cp(path.join(REPO_ROOT, '.claude'), path.join(fixtureRoot, '.claude'), { recursive: true });
    await cp(path.join(REPO_ROOT, 'scripts', 'gates'), path.join(fixtureRoot, 'scripts', 'gates'), { recursive: true });
    const workspace = await mkdtemp(path.join(tmpdir(), 'council-pack-update-'));
    const installer = new AgentPackInstaller(fixtureRoot, workspace);
    await installer.install(await installer.preview());

    const reviewerSource = path.join(fixtureRoot, '.claude', 'agents', 'reviewer.md');
    await writeFile(reviewerSource, `${await readFile(reviewerSource, 'utf8')}\nUpdated pack content.\n`, 'utf8');
    const updatedInstaller = new AgentPackInstaller(fixtureRoot, workspace);
    const preview = await updatedInstaller.preview();
    expect(preview.operation).toBe('update');
    expect(preview.items).toContainEqual(expect.objectContaining({
      relativePath: path.join('.claude', 'agents', 'reviewer.md'),
      action: 'update',
    }));

    const result = await updatedInstaller.install(preview);
    expect(result.updated).toBe(1);
    expect(await readFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), 'utf8'))
      .toContain('Updated pack content.');
  });

  it('uninstalls owned files and restores the exact pre-install settings backup', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'council-pack-uninstall-'));
    await mkdir(path.join(workspace, '.claude', 'agents'), { recursive: true });
    const originalSettings = '{\n  "customSetting": true\n}\n';
    await writeFile(path.join(workspace, '.claude', 'settings.json'), originalSettings, 'utf8');
    const preExistingReviewer = await readFile(path.join(REPO_ROOT, '.claude', 'agents', 'reviewer.md'));
    await writeFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), preExistingReviewer);
    const installer = new AgentPackInstaller(REPO_ROOT, workspace);
    await installer.install(await installer.preview());

    const preview = await installer.previewUninstall();
    expect(preview.canUninstall).toBe(true);
    expect(preview.items).toContainEqual(expect.objectContaining({
      relativePath: path.join('.claude', 'agents', 'reviewer.md'),
      action: 'leave',
    }));
    expect(preview.items).toContainEqual(expect.objectContaining({
      relativePath: path.join('.claude', 'settings.json'),
      action: 'restore',
    }));
    const result = await installer.uninstall(preview);

    expect(result.restored).toBe(1);
    expect(result.removed).toBeGreaterThan(10);
    expect(await readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8')).toBe(originalSettings);
    expect(await readFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'))).toEqual(preExistingReviewer);
    await expect(readFile(path.join(workspace, '.claude', 'agents', 'builder.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(workspace, '.claude', 'decagram-council-agent-pack.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks uninstall when a managed file or settings changed after installation', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'council-pack-uninstall-conflict-'));
    const installer = new AgentPackInstaller(REPO_ROOT, workspace);
    await installer.install(await installer.preview());
    await writeFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), 'user changed this\n', 'utf8');
    await writeFile(path.join(workspace, '.claude', 'settings.json'), '{"userChanged":true}\n', 'utf8');

    const preview = await installer.previewUninstall();
    expect(preview.canUninstall).toBe(false);
    expect(preview.items.filter((item) => item.action === 'conflict')).toHaveLength(2);
    await expect(installer.uninstall(preview)).rejects.toThrow('contains conflicts');
    expect(await readFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), 'utf8'))
      .toBe('user changed this\n');
  });
});
