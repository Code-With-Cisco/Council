'use strict';

(function installSceneViewModel() {
  function slotMode(slot) {
    if (slot.staleBinding) return 'failed';
    if (slot.bindingState === 'unavailable') return 'cold';
    if (slot.session) {
      if (slot.session.state === 'working') return slot.session.cold ? 'cold' : 'working';
      if (slot.session.state === 'blocked') return 'blocked';
      if (slot.session.state === 'failed') return 'failed';
      if (slot.session.state === 'done') return 'done';
      if (slot.session.state === 'stopped') return 'stopped';
      // Supervisor-hosted states added in 2.1.233. They have no scene of their
      // own, so they borrow the closest honest one: a session coming up reads as
      // active, and a crashed one shows the failure marker even though the
      // supervisor restarts it — the alternative was rendering it as healthy.
      if (slot.session.state === 'crashed') return 'failed';
      if (
        slot.session.state === 'running' ||
        slot.session.state === 'starting' ||
        slot.session.state === 'resuming' ||
        slot.session.state === 'adopted'
      ) {
        return slot.session.cold ? 'cold' : 'working';
      }
      return slot.session.cold ? 'cold' : 'idle';
    }
    if (slot.validation?.launchable === false) return 'failed';
    return 'missing';
  }

  function actionState(slot, options) {
    const capabilities = options.capabilities ?? {};
    const workspaceReady = options.workspaceReady === true && options.trusted === true;
    const definitionReady =
      options.definitionStale !== true &&
      slot.validation?.launchable === true &&
      /^[0-9a-f]{64}$/.test(slot.validation?.fingerprint ?? '');
    const launchReady =
      workspaceReady && capabilities.start === true && definitionReady;
    const hasExactSession =
      typeof slot.session?.id === 'string' &&
      slot.session.id !== '' &&
      slot.bindingState !== 'unavailable';
    const terminal =
      slot.bindingState === 'terminal' || slot.bindingState === 'failed';

    return {
      start: launchReady && slot.bindingState === 'none',
      startNew: launchReady && terminal && hasExactSession,
      resume: workspaceReady && capabilities.start === true && terminal && hasExactSession,
      stop:
        workspaceReady &&
        capabilities.stop === true &&
        slot.bindingState === 'active' &&
        hasExactSession,
      logs: workspaceReady && capabilities.logs === true && hasExactSession,
      // Mirrors isSafePlainTextReplyState in src/supervisor/agentSupervisor.ts.
      // A blocked session qualifies only when it is idle and names nothing it
      // waits on: `waitingFor` is set exactly when a prompt or dialog owns the
      // input, and plain text would answer that instead of the agent.
      reply:
        workspaceReady &&
        capabilities.plainTextReply === true &&
        hasExactSession &&
        ((slot.session.state === 'blocked' &&
          slot.session.status?.toLowerCase() === 'idle' &&
          slot.session.waitingFor === undefined) ||
          (slot.session.state === 'working' &&
            slot.session.status?.toLowerCase() === 'idle') ||
          slot.session.state === 'done' ||
          slot.session.state === 'failed'),
      clear:
        workspaceReady &&
        options.bindingHealthy !== false &&
        slot.bindingState === 'stale',
    };
  }

  function createProfileActionRouter(api) {
    return Object.freeze({
      start: (profileId, expectedDefinitionFingerprint) =>
        api.startMember(profileId, expectedDefinitionFingerprint),
      startWithMessage: (profileId, expectedDefinitionFingerprint, message) =>
        api.startMemberWithMessage(profileId, expectedDefinitionFingerprint, message),
      startNew: (profileId, expectedDefinitionFingerprint) =>
        api.startNewMember(profileId, expectedDefinitionFingerprint),
      resume: (profileId) => api.resumeMember(profileId),
      stop: (profileId) => api.stopSession(profileId),
      logs: (profileId) => api.logs(profileId),
      reply: (profileId, message) => api.reply(profileId, message),
      clear: (profileId) => api.clearBinding(profileId),
    });
  }

  function findCouncilSlot(snapshot) {
    return (snapshot?.roster.squad ?? []).find(
      (slot) =>
        slot.member.mode === 'internal' &&
        slot.member.agent === 'council-lead' &&
        slot.member.configured === false,
    );
  }

  /** Shared opaque-ID route used by both the card and pixel-detail Start UI. */
  function invokeProfileStart(slot, actions) {
    return actions.start(slot.member.key, slot.validation?.fingerprint);
  }

  function mapSnapshot(snapshot, options) {
    const perPage = options.perPage;
    const slots = (snapshot?.roster.squad ?? []).filter(
      (slot) => slot.member.visible !== false,
    );
    const pages = Math.max(1, Math.ceil(slots.length / perPage));
    const page = Math.max(0, Math.min(options.page, pages - 1));
    const pageSlots = slots.slice(page * perPage, page * perPage + perPage);
    return {
      slots,
      pageSlots,
      page,
      pages,
      connected: options.runtimeAvailable && snapshot !== undefined,
      stale:
        snapshot?.rosterError !== undefined ||
        snapshot?.definitionError !== undefined,
      agents: pageSlots.map((slot) => ({
        key: slot.member.key,
        label: slot.member.label,
        mode: slotMode(slot),
        missionBadge:
          window.DecagramCouncilMissionViewModel?.assignmentBadge(
            options.missionState,
            slot.member.key,
          ),
      })),
    };
  }

  window.DecagramCouncilSceneViewModel = {
    slotMode,
    actionState,
    createProfileActionRouter,
    findCouncilSlot,
    invokeProfileStart,
    mapSnapshot,
  };
})();
