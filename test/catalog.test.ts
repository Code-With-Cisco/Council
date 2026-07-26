import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  catalogRootsForWorkspace,
  fingerprintAgentDefinition,
  resolveAgentCatalog,
  stableCatalogId,
} from '../src/supervisor/catalog.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'decagram-catalog-'));
  temporaryRoots.push(root);
  return root;
}

async function writeDefinition(
  file: string,
  name: string,
  extraFrontmatter = '',
  body = '# Agent\n',
  eol = '\n',
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const source = [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    extraFrontmatter,
    '---',
    '',
    body.trimEnd(),
    '',
  ]
    .filter((line) => line !== '')
    .join(eol);
  await writeFile(file, source, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('resolved agent catalog', () => {
  it('resolves project over nearest ancestor over farther ancestor over user', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'organization', 'project');
    const userAgents = path.join(root, 'user-agents');
    const projectFile = path.join(workspace, '.claude', 'agents', 'builder.md');
    const nearFile = path.join(root, 'organization', '.claude', 'agents', 'builder.md');
    const farFile = path.join(root, '.claude', 'agents', 'builder.md');
    const userFile = path.join(userAgents, 'builder.md');

    await writeDefinition(userFile, 'builder', 'model: user-model');
    await writeDefinition(farFile, 'builder', 'model: far-model');
    await writeDefinition(nearFile, 'builder', 'model: near-model');
    await writeDefinition(projectFile, 'builder', 'model: project-model');

    const catalog = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      userAgentsDir: userAgents,
    });
    const builder = catalog.entries.find((entry) => entry.agentName === 'builder');

    expect(builder?.launchability.state).toBe('launchable');
    expect(builder?.definitionPath).toBe(projectFile);
    expect(builder?.scope).toBe('project');
    expect(builder?.precedenceTier).toBe(0);
    expect(builder?.metadata?.model).toBe('project-model');
    expect(
      builder?.shadowedDefinitions.map((source) => [
        source.scope,
        source.definitionPath,
      ]),
    ).toEqual([
      ['ancestor', nearFile],
      ['ancestor', farFile],
      ['user', userFile],
    ]);
  });

  it('makes a same-tier conflict nonlaunchable without sorting a winner', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'project');
    const userAgents = path.join(root, 'user-agents');
    const first = path.join(workspace, '.claude', 'agents', 'a', 'reviewer.md');
    const second = path.join(workspace, '.claude', 'agents', 'z', 'other-name.md');
    const lowerOne = path.join(userAgents, 'one.md');
    const lowerTwo = path.join(userAgents, 'two.md');

    await writeDefinition(second, 'reviewer');
    await writeDefinition(first, 'reviewer');
    await writeDefinition(lowerOne, 'reviewer');
    await writeDefinition(lowerTwo, 'reviewer');

    const catalog = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      userAgentsDir: userAgents,
    });
    const reviewer = catalog.entries.find((entry) => entry.agentName === 'reviewer');

    expect(reviewer?.launchability.state).toBe('ambiguous');
    expect(reviewer?.definitionPath).toBeUndefined();
    expect(
      reviewer?.ambiguousDefinitions.map((source) => source.definitionPath),
    ).toEqual([first, second]);
    expect(
      reviewer?.shadowedDefinitions.map((source) => source.definitionPath),
    ).toEqual([lowerOne, lowerTwo]);
    expect(
      catalog.diagnostics.some((problem) => problem.code === 'ambiguous-definition'),
    ).toBe(true);
  });

  it('keeps stable identity while normalized content controls the fingerprint and revision', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'project');
    const file = path.join(workspace, '.claude', 'agents', 'builder.md');
    await writeDefinition(file, 'builder', 'model: sonnet', '# Builder', '\n');

    const first = await resolveAgentCatalog({
      workspaceId: 'opaque-workspace',
      workspaceRoot: workspace,
      includeUser: false,
    });
    await writeDefinition(file, 'builder', 'model: sonnet', '# Builder', '\r\n');
    const lineEndingOnly = await resolveAgentCatalog({
      workspaceId: 'opaque-workspace',
      workspaceRoot: workspace,
      includeUser: false,
    });
    await writeDefinition(file, 'builder', 'model: opus', '# Builder changed', '\n');
    const changed = await resolveAgentCatalog({
      workspaceId: 'opaque-workspace',
      workspaceRoot: workspace,
      includeUser: false,
    });

    expect(first.entries[0]?.catalogId).toBe(lineEndingOnly.entries[0]?.catalogId);
    expect(first.entries[0]?.catalogId).toBe(changed.entries[0]?.catalogId);
    expect(first.entries[0]?.fingerprint).toBe(lineEndingOnly.entries[0]?.fingerprint);
    expect(first.revision).toBe(lineEndingOnly.revision);
    expect(first.entries[0]?.fingerprint).not.toBe(changed.entries[0]?.fingerprint);
    expect(first.revision).not.toBe(changed.revision);
    expect(first.entries[0]?.catalogId).toBe(
      stableCatalogId('opaque-workspace', 'builder'),
    );
    expect(first.entries[0]?.catalogId).not.toContain('builder');
    expect(fingerprintAgentDefinition(Buffer.from('a\r\nb\r\n'))).toBe(
      fingerprintAgentDefinition(Buffer.from('a\nb\n')),
    );
  });

  it('keeps the catalog ID when removal reveals a lower-precedence definition', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'parent', 'project');
    const projectFile = path.join(workspace, '.claude', 'agents', 'test.md');
    const ancestorFile = path.join(root, 'parent', '.claude', 'agents', 'test.md');
    await writeDefinition(projectFile, 'test-engineer', 'model: sonnet');
    await writeDefinition(ancestorFile, 'test-engineer', 'model: opus');

    const first = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      includeUser: false,
    });
    await unlink(projectFile);
    const revealed = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      includeUser: false,
    });

    expect(first.entries[0]?.catalogId).toBe(revealed.entries[0]?.catalogId);
    expect(first.entries[0]?.fingerprint).not.toBe(revealed.entries[0]?.fingerprint);
    expect(revealed.entries[0]?.scope).toBe('ancestor');
    expect(revealed.entries[0]?.definitionPath).toBe(ancestorFile);
  });

  it('surfaces malformed and unreadable files without hiding inventory or guessing precedence', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'project');
    const agents = path.join(workspace, '.claude', 'agents');
    const valid = path.join(agents, 'valid.md');
    const unreadable = path.join(agents, 'unreadable.md');
    await writeDefinition(valid, 'valid-agent');
    await writeDefinition(unreadable, 'unreadable-agent');
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, 'bad-yaml.md'), '---\nname: [\n---\n', 'utf8');
    await writeFile(path.join(agents, 'no-frontmatter.md'), '# Nothing\n', 'utf8');
    await writeFile(path.join(agents, 'no-name.md'), '---\nmodel: sonnet\n---\n', 'utf8');
    await writeFile(
      path.join(agents, 'invalid-metadata.md'),
      '---\nname: invalid-metadata\ntools: 42\n---\n',
      'utf8',
    );

    const catalog = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      includeUser: false,
      fileSystem: {
        async readBytes(file) {
          if (file === unreadable) {
            throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
          }
          return readFile(file);
        },
      },
    });

    expect(catalog.entries.find((entry) => entry.agentName === 'valid-agent')?.launchability)
      .toMatchObject({ launchable: false, state: 'malformed' });
    expect(
      catalog.entries.find((entry) => entry.agentName === 'invalid-metadata')
        ?.launchability.state,
    ).toBe('malformed');
    expect(catalog.entries.some((entry) => entry.agentName === 'unreadable-agent')).toBe(
      false,
    );
    expect(new Set(catalog.diagnostics.map((problem) => problem.code))).toEqual(
      new Set([
        'definition-unreadable',
        'malformed-frontmatter',
        'missing-frontmatter',
        'missing-name',
        'invalid-metadata',
        'precedence-uncertain',
      ]),
    );
  });

  it('blocks lower-precedence launches when a higher definition tier is unreadable', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'project');
    const projectAgents = path.join(workspace, '.claude', 'agents');
    const userAgents = path.join(root, 'user-agents');
    await writeDefinition(path.join(userAgents, 'builder.md'), 'builder');

    const catalog = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      userAgentsDir: userAgents,
      fileSystem: {
        async readDirectory(directory) {
          if (directory === projectAgents) {
            throw Object.assign(new Error('fixture access denied'), {
              code: 'EACCES',
            });
          }
          return readdir(directory, { withFileTypes: true });
        },
      },
    });

    const builder = catalog.entries.find((entry) => entry.agentName === 'builder');
    expect(builder).toMatchObject({
      scope: 'user',
      launchability: {
        launchable: false,
        state: 'malformed',
      },
    });
    expect(
      builder?.diagnostics.some(
        (problem) => problem.code === 'precedence-uncertain',
      ),
    ).toBe(true);
  });

  it('does not let unreadable lower precedence block a verified project winner', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'project');
    const projectFile = path.join(workspace, '.claude', 'agents', 'builder.md');
    const userAgents = path.join(root, 'user-agents');
    const unreadableUserFile = path.join(userAgents, 'unknown.md');
    await writeDefinition(projectFile, 'builder');
    await writeDefinition(unreadableUserFile, 'some-user-agent');

    const catalog = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      userAgentsDir: userAgents,
      fileSystem: {
        async readBytes(file) {
          if (file === unreadableUserFile) {
            throw Object.assign(new Error('fixture access denied'), {
              code: 'EACCES',
            });
          }
          return readFile(file);
        },
      },
    });

    expect(
      catalog.entries.find((entry) => entry.agentName === 'builder')
        ?.launchability,
    ).toMatchObject({ launchable: true });
  });

  it('exposes useful metadata and hides helpers only through explicit metadata', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'project');
    const agents = path.join(workspace, '.claude', 'agents');
    await writeDefinition(path.join(agents, 'council-visible.md'), 'council-visible');
    await writeDefinition(
      path.join(agents, 'internal.md'),
      'quiet-worker',
      [
        'label: Quiet Worker',
        'model: opus',
        'tools: [Read, Grep]',
        'disallowedTools: Write',
        'permissionMode: plan',
        'maxTurns: 15',
        'memory: project',
        'effort: high',
        'skills: [one, two]',
        'hidden: true',
        'mode: internal',
      ].join('\n'),
    );

    const catalog = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      includeUser: false,
    });
    const council = catalog.entries.find(
      (entry) => entry.agentName === 'council-visible',
    );
    const internal = catalog.entries.find(
      (entry) => entry.agentName === 'quiet-worker',
    );

    expect(council).toMatchObject({ hidden: false, mode: 'normal' });
    expect(internal).toMatchObject({
      label: 'Quiet Worker',
      hidden: true,
      mode: 'internal',
      metadata: {
        model: 'opus',
        tools: ['Read', 'Grep'],
        disallowedTools: 'Write',
        permissionMode: 'plan',
        maxTurns: 15,
        memory: 'project',
        effort: 'high',
        skills: ['one', 'two'],
      },
    });
  });

  it('supports disabling user scope and returns deterministic roots and entries', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'project');
    const userAgents = path.join(root, 'user-agents');
    await writeDefinition(path.join(userAgents, 'user-only.md'), 'user-only');
    await writeDefinition(
      path.join(workspace, '.claude', 'agents', 'z.md'),
      'zeta',
    );
    await writeDefinition(
      path.join(workspace, '.claude', 'agents', 'a.md'),
      'Alpha',
    );

    const roots = catalogRootsForWorkspace(workspace, userAgents, false);
    const catalog = await resolveAgentCatalog({
      workspaceId: 'workspace-1',
      workspaceRoot: workspace,
      userAgentsDir: userAgents,
      includeUser: false,
    });

    expect(roots.some((rootEntry) => rootEntry.scope === 'user')).toBe(false);
    expect(catalog.entries.map((entry) => entry.agentName)).toEqual(['Alpha', 'zeta']);
    expect(catalog.entries.some((entry) => entry.agentName === 'user-only')).toBe(
      false,
    );

    // The injected interface remains compatible with the native Dirent shape.
    const nativeEntries = await readdir(
      path.join(workspace, '.claude', 'agents'),
      { withFileTypes: true },
    );
    expect(nativeEntries.every((entry) => entry.isFile())).toBe(true);
  });

  it('does not misclassify the user root as an ancestor beneath the home directory', () => {
    const home = path.join(path.parse(process.cwd()).root, 'Users', 'example');
    const workspace = path.join(home, 'projects', 'council');
    const userAgents = path.join(home, '.claude', 'agents');

    const enabled = catalogRootsForWorkspace(workspace, userAgents, true);
    const disabled = catalogRootsForWorkspace(workspace, userAgents, false);

    expect(enabled.filter((root) => root.path === userAgents)).toEqual([
      expect.objectContaining({ scope: 'user' }),
    ]);
    expect(disabled.some((root) => root.path === userAgents)).toBe(false);
  });
});
