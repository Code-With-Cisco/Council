'use strict';

(function installSceneViewModel() {
  const OFFICE_FLOORS = Object.freeze([
    { floor: 0, kind: 'lobby', id: 'lobby', label: 'Council Lobby' },
    { floor: 1, kind: 'department', id: 'academic', label: 'Academic' },
    { floor: 2, kind: 'department', id: 'design', label: 'Design' },
    { floor: 3, kind: 'department', id: 'engineering', label: 'Engineering' },
    { floor: 4, kind: 'department', id: 'finance', label: 'Finance' },
    { floor: 5, kind: 'department', id: 'game-development', label: 'Game Development' },
    { floor: 6, kind: 'department', id: 'gis', label: 'GIS & Spatial Data' },
    { floor: 7, kind: 'department', id: 'healthcare', label: 'Healthcare' },
    { floor: 8, kind: 'department', id: 'marketing', label: 'Marketing' },
    { floor: 9, kind: 'department', id: 'paid-media', label: 'Paid Media' },
    { floor: 10, kind: 'department', id: 'product', label: 'Product' },
    { floor: 11, kind: 'department', id: 'project-management', label: 'Project Management' },
    { floor: 12, kind: 'department', id: 'research', label: 'Research' },
    { floor: 13, kind: 'department', id: 'sales', label: 'Sales' },
    { floor: 14, kind: 'department', id: 'security', label: 'Security' },
    { floor: 15, kind: 'department', id: 'spatial-computing', label: 'Spatial Computing' },
    { floor: 16, kind: 'department', id: 'specialized', label: 'Specialized Services' },
    { floor: 17, kind: 'department', id: 'support', label: 'Support' },
    { floor: 18, kind: 'department', id: 'testing', label: 'Testing & Quality' },
    { floor: 19, kind: 'council', id: 'llm-council', label: 'LLM Council Chamber' },
    { floor: 20, kind: 'queen-bee', id: 'queen-bee', label: 'Queen Bee Executive Office' },
  ]);

  function slotMode(slot) {
    if (slot.staleBinding) return 'failed';
    if (slot.bindingState === 'unavailable') return 'cold';
    if (slot.session) {
      if (slot.session.state === 'working') return slot.session.cold ? 'cold' : 'working';
      if (slot.session.state === 'blocked') return 'blocked';
      if (slot.session.state === 'failed') return 'failed';
      if (slot.session.state === 'done') return 'done';
      if (slot.session.state === 'stopped') return 'stopped';
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
    const launchReady = workspaceReady && capabilities.start === true && definitionReady;
    const hasExactSession =
      typeof slot.session?.id === 'string' &&
      slot.session.id !== '' &&
      slot.bindingState !== 'unavailable';
    const terminal = slot.bindingState === 'terminal' || slot.bindingState === 'failed';

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
      reply:
        workspaceReady &&
        capabilities.plainTextReply === true &&
        hasExactSession &&
        ((slot.session.state === 'blocked' &&
          slot.session.status?.toLowerCase() === 'idle' &&
          slot.session.waitingFor === undefined) ||
          (slot.session.state === 'working' && slot.session.status?.toLowerCase() === 'idle') ||
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

  function normalizedDefinitionPath(slot) {
    return String(slot.validation?.path ?? '').replace(/\\/g, '/').toLowerCase();
  }

  function agencyDivisionForSlot(slot) {
    const match = /\/agency-agents\/([^/]+)\//.exec(normalizedDefinitionPath(slot));
    return match?.[1];
  }

  function activeRank(slot) {
    const mode = slotMode(slot);
    if (mode === 'blocked' || mode === 'failed') return 0;
    if (mode === 'working') return 1;
    if (mode === 'done') return 2;
    if (slot.session) return 3;
    return 4;
  }

  function slotsForFloor(snapshot, floor) {
    const all = snapshot?.roster.squad ?? [];
    if (floor.kind === 'department') {
      return all
        .filter((slot) => agencyDivisionForSlot(slot) === floor.id)
        .sort((left, right) => activeRank(left) - activeRank(right));
    }
    if (floor.kind === 'queen-bee') {
      return all.filter((slot) => slot.member.agent === 'queen-bee');
    }
    if (floor.kind === 'council') {
      return all.filter((slot) => slot.member.agent === 'council-lead');
    }
    return all.filter(
      (slot) =>
        slot.member.visible !== false &&
        slot.member.mode !== 'internal' &&
        agencyDivisionForSlot(slot) === undefined,
    );
  }

  /**
   * The office page index is a real building floor rather than an arbitrary
   * chunk of five agents. Department floors remain stable even when no specialist
   * is running, which lets the UI show where work belongs before a session starts.
   */
  function mapSnapshot(snapshot, options) {
    const perPage = options.perPage;
    const pages = OFFICE_FLOORS.length;
    const page = Math.max(0, Math.min(options.page, pages - 1));
    const floor = OFFICE_FLOORS[page];
    const slots = slotsForFloor(snapshot, floor);
    const pageSlots = slots.slice(0, perPage);
    return {
      slots,
      pageSlots,
      page,
      pages,
      floor,
      connected: options.runtimeAvailable && snapshot !== undefined,
      stale: snapshot?.rosterError !== undefined || snapshot?.definitionError !== undefined,
      agents: pageSlots.map((slot) => ({
        key: slot.member.key,
        label: slot.member.label,
        mode: slotMode(slot),
        missionBadge: window.DecagramCouncilMissionViewModel?.assignmentBadge(
          options.missionState,
          slot.member.key,
        ),
      })),
    };
  }

  function installOfficeFloorNavigation() {
    const label = document.getElementById('office-page-label');
    const previous = document.getElementById('office-previous');
    const next = document.getElementById('office-next');
    const pagination = label?.parentElement;
    if (!label || !previous || !next || !pagination) return;

    const picker = document.createElement('select');
    picker.id = 'office-floor-picker';
    picker.className = 'office-floor-picker';
    picker.setAttribute('aria-label', 'Office floor');
    OFFICE_FLOORS.forEach((floor, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `Floor ${floor.floor} — ${floor.label}`;
      picker.append(option);
    });
    pagination.insertBefore(picker, next);

    let currentPage = 0;
    const rewriteLabel = () => {
      const match = /^OFFICE\s+(\d+)\s*\/\s*(\d+)$/i.exec(label.textContent?.trim() ?? '');
      if (!match) return;
      currentPage = Math.max(0, Math.min(Number(match[1]) - 1, OFFICE_FLOORS.length - 1));
      const floor = OFFICE_FLOORS[currentPage];
      label.textContent = `FLOOR ${floor.floor} · ${floor.label.toUpperCase()}`;
      picker.value = String(currentPage);
      const stationHeading = document.getElementById('station-heading');
      if (stationHeading) stationHeading.textContent = `${floor.label} floor`;
    };

    const observer = new MutationObserver(rewriteLabel);
    observer.observe(label, { childList: true, characterData: true, subtree: true });
    rewriteLabel();

    picker.addEventListener('change', () => {
      const requested = Number(picker.value);
      if (!Number.isInteger(requested) || requested === currentPage) return;
      const button = requested > currentPage ? next : previous;
      const count = Math.abs(requested - currentPage);
      for (let step = 0; step < count; step += 1) button.click();
    });
  }

  installOfficeFloorNavigation();

  window.DecagramCouncilSceneViewModel = {
    OFFICE_FLOORS,
    slotMode,
    actionState,
    createProfileActionRouter,
    findCouncilSlot,
    invokeProfileStart,
    agencyDivisionForSlot,
    mapSnapshot,
  };
})();
