'use strict';

(function installMissionViewModel() {
  function assignmentsForProfile(missionState, profileId) {
    const assignments =
      missionState?.projection?.assignmentsByProfileId?.[profileId];
    return Array.isArray(assignments) ? assignments : [];
  }

  function assignmentBadge(missionState, profileId) {
    const assignments = assignmentsForProfile(missionState, profileId);
    if (assignments.length === 0) return undefined;
    const assignment =
      assignments.find((candidate) =>
        ['running', 'blocked', 'gating', 'handoff-ready'].includes(
          candidate.taskState,
        ),
      ) ?? assignments[0];
    if (!assignment) return undefined;
    return {
      label:
        assignments.length === 1
          ? assignment.taskTitle
          : `${assignment.taskTitle} +${assignments.length - 1}`,
      missionTitle: assignment.missionTitle,
      taskState: assignment.taskState,
      providerId: assignment.providerId,
      count: assignments.length,
    };
  }

  function providerStatus(missionState, providerId) {
    return (missionState?.providers ?? []).find(
      (provider) => provider.providerId === providerId,
    );
  }

  function providerTone(provider) {
    if (!provider?.available || !provider.protocolReady) return 'is-bad';
    if (!provider.authenticated) return 'is-warning';
    return 'is-good';
  }

  function canStartPreview(preview) {
    return (
      preview !== undefined &&
      /^[0-9a-f]{64}$/.test(preview.digest ?? '') &&
      (preview.blockers ?? []).length === 0 &&
      (preview.participants ?? []).length > 0 &&
      preview.participants.every(
        (participant) =>
          participant.launchable === true &&
          participant.providerAvailable === true &&
          participant.providerAuthenticated === true &&
          participant.protocolReady === true &&
          typeof participant.roleInstructions === 'string' &&
          participant.roleInstructions.length > 0 &&
          participant.roleInstructions.length <= 24_000 &&
          /^[0-9a-f]{64}$/.test(
            participant.roleInstructionFingerprint ?? '',
          ),
      ) &&
      preview.gateAssignments?.test?.kind === 'test' &&
      preview.gateAssignments?.review?.kind === 'review' &&
      preview.gateAssignments.test.profileId !==
        preview.gateAssignments.review.profileId &&
      preview.gateAssignments.test.executionIntent ===
        'allocate-read-only-on-start' &&
      preview.gateAssignments.review.executionIntent ===
        'allocate-read-only-on-start'
    );
  }

  function canApproveIntegration(preview) {
    const exactSha = (value) =>
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? '');
    return (
      preview !== undefined &&
      /^[0-9a-f]{64}$/.test(preview.digest ?? '') &&
      exactSha(preview.candidateCommitSha) &&
      exactSha(preview.candidateTreeSha) &&
      exactSha(preview.expectedTargetCommitSha) &&
      exactSha(preview.expectedTargetTreeSha) &&
      typeof preview.testGateId === 'string' &&
      preview.testGateId.length > 0 &&
      typeof preview.reviewGateId === 'string' &&
      preview.reviewGateId.length > 0 &&
      Number.isSafeInteger(preview.approvalRevision) &&
      preview.approvalRevision >= 0
    );
  }

  window.CouncilMissionViewModel = {
    assignmentsForProfile,
    assignmentBadge,
    providerStatus,
    providerTone,
    canStartPreview,
    canApproveIntegration,
  };
})();
