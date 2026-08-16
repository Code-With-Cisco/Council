import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function viewModel(): Promise<{
  assignmentsForProfile(state: unknown, profileId: string): unknown[];
  assignmentBadge(state: unknown, profileId: string): {
    label: string;
    missionTitle: string;
    taskState: string;
    providerId: string;
    count: number;
  } | undefined;
  providerStatus(state: unknown, providerId: string): unknown;
  providerTone(provider: unknown): string;
  canStartPreview(preview: unknown): boolean;
  canApproveIntegration(preview: unknown): boolean;
}> {
  const source = await readFile(
    path.join(root, 'src', 'ui', 'renderer', 'mission-view-model.js'),
    'utf8',
  );
  const window: Record<string, unknown> = {};
  runInNewContext(source, { window });
  return window['DecagramCouncilMissionViewModel'] as Awaited<
    ReturnType<typeof viewModel>
  >;
}

describe('Mission renderer view model', () => {
  it('projects one durable assignment badge across agent surfaces', async () => {
    const view = await viewModel();
    const state = {
      projection: {
        assignmentsByProfileId: {
          'profile-12345678': [
            {
              missionTitle: 'Milestone 2',
              taskTitle: 'Mission UI',
              taskState: 'running',
              providerId: 'codex',
            },
            {
              missionTitle: 'Milestone 2',
              taskTitle: 'Documentation',
              taskState: 'queued',
              providerId: 'claude-code',
            },
          ],
        },
      },
    };
    expect(view.assignmentBadge(state, 'profile-12345678')).toEqual({
      label: 'Mission UI +1',
      missionTitle: 'Milestone 2',
      taskState: 'running',
      providerId: 'codex',
      count: 2,
    });
    expect(view.assignmentBadge(state, 'profile-absent00')).toBeUndefined();
  });

  it('keeps provider availability, authentication, and protocol status distinct', async () => {
    const view = await viewModel();
    expect(
      view.providerTone({
        available: true,
        authenticated: true,
        protocolReady: true,
      }),
    ).toBe('is-good');
    expect(
      view.providerTone({
        available: true,
        authenticated: false,
        protocolReady: true,
      }),
    ).toBe('is-warning');
    expect(
      view.providerTone({
        available: false,
        authenticated: false,
        protocolReady: false,
      }),
    ).toBe('is-bad');
  });

  it('enables Start Squad only for a blocker-free exact preview', async () => {
    const view = await viewModel();
    const preview = {
      digest: 'a'.repeat(64),
      blockers: [],
      participants: [
        {
          launchable: true,
          providerAvailable: true,
          providerAuthenticated: true,
          protocolReady: true,
          roleInstructions: 'Run the exact assigned role.',
          roleInstructionFingerprint: 'b'.repeat(64),
        },
      ],
      gateAssignments: {
        test: {
          kind: 'test',
          profileId: 'profile-test0001',
          executionIntent: 'allocate-read-only-on-start',
        },
        review: {
          kind: 'review',
          profileId: 'profile-review01',
          executionIntent: 'allocate-read-only-on-start',
        },
      },
    };
    expect(view.canStartPreview(preview)).toBe(true);
    expect(view.canStartPreview({ ...preview, blockers: ['provider unavailable'] })).toBe(false);
    expect(view.canStartPreview({ ...preview, digest: 'short' })).toBe(false);
    expect(
      view.canStartPreview({
        ...preview,
        participants: [
          {
            ...preview.participants[0],
            launchable: false,
          },
        ],
      }),
    ).toBe(false);
    expect(
      view.canStartPreview({
        ...preview,
        gateAssignments: {
          ...preview.gateAssignments,
          review: {
            ...preview.gateAssignments.review,
            profileId: 'profile-test0001',
          },
        },
      }),
    ).toBe(false);
    expect(
      view.canStartPreview({
        ...preview,
        participants: [
          {
            ...preview.participants[0],
            roleInstructions: undefined,
          },
        ],
      }),
    ).toBe(false);
  });

  it('enables integration only for exact candidate, target, gates, and revision evidence', async () => {
    const view = await viewModel();
    const preview = {
      digest: 'a'.repeat(64),
      candidateCommitSha: 'b'.repeat(40),
      candidateTreeSha: 'c'.repeat(40),
      expectedTargetCommitSha: 'd'.repeat(40),
      expectedTargetTreeSha: 'e'.repeat(40),
      testGateId: 'gate_test',
      reviewGateId: 'gate_review',
      approvalRevision: 9,
    };
    expect(view.canApproveIntegration(preview)).toBe(true);
    expect(view.canApproveIntegration({ ...preview, reviewGateId: '' })).toBe(false);
    expect(
      view.canApproveIntegration({
        ...preview,
        expectedTargetTreeSha: 'not-a-tree',
      }),
    ).toBe(false);
  });
});
