import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionProviderRouter } from '../src/missions/providerRouter.js';
import { MAX_PREVIEW_ROLE_INSTRUCTIONS } from '../src/missions/types.js';
import type { CodexMissionProviderAdapter } from '../src/providers/codex/adapter.js';
import { CodexThreadBindingStore } from '../src/providers/codex/threadBindings.js';
import type { MissionInitialTaskDispatchState } from '../src/providers/missionContracts.js';
import {
  SessionBindingStore,
  type SessionBindingRecord,
} from '../src/supervisor/sessionBindings.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  initialTaskDispatchState: MissionInitialTaskDispatchState,
  roleInstructions = 'Work only on the assigned Mission task.',
) {
  const userData = await mkdtemp(
    path.join(tmpdir(), 'council-mission-provider-router-'),
  );
  roots.push(userData);
  const workspacePath = path.join(userData, 'trusted workspace');
  const bindings = new CodexThreadBindingStore(userData);
  await bindings.load();
  const ensureConversation = vi.fn(async () => ({
    ok: true as const,
    value: {
      providerId: 'codex' as const,
      providerConversationId: '019c-thread-000001',
      assignmentId: 'execution-000001',
      resumed: true,
      initialTaskDispatchState,
      ...(initialTaskDispatchState === 'started'
        ? { initialTaskTurnId: '019c-turn-000001' }
        : {}),
    },
  }));
  const dispatchTurn = vi.fn(async () => ({
    ok: true as const,
    value: {
      providerId: 'codex' as const,
      providerConversationId: '019c-thread-000001',
      providerTurnId: '019c-turn-000001',
      assignmentId: 'execution-000001',
    },
  }));
  const adapter = {
    status: {
      providerId: 'codex',
      displayName: 'Codex',
      available: true,
      authenticated: true,
      persistentConversations: true,
      approvals: true,
      diagnostic: undefined,
    },
    ensureConversation,
    dispatchTurn,
  } as unknown as CodexMissionProviderAdapter;
  const router = new MissionProviderRouter({
    workspace: {
      id: 'workspace-000001',
      canonicalPath: workspacePath,
      trusted: true,
    },
    resolveAssignment: vi.fn(async () => ({
      profileId: 'profile-00000001',
      definitionFingerprint: 'a'.repeat(64),
      roleInstructions,
      taskPrompt: 'Produce the exact requested evidence.',
      launchable: true,
    })),
    claude: undefined,
    codex: { adapter, bindings },
  });
  return { router, ensureConversation, dispatchTurn };
}

async function claudePreviewFixture(
  binding: SessionBindingRecord,
): Promise<MissionProviderRouter> {
  const userData = await mkdtemp(
    path.join(tmpdir(), 'council-mission-provider-router-claude-'),
  );
  roots.push(userData);
  const workspacePath = path.join(userData, 'trusted workspace');
  const bindings = new SessionBindingStore(
    path.join(userData, 'session-bindings.json'),
  );
  await bindings.load();
  await bindings.setBinding(binding);
  return new MissionProviderRouter({
    workspace: {
      id: 'workspace-000001',
      canonicalPath: workspacePath,
      trusted: true,
    },
    resolveAssignment: vi.fn(async () => ({
      profileId: 'profile-00000001',
      definitionFingerprint: 'a'.repeat(64),
      roleInstructions: 'Perform the exact independent review.',
      taskPrompt: 'Return evidence for the assigned gate.',
      launchable: true,
    })),
    claude: {
      launcher: {
        startMissionMember: vi.fn(),
      },
      bindings,
      available: () => true,
    },
    codex: undefined,
  });
}

const startRequest = {
  executionId: 'execution-000001',
  missionId: 'mission-000001',
  taskId: 'task-000001',
  workspaceId: 'workspace-000001',
  profileId: 'profile-00000001',
  providerId: 'codex',
  expectedDefinitionFingerprint: 'a'.repeat(64),
  action: 'resume' as const,
  missionObjective: 'Complete the Mission safely.',
  taskTitle: 'Implement the retry boundary',
  taskDescription: 'Preserve exact provider identity across retries.',
  lease: undefined,
};

describe('MissionProviderRouter Codex retry authority', () => {
  it('previews the complete normalized role contract and fingerprints the exact displayed bytes', async () => {
    const roleInstructions = '\uFEFFFirst line\r\nSecond line\rThird line';
    const normalized = 'First line\nSecond line\nThird line';
    const f = await fixture('started', roleInstructions);

    const preview = await f.router.previewStart({
      missionId: 'mission-000001',
      taskId: 'task-000001',
      workspaceId: 'workspace-000001',
      profileId: 'profile-00000001',
      providerId: 'codex',
      expectedDefinitionFingerprint: 'a'.repeat(64),
      accessMode: 'read-only',
    });

    expect(preview).toMatchObject({
      roleInstructions: normalized,
      roleInstructionFingerprint: createHash('sha256')
        .update(normalized, 'utf8')
        .digest('hex'),
      providerAvailable: true,
      providerAuthenticated: true,
      protocolReady: true,
      launchable: true,
    });
  });

  it('hard-blocks an effective role contract that cannot be displayed completely', async () => {
    const f = await fixture(
      'started',
      'x'.repeat(MAX_PREVIEW_ROLE_INSTRUCTIONS + 1),
    );

    const preview = await f.router.previewStart({
      missionId: 'mission-000001',
      taskId: 'task-000001',
      workspaceId: 'workspace-000001',
      profileId: 'profile-00000001',
      providerId: 'codex',
      expectedDefinitionFingerprint: 'a'.repeat(64),
      accessMode: 'read-only',
    });

    expect(preview.roleInstructions).toBeUndefined();
    expect(preview.launchable).toBe(false);
    expect(preview.diagnostic).toContain('preview limit');
    expect(preview.roleInstructionFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dispatches the initial task when a resumed thread has no durable task turn', async () => {
    const f = await fixture('not-started');

    await expect(f.router.start(startRequest)).resolves.toMatchObject({
      providerId: 'codex',
      providerResourceId: '019c-thread-000001',
    });

    expect(f.ensureConversation).toHaveBeenCalledOnce();
    expect(f.dispatchTurn).toHaveBeenCalledExactlyOnceWith(
      'execution-000001',
      expect.stringContaining('Implement the retry boundary'),
    );
  });

  it('does not duplicate a durably identified initial task turn', async () => {
    const f = await fixture('started');

    await expect(f.router.start(startRequest)).resolves.toMatchObject({
      providerResourceId: '019c-thread-000001',
    });

    expect(f.dispatchTurn).not.toHaveBeenCalled();
  });

  it('blocks retry while the initial task dispatch outcome is uncertain', async () => {
    const f = await fixture('pending');

    await expect(f.router.start(startRequest)).rejects.toThrow(
      /uncertain outcome/i,
    );

    expect(f.dispatchTurn).not.toHaveBeenCalled();
  });
});

describe('MissionProviderRouter Claude ownership preview', () => {
  const legacyBinding: SessionBindingRecord = {
    providerId: 'claude-code',
    workspaceId: 'workspace-000001',
    profileId: 'profile-00000001',
    shortSessionId: 'session-000001',
    fullSessionId: 'session-000001-full',
    uniqueLaunchName: 'dc-profile-launch',
    agentName: 'reviewer',
    catalogId: 'catalog-000001',
    definitionFingerprint: 'a'.repeat(64),
    requestedCanonicalCwd: '/tmp/council-workspace',
    actualCanonicalCwd: '/tmp/council-workspace',
    createdAt: '2026-07-26T12:00:00.000Z',
    lastConfirmedAt: '2026-07-26T12:00:00.000Z',
  };

  it('keeps a readable Milestone 1 binding outside Mission launch authority', async () => {
    const router = await claudePreviewFixture(legacyBinding);

    const preview = await router.previewStart({
      missionId: 'mission-000001',
      taskId: 'task-000001',
      workspaceId: 'workspace-000001',
      profileId: 'profile-00000001',
      providerId: 'claude-code',
      expectedDefinitionFingerprint: 'a'.repeat(64),
      executionId: 'execution-000001',
      accessMode: 'read-only',
    });

    expect(preview.launchable).toBe(false);
    expect(preview.diagnostic).toContain('cannot be claimed');
  });

  it('offers reuse only for the exact execution and access-mode binding', async () => {
    const router = await claudePreviewFixture({
      ...legacyBinding,
      missionExecutionId: 'execution-000001',
      missionAccessMode: 'read-only',
    });

    const exact = await router.previewStart({
      missionId: 'mission-000001',
      taskId: 'task-000001',
      workspaceId: 'workspace-000001',
      profileId: 'profile-00000001',
      providerId: 'claude-code',
      expectedDefinitionFingerprint: 'a'.repeat(64),
      executionId: 'execution-000001',
      accessMode: 'read-only',
    });
    const mismatched = await router.previewStart({
      missionId: 'mission-000001',
      taskId: 'task-000001',
      workspaceId: 'workspace-000001',
      profileId: 'profile-00000001',
      providerId: 'claude-code',
      expectedDefinitionFingerprint: 'a'.repeat(64),
      executionId: 'execution-000001',
      accessMode: 'workspace-write',
    });

    expect(exact).toMatchObject({ action: 'reuse', launchable: true });
    expect(mismatched.launchable).toBe(false);
  });
});
