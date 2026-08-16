'use strict';

const api = window.decagramCouncil;
const profileActions = window.DecagramCouncilSceneViewModel.createProfileActionRouter(api);
const IDENTITY_COLORS = [
  '#7fa9dc',
  '#d9b36b',
  '#c08fd8',
  '#7cc49e',
  '#64bfc2',
  '#d98072',
  '#82a7c9',
  '#b7c46f',
  '#d196b2',
  '#8f9bdd',
  '#d58b5d',
  '#73b8a7',
];
const AGENTS_PER_OFFICE = 5;

function identityFor(key, label) {
  let hash = 2166136261;
  for (const char of key) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const sigil =
    label
      .split(/[-_\s]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?';
  return { color: IDENTITY_COLORS[Math.abs(hash) % IDENTITY_COLORS.length], sigil };
}

let state;
let selectedKey;
let activeView = 'office';
let previousConsoleView = 'squad';
let officePage = 0;
let officeRenderer;
let missionState;
let pendingSquadPreview;
let pendingIntegrationPreview;
let pendingHandoffTarget;
let pendingGateTarget;
const missionRoleSelections = new Map();

const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setFeedback(message) {
  byId('global-feedback').textContent = message;
}

function activateView(viewName) {
  if (viewName !== 'office') previousConsoleView = viewName;
  activeView = viewName;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('is-active', view.id === `view-${viewName}`);
  });
  if (viewName === 'office') byId('pixel-office').focus({ preventScroll: true });
}

function slotState(slot) {
  if (slot.staleBinding) return 'stale binding';
  if (slot.bindingState === 'unavailable') return 'runtime unavailable';
  if (slot.session) return slot.session.state ?? (slot.session.cold ? 'cold' : 'idle');
  if (slot.validation?.launchable === false) {
    return slot.validation.found ? 'definition blocked' : 'definition missing';
  }
  return slot.bindingState === 'none' ? 'not started' : 'unknown';
}

function visibleSlots(snapshot) {
  return (snapshot?.roster.squad ?? []).filter((slot) => slot.member.visible !== false);
}

function canStart(slot) {
  return actionsFor(slot).start;
}

function actionsFor(slot) {
  return window.DecagramCouncilSceneViewModel.actionState(slot, {
    workspaceReady: state?.workspace.status === 'ready',
    trusted: state?.workspace.trusted === true,
    definitionStale: state?.snapshot?.definitionError !== undefined,
    bindingHealthy: state?.bindingProblem === undefined,
    capabilities: state?.capabilities ?? {},
  });
}

function canReply(slot) {
  return actionsFor(slot).reply;
}

function statusClass(stateName) {
  if (stateName === 'working' || stateName === 'done' || stateName === 'running') {
    return 'is-good';
  }
  if (stateName === 'blocked') return 'is-warning';
  if (
    stateName === 'failed' ||
    // Auto-restarted by the supervisor, but still a failure a person should see.
    stateName === 'crashed' ||
    stateName === 'stale binding' ||
    stateName.startsWith('definition ')
  ) {
    return 'is-bad';
  }
  // starting / resuming / adopted deliberately fall through to neutral: they are
  // brief and self-resolving, and colouring them would flicker the squad screen.
  return '';
}

function humanDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function shortSha(value) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  return value.length > 14 ? value.slice(0, 12) : value;
}

function assignmentBadge(profileId) {
  return window.DecagramCouncilMissionViewModel.assignmentBadge(
    missionState,
    profileId,
  );
}

function assignmentText(badge) {
  if (!badge) return undefined;
  const provider = badge.providerId === 'claude-code' ? 'Claude' : badge.providerId === 'codex' ? 'Codex' : 'provider pending';
  return `${badge.missionTitle} · ${badge.label} · ${badge.taskState} · ${provider}`;
}

async function runAction(button, pendingText, action) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try {
    const result = await action();
    if (!result.ok) {
      setFeedback(result.message);
      return result;
    }
    setFeedback('Action completed.');
    return result;
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error));
    return { ok: false, message: String(error) };
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

function renderAttention(snapshot) {
  const channel = byId('attention-channel');
  const sessions = snapshot?.needsInput ?? [];
  if (sessions.length === 0) {
    channel.hidden = true;
    return;
  }
  const first = sessions[0];
  channel.hidden = false;
  byId('attention-title').textContent = first.name ?? first.id ?? 'A specialist';
  byId('attention-detail').textContent = first.waitingFor ?? first.detail ?? 'Waiting for input';
  byId('attention-count').textContent =
    sessions.length === 1 ? '1 item' : `${sessions.length} items · showing first`;
}

function renderOffice(snapshot) {
  const scene = window.DecagramCouncilSceneViewModel.mapSnapshot(snapshot, {
    page: officePage,
    perPage: AGENTS_PER_OFFICE,
    runtimeAvailable: state?.preflight?.claude?.meetsMinimum === true,
    missionState,
  });
  const slots = scene.slots;
  const pageCount = scene.pages;
  officePage = scene.page;
  const pageSlots = scene.pageSlots;
  const runningCount = slots.filter((slot) => slot.session?.state === 'working').length;
  const blockedCount = slots.filter((slot) => slot.session?.state === 'blocked').length;

  byId('office-page-label').textContent = `OFFICE ${officePage + 1} / ${pageCount}`;
  byId('office-previous').disabled = officePage === 0;
  byId('office-next').disabled = officePage >= pageCount - 1;
  byId('office-summary').textContent = snapshot
    ? `${slots.length} definitions · ${runningCount} working · ${blockedCount} need${blockedCount === 1 ? 's' : ''} you`
    : 'Waiting for the first runtime snapshot…';

  officeRenderer?.setScene({
    agents: pageSlots.map((slot) => {
      const theme = identityFor(slot.member.key, slot.member.label);
      return {
        key: slot.member.key,
        label: slot.member.label,
        color: theme.color,
        mode: scene.agents.find((agent) => agent.key === slot.member.key)?.mode ?? 'missing',
        missionBadge: scene.agents.find(
          (agent) => agent.key === slot.member.key,
        )?.missionBadge,
      };
    }),
    connected: scene.connected,
    stale: scene.stale,
    page: officePage + 1,
    pages: pageCount,
  });

  const stationList = byId('office-stations');
  stationList.replaceChildren();
  if (pageSlots.length === 0) {
    stationList.append(
      element(
        'p',
        'muted',
        'No launchable definitions are visible. Open Diagnostics for discovery details.',
      ),
    );
  }

  for (const slot of pageSlots) {
    const theme = identityFor(slot.member.key, slot.member.label);
    const currentState = slotState(slot);
    const missionBadge = assignmentBadge(slot.member.key);
    const button = element(
      'button',
      `station-button ${currentState === 'blocked' ? 'is-blocked' : ''} ${currentState === 'failed' ? 'is-failed' : ''} ${selectedKey === slot.member.key ? 'is-selected' : ''}`,
    );
    button.type = 'button';
    button.style.setProperty('--identity', theme.color);
    button.setAttribute('aria-pressed', selectedKey === slot.member.key ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      [slot.member.label, currentState, assignmentText(missionBadge)]
        .filter(Boolean)
        .join(', '),
    );
    button.append(
      element('span', 'station-sigil', theme.sigil),
      element('span', 'station-name', slot.member.label),
      element('span', 'station-state', currentState),
    );
    if (missionBadge) {
      button.append(
        element('span', 'station-mission', missionBadge.label),
      );
    }
    button.addEventListener('click', () => {
      selectedKey = slot.member.key;
      renderOffice(snapshot);
    });
    stationList.append(button);
  }

  const selected = pageSlots.find((slot) => slot.member.key === selectedKey);
  if (selected) {
    renderAgentDetail(byId('office-detail'), selected, 'AGENT DETAIL');
  } else {
    const panel = byId('office-detail');
    panel.replaceChildren(
      element('p', 'eyebrow', 'AGENT DETAIL'),
      element('h3', '', 'Select a workstation'),
      element(
        'p',
        'muted',
        'Click a character, desk, or accessible station control to manage that agent.',
      ),
    );
  }
}

function renderSquad(snapshot) {
  const grid = byId('squad-grid');
  grid.replaceChildren();

  if (!snapshot) {
    grid.append(element('p', 'muted', 'No agent snapshot is available. Open Diagnostics for details.'));
    renderUnassigned(undefined);
    return;
  }

  for (const slot of visibleSlots(snapshot)) {
    const session = slot.session;
    const theme = identityFor(slot.member.key, slot.member.label);
    const card = element('article', 'specialist-card');
    card.style.setProperty('--identity', theme.color);

    const heading = element('div', 'card-heading');
    const ident = element('div', 'identity');
    ident.append(element('span', 'sigil', theme.sigil));
    const nameBlock = element('div');
    nameBlock.append(element('h3', '', slot.member.label));
    nameBlock.append(element('p', '', slot.member.role ?? slot.member.agent));
    ident.append(nameBlock);
    heading.append(ident);

    const stateName = slotState(slot);
    heading.append(element('span', `state-pill ${statusClass(stateName)}`, stateName));
    card.append(heading);

    const status = element('div', 'card-status');
    const temperature = session ? (session.cold ? 'Cold' : 'Hot') : 'Not running';
    status.append(
      element(
        'span',
        `temperature-pill ${!session || session.cold ? 'is-cold' : 'is-hot'}`,
        temperature,
      ),
    );
    if (session?.pinned) status.append(element('span', 'pin-pill', 'Pinned'));
    if (slot.validation?.launchable === false) {
      status.append(
        element(
          'span',
          'state-pill is-bad',
          slot.validation.found ? 'Definition blocked' : 'Agent missing',
        ),
      );
    }
    if (slot.staleBinding) status.append(element('span', 'state-pill is-warning', 'Stale binding'));
    const missionBadge = assignmentBadge(slot.member.key);
    if (missionBadge) {
      const badge = element(
        'span',
        'mission-assignment-pill',
        missionBadge.label,
      );
      badge.title = assignmentText(missionBadge);
      status.append(badge);
    }
    card.append(status);

    const actions = element('div', 'card-actions');
    if (slot.bindingState === 'none') {
      const start = element('button', 'button button-primary', 'Start');
      start.disabled = !canStart(slot);
      start.addEventListener('click', async () => {
        await runAction(start, 'Starting…', () =>
          window.DecagramCouncilSceneViewModel.invokeProfileStart(slot, profileActions),
        );
      });
      actions.append(start);
    }
    const details = element('button', 'button', 'Details');
    details.addEventListener('click', () => {
      selectedKey = slot.member.key;
      renderDetail(slot);
    });
    actions.append(details);
    if (session?.id && slot.bindingState === 'active') {
      const stop = element('button', 'button button-danger', 'Stop');
      stop.disabled = !actionsFor(slot).stop;
      stop.addEventListener('click', async () => {
        await runAction(stop, 'Stopping…', () => profileActions.stop(slot.member.key));
      });
      actions.append(stop);
    }
    if (slot.bindingState === 'terminal' || slot.bindingState === 'failed') {
      const resume = element('button', 'button button-primary', 'Resume');
      resume.disabled = !actionsFor(slot).resume;
      resume.addEventListener('click', async () => {
        await runAction(resume, 'Resuming…', () => profileActions.resume(slot.member.key));
      });
      const startNew = element('button', 'button', 'Start new');
      startNew.disabled = !actionsFor(slot).startNew;
      startNew.addEventListener('click', async () => {
        await runAction(startNew, 'Starting…', () =>
          profileActions.startNew(
            slot.member.key,
            slot.validation?.fingerprint,
          ),
        );
      });
      actions.append(resume, startNew);
    }
    if (slot.bindingState === 'stale') {
      const clear = element('button', 'button', 'Clear binding');
      clear.disabled = !actionsFor(slot).clear;
      clear.addEventListener('click', async () => {
        await runAction(clear, 'Clearing…', () => profileActions.clear(slot.member.key));
      });
      actions.append(clear);
    }
    card.append(actions);
    grid.append(card);
  }

  const selected = visibleSlots(snapshot).find((slot) => slot.member.key === selectedKey);
  if (selected) renderDetail(selected);
  renderUnassigned(snapshot);
}

function renderUnassigned(snapshot) {
  const list = byId('unassigned-sessions');
  list.replaceChildren();
  const sessions = snapshot?.roster.unassigned ?? [];
  if (sessions.length === 0) {
    list.append(element('li', '', 'No unassigned background sessions.'));
    return;
  }
  for (const session of sessions) {
    list.append(
      element(
        'li',
        '',
        `${session.name ?? 'Unnamed'} · ${session.id ?? 'no short id'} · ${session.state ?? 'unknown'} · ${session.cwd ?? 'cwd unknown'}`,
      ),
    );
  }
}

function processLiveness(session) {
  if (typeof session.pid === 'number') return `Alive · PID ${session.pid}`;
  if (session.state === 'done' || session.state === 'failed') {
    return 'Exited · will resume on contact';
  }
  if (session.state === 'stopped') return 'Exited · explicitly stopped';
  return 'Unknown · PID not reported';
}

function sessionAge(startedAt) {
  if (!startedAt) return 'Unknown';
  const milliseconds = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unknown';
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.floor(hours / 24)} days`;
}

function renderBackgroundRoster(snapshot) {
  const host = byId('background-roster');
  host.replaceChildren();
  const sessions = (snapshot?.roster.sessions ?? []).filter(
    (session) => session.kind === 'background',
  );
  if (sessions.length === 0) {
    host.append(
      element(
        'p',
        'cold-state',
        snapshot?.rosterError
          ? 'The roster call failed. Its error is available in Diagnostics.'
          : 'No background sessions yet. Start an agent when you are ready.',
      ),
    );
    return;
  }

  const table = element('table', 'roster-table');
  const head = element('thead');
  const heading = element('tr');
  for (const label of ['Name', 'Session state', 'Working directory', 'Age', 'Process liveness']) {
    heading.append(element('th', '', label));
  }
  head.append(heading);
  const body = element('tbody');
  for (const session of sessions) {
    const row = element('tr');
    for (const value of [
      session.name ?? 'Unknown',
      session.state ?? 'Unknown',
      session.cwd ?? 'Unknown',
      sessionAge(session.startedAt),
      processLiveness(session),
    ]) {
      row.append(element('td', '', value));
    }
    body.append(row);
  }
  table.append(head, body);
  host.append(table);
}

function appendMeta(list, label, value) {
  list.append(element('dt', '', label), element('dd', '', value ?? '—'));
}

function renderDetail(slot) {
  renderAgentDetail(byId('session-detail'), slot, 'SESSION DETAIL');
}

function renderAgentDetail(panel, slot, kicker, options = {}) {
  panel.replaceChildren();
  const session = slot.session;
  panel.append(element('p', 'eyebrow', kicker));
  panel.append(element('h3', '', slot.member.label));

  const profile = element('dl', 'detail-meta');
  appendMeta(profile, 'Profile', slot.member.key);
  appendMeta(profile, 'Definition', slot.member.agent);
  appendMeta(profile, 'Role', slot.member.role);
  appendMeta(profile, 'Scope', slot.validation?.scope);
  appendMeta(profile, 'Source', slot.validation?.path);
  appendMeta(profile, 'Fingerprint', slot.validation?.fingerprint);
  appendMeta(profile, 'Launch folder', slot.member.cwd);
  appendMeta(profile, 'Binding', slot.bindingState);
  const missionBadge = assignmentBadge(slot.member.key);
  if (missionBadge) {
    appendMeta(profile, 'Mission', missionBadge.missionTitle);
    appendMeta(profile, 'Task', `${missionBadge.label} · ${missionBadge.taskState}`);
    appendMeta(
      profile,
      'Mission provider',
      missionBadge.providerId === 'claude-code'
        ? 'Claude Code'
        : missionBadge.providerId === 'codex'
          ? 'Codex'
          : 'Pending',
    );
  }
  panel.append(profile);
  if (slot.validation?.diagnostic) {
    panel.append(element('p', 'muted', slot.validation.diagnostic));
  }
  if (slot.validation?.shadowedBy?.length) {
    panel.append(
      element(
        'p',
        'muted',
        `Shadowed definitions: ${slot.validation.shadowedBy.join(' · ')}`,
      ),
    );
  }
  if (slot.validation?.candidatePaths?.length) {
    panel.append(
      element(
        'p',
        'muted',
        `Conflicting definitions: ${slot.validation.candidatePaths.join(' · ')}`,
      ),
    );
  }

  if (!session?.id) {
    const message =
      slot.bindingState === 'unavailable'
        ? 'Council has an exact durable binding, but the provider roster is unavailable. No stale-binding claim or lifecycle action is available until it reconnects.'
        : slot.staleBinding
        ? 'The exact bound session is missing. Clearing this binding will not stop or delete Claude work.'
        : slot.validation?.launchable === false
          ? slot.validation.diagnostic ?? 'The definition cannot launch.'
          : 'This agent is available and has not been started.';
    panel.append(element('p', 'muted', message));
    if (slot.bindingState === 'unavailable') {
      return;
    }
    if (slot.staleBinding) {
      const clear = element('button', 'button', 'Clear binding');
      clear.disabled = !actionsFor(slot).clear;
      clear.addEventListener('click', async () => {
        await runAction(clear, 'Clearing…', () => profileActions.clear(slot.member.key));
      });
      panel.append(clear);
    } else if (options.allowStart !== false) {
      const start = element('button', 'button button-primary', 'Start agent');
      start.disabled = !canStart(slot);
      start.addEventListener('click', async () => {
        await runAction(start, 'Starting…', () =>
          window.DecagramCouncilSceneViewModel.invokeProfileStart(slot, profileActions),
        );
      });
      panel.append(start);
    }
    return;
  }

  const meta = element('dl', 'detail-meta');
  appendMeta(meta, 'Session', session.id);
  appendMeta(meta, 'State', session.state ?? 'unknown');
  appendMeta(meta, 'Current work', session.waitingFor ?? session.detail ?? session.intent);
  appendMeta(meta, 'Started', humanDate(session.startedAt));
  appendMeta(meta, 'Updated', humanDate(session.updatedAt));
  panel.append(meta);

  const log = element('pre', 'log-output', 'Select “Load recent output” to read this session.');
  const load = element('button', 'button', 'Load recent output');
  load.disabled = !actionsFor(slot).logs;
  load.addEventListener('click', async () => {
    const result = await runAction(load, 'Loading…', () => profileActions.logs(slot.member.key));
    log.textContent = result?.ok ? result.value || '(No output)' : result?.message ?? 'Unable to load output.';
  });
  const actions = element('div', 'card-actions');
  actions.append(load);
  if (slot.bindingState === 'active') {
    const stop = element('button', 'button button-danger', 'Stop session');
    stop.disabled = !actionsFor(slot).stop;
    stop.addEventListener('click', async () => {
      await runAction(stop, 'Stopping…', () => profileActions.stop(slot.member.key));
    });
    actions.append(stop);
  }
  if (slot.bindingState === 'terminal' || slot.bindingState === 'failed') {
    if (options.allowResume !== false) {
      const resume = element('button', 'button button-primary', 'Resume');
      resume.disabled = !actionsFor(slot).resume;
      resume.addEventListener('click', async () => {
        await runAction(resume, 'Resuming…', () =>
          profileActions.resume(slot.member.key),
        );
      });
      actions.append(resume);
    }
    if (options.allowStartNew !== false) {
      const startNew = element('button', 'button', 'Start new');
      startNew.disabled = !actionsFor(slot).startNew;
      startNew.addEventListener('click', async () => {
        await runAction(startNew, 'Starting…', () =>
          profileActions.startNew(
            slot.member.key,
            slot.validation?.fingerprint,
          ),
        );
      });
      actions.append(startNew);
    }
  }
  panel.append(actions, log);

  const replyRow = element('div', 'reply-row');
  const reply = element('input');
  reply.type = 'text';
  reply.placeholder = canReply(slot)
    ? session.state === 'done' || session.state === 'failed'
      ? 'Send a reply and resume this conversation'
      : 'Send a plain-text reply'
    : session.waitingFor && session.waitingFor !== 'input needed'
      ? `Reply disabled: waiting for ${session.waitingFor}`
      : session.state === 'stopped'
        ? 'Reply disabled: this session was explicitly stopped'
        : 'Reply unavailable unless waiting for ordinary text input';
  reply.disabled = !canReply(slot);
  const wakesSession = session.state === 'done' || session.state === 'failed';
  const send = element(
    'button',
    'button button-primary',
    wakesSession ? 'Reply & resume' : 'Send',
  );
  send.disabled = !canReply(slot);
  send.addEventListener('click', async () => {
    const result = await runAction(send, 'Sending…', () =>
      profileActions.reply(slot.member.key, reply.value),
    );
    if (result?.ok) {
      reply.value = '';
      setFeedback(result.value.acknowledged ? 'Reply delivered and acknowledged.' : 'Reply delivered.');
    }
  });
  reply.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !send.disabled) send.click();
  });
  replyRow.append(reply, send);
  panel.append(replyRow);
}

function renderCouncil(snapshot) {
  const panel = byId('council-session');
  const slot = window.DecagramCouncilSceneViewModel.findCouncilSlot(snapshot);
  if (slot === undefined) {
    panel.replaceChildren(
      element('p', 'eyebrow', 'COUNCIL SESSION'),
      element('h3', '', 'Council lead unavailable'),
      element(
        'p',
        'muted',
        'A launchable explicitly internal council-lead definition is required.',
      ),
    );
  } else {
    renderAgentDetail(panel, slot, 'COUNCIL SESSION', {
      allowStart: false,
      allowStartNew: false,
    });
  }

  const councilButton = byId('council-form').querySelector(
    'button[type="submit"]',
  );
  const fingerprint = slot?.validation?.fingerprint;
  const definitionReady =
    slot?.validation?.launchable === true &&
    /^[0-9a-f]{64}$/.test(fingerprint ?? '');
  councilButton.disabled =
    state?.capabilities.councilReview !== true ||
    snapshot?.definitionError !== undefined ||
    !definitionReady;
  councilButton.textContent =
    slot?.bindingState === 'none'
      ? 'Start council review'
      : 'Start new council review';
}

function providerDisplayName(providerId) {
  return providerId === 'claude-code' ? 'Claude Code' : 'Codex';
}

function missionProviderStatus(providerId) {
  return (
    window.DecagramCouncilMissionViewModel.providerStatus(missionState, providerId) ?? {
      providerId,
      displayName: providerDisplayName(providerId),
      available: false,
      authenticated: false,
      protocolReady: false,
      persistentConversations: false,
      approvals: false,
      diagnostic: 'Provider status has not been reported.',
    }
  );
}

function providerReady(provider) {
  return (
    provider.available === true &&
    provider.authenticated === true &&
    provider.protocolReady === true
  );
}

function renderMissionProviders() {
  const grid = byId('mission-provider-status');
  grid.replaceChildren();
  for (const providerId of ['claude-code', 'codex']) {
    const provider = missionProviderStatus(providerId);
    const card = element('article', 'provider-status-card');
    const heading = element('div', 'provider-status-heading');
    heading.append(
      element('h3', '', provider.displayName),
      element(
        'span',
        `provider-pill ${window.DecagramCouncilMissionViewModel.providerTone(provider)}`,
        providerReady(provider)
          ? 'Ready'
          : !provider.available
            ? 'Unavailable'
            : !provider.authenticated
              ? 'Sign-in required'
              : 'Protocol blocked',
      ),
    );
    card.append(heading);
    const capabilities = [];
    if (provider.persistentConversations) capabilities.push('persistent conversations');
    if (provider.approvals) capabilities.push('approval-aware');
    card.append(
      element(
        'p',
        'muted provider-capabilities',
        capabilities.length > 0
          ? capabilities.join(' · ')
          : 'No mission capabilities reported.',
      ),
    );
    if (provider.diagnostic) {
      card.append(element('p', 'provider-diagnostic', provider.diagnostic));
    }
    grid.append(card);
  }
}

function preferredMissionProvider() {
  const claude = missionProviderStatus('claude-code');
  const codex = missionProviderStatus('codex');
  if (providerReady(claude)) return 'claude-code';
  if (providerReady(codex)) return 'codex';
  return 'claude-code';
}

function refreshMissionGateAssignmentOptions(snapshot) {
  const testSelect = byId('mission-test-profile');
  const reviewSelect = byId('mission-review-profile');
  const previousTest = testSelect.value;
  const previousReview = reviewSelect.value;
  const roles = visibleSlots(snapshot).filter((slot) => {
    const selection = missionRoleSelections.get(slot.member.key);
    return (
      selection?.selected === true &&
      selection.writeCapable === false
    );
  });

  const populate = (select, previous, fallbackIndex, counterpart) => {
    select.replaceChildren();
    const empty = element(
      'option',
      '',
      roles.length === 0
        ? 'Select two read-only roles'
        : 'Choose a read-only role',
    );
    empty.value = '';
    select.append(empty);
    for (const slot of roles) {
      const option = element('option', '', slot.member.label);
      option.value = slot.member.key;
      select.append(option);
    }
    const available = new Set(roles.map((slot) => slot.member.key));
    if (available.has(previous) && previous !== counterpart) {
      select.value = previous;
      return;
    }
    const fallback =
      roles.find((slot, index) =>
        index >= fallbackIndex && slot.member.key !== counterpart,
      ) ??
      roles.find((slot) => slot.member.key !== counterpart);
    select.value = fallback?.member.key ?? '';
  };

  populate(testSelect, previousTest, 0, previousReview);
  populate(reviewSelect, previousReview, 1, testSelect.value);
  testSelect.disabled = roles.length < 2;
  reviewSelect.disabled = roles.length < 2;
}

function renderMissionRoles(snapshot) {
  const container = byId('mission-role-options');
  container.replaceChildren();
  const slots = visibleSlots(snapshot).filter(
    (slot) =>
      slot.validation?.launchable === true &&
      /^[0-9a-f]{64}$/.test(slot.validation?.fingerprint ?? ''),
  );
  if (slots.length === 0) {
    container.append(
      element(
        'p',
        'muted',
        'No launchable agent definitions are available for a mission.',
      ),
    );
    refreshMissionGateAssignmentOptions(snapshot);
    return;
  }

  for (const slot of slots) {
    const saved = missionRoleSelections.get(slot.member.key) ?? {
      selected: false,
      providerId: preferredMissionProvider(),
      writeCapable: false,
    };
    missionRoleSelections.set(slot.member.key, saved);

    const row = element('div', 'mission-role-row');
    const identity = element('label', 'mission-role-identity');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = saved.selected;
    checkbox.setAttribute('aria-label', `Assign ${slot.member.label}`);
    identity.append(
      checkbox,
      element(
        'span',
        '',
        `${slot.member.label} · ${slot.member.role ?? slot.member.agent}`,
      ),
    );

    const providerLabel = element('label', 'mission-role-control');
    providerLabel.append(element('span', '', 'Provider'));
    const providerSelect = element('select');
    providerSelect.setAttribute(
      'aria-label',
      `Provider for ${slot.member.label}`,
    );
    for (const providerId of ['claude-code', 'codex']) {
      const provider = missionProviderStatus(providerId);
      const option = element(
        'option',
        '',
        `${provider.displayName}${providerReady(provider) ? '' : ' — unavailable'}`,
      );
      option.value = providerId;
      option.selected = saved.providerId === providerId;
      providerSelect.append(option);
    }
    providerLabel.append(providerSelect);

    const accessLabel = element('label', 'mission-role-control');
    accessLabel.append(element('span', '', 'Access'));
    const accessSelect = element('select');
    accessSelect.setAttribute(
      'aria-label',
      `Access for ${slot.member.label}`,
    );
    for (const [value, label] of [
      ['read-only', 'Read only'],
      ['workspace-write', 'Workspace write'],
    ]) {
      const option = element('option', '', label);
      option.value = value;
      option.selected = saved.writeCapable === (value === 'workspace-write');
      accessSelect.append(option);
    }
    accessLabel.append(accessSelect);

    checkbox.addEventListener('change', () => {
      saved.selected = checkbox.checked;
      refreshMissionGateAssignmentOptions(snapshot);
    });
    providerSelect.addEventListener('change', () => {
      saved.providerId = providerSelect.value;
    });
    accessSelect.addEventListener('change', () => {
      saved.writeCapable = accessSelect.value === 'workspace-write';
      refreshMissionGateAssignmentOptions(snapshot);
    });
    row.append(identity, providerLabel, accessLabel);
    container.append(row);
  }
  refreshMissionGateAssignmentOptions(snapshot);
}

function boundedLineItems(value) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function renderHandoffPanel() {
  const panel = byId('handoff-panel');
  panel.hidden = pendingHandoffTarget === undefined;
  if (!pendingHandoffTarget) return;
  const { mission, task } = pendingHandoffTarget;
  byId('handoff-target').textContent =
    `${mission.title} · ${task.title} · execution ${task.execution.id} · lease ${task.lease.id}`;
  byId('handoff-commit').value = task.activeHandoff?.commitSha ?? '';
  byId('handoff-tree').value = '';
}

function renderGatePanel(snapshot) {
  const panel = byId('gate-panel');
  panel.hidden = pendingGateTarget === undefined;
  const meta = byId('gate-candidate-meta');
  const executor = byId('gate-executor');
  meta.replaceChildren();
  executor.replaceChildren();
  if (!pendingGateTarget) return;

  const { mission, candidate } = pendingGateTarget;
  appendMeta(meta, 'Mission', mission.title);
  appendMeta(meta, 'Candidate commit', candidate.commitSha);
  appendMeta(meta, 'Candidate tree', candidate.treeSha);
  appendMeta(meta, 'Target', candidate.targetLabel);

  const producerProfiles = new Set(
    mission.tasks
      .filter((task) => task.activeHandoff !== undefined)
      .map((task) => task.assigneeProfileId)
      .filter(Boolean),
  );
  const kind = byId('gate-kind').value;
  const counterpart =
    kind === 'test' ? mission.reviewGate : mission.testGate;
  if (counterpart) producerProfiles.add(counterpart.executorProfileId);
  const gateExecutors = visibleSlots(snapshot).filter(
    (slot) =>
      !producerProfiles.has(slot.member.key) &&
      mission.tasks.some(
        (task) =>
          task.assigneeProfileId === slot.member.key &&
          task.execution?.gateResponsibility === kind &&
          task.execution.accessMode === 'read-only',
      ),
  );
  for (const slot of gateExecutors) {
    const option = element('option', '', slot.member.label);
    option.value = slot.member.key;
    executor.append(option);
  }
  if (gateExecutors.length === 0) {
    const option = element('option', '', 'No independent executor');
    option.value = '';
    executor.append(option);
  }

  const policy = missionState?.gatePolicy;
  const fingerprint = byId('gate-policy-fingerprint');
  fingerprint.value = policy?.fingerprint ?? '';
  fingerprint.readOnly = true;
  const commandIds = byId('gate-command-ids');
  commandIds.value =
    kind === 'test'
      ? (policy?.testCommandIds ?? []).join('\n')
      : (policy?.reviewCommandIds ?? []).join('\n');
  commandIds.readOnly = true;
  const submit = byId('gate-form').querySelector('button[type="submit"]');
  submit.disabled =
    policy === undefined ||
    !/^[0-9a-f]{64}$/.test(policy.fingerprint) ||
    gateExecutors.length === 0;
}

function renderSquadPreview() {
  const section = byId('squad-preview');
  const preview = pendingSquadPreview;
  section.hidden = preview === undefined;
  const meta = byId('squad-preview-meta');
  const participants = byId('squad-preview-participants');
  const gates = byId('squad-preview-gates');
  const blockers = byId('squad-preview-blockers');
  meta.replaceChildren();
  participants.replaceChildren();
  gates.replaceChildren();
  blockers.replaceChildren();
  if (!preview) return;

  appendMeta(meta, 'Mission', preview.missionId);
  appendMeta(meta, 'Ledger revision', String(preview.revision));
  appendMeta(meta, 'Repository HEAD', preview.repositoryHeadSha);
  appendMeta(meta, 'Preview fingerprint', preview.digest);
  for (const participant of preview.participants) {
    const item = element('li', 'mission-participant');
    item.append(
      element(
        'strong',
        '',
        `${participant.profileId} · ${providerDisplayName(participant.providerId)}`,
      ),
      element(
        'span',
        'muted',
        `${participant.providerAction} · ${participant.accessMode} · ${
          participant.launchable ? 'launchable' : 'blocked'
        }`,
      ),
      element(
        'span',
        'mission-provider-evidence',
        `Provider ${participant.providerAvailable ? 'available' : 'unavailable'} · ${
          participant.providerAuthenticated
            ? 'authenticated'
            : 'authentication required'
        } · protocol ${
          participant.protocolReady ? 'ready' : 'blocked'
        }`,
      ),
      element(
        'span',
        'mission-exact-evidence',
        participant.leaseId
          ? `Definition ${participant.definitionFingerprint} · lease ${participant.leaseId} · base ${participant.baseCommitSha ?? 'pending'}`
          : `Definition ${participant.definitionFingerprint} · no write lease required`,
      ),
      element(
        'pre',
        'mission-role-instructions',
        participant.roleInstructions === undefined
          ? 'Effective role instructions unavailable: this assignment is hard-blocked.'
          : participant.roleInstructions,
      ),
      element(
        'span',
        'mission-exact-evidence',
        `Role instruction fingerprint ${participant.roleInstructionFingerprint}`,
      ),
    );
    if (participant.diagnostic) {
      item.append(element('span', 'state-pill is-warning', participant.diagnostic));
    }
    participants.append(item);
  }
  for (const gate of [
    preview.gateAssignments.test,
    preview.gateAssignments.review,
  ]) {
    const item = element('li', 'mission-participant');
    item.append(
      element(
        'strong',
        '',
        `${gate.kind === 'test' ? 'Test' : 'Review'} · ${gate.profileId}`,
      ),
      element('span', 'muted', `Task ${gate.taskId}`),
      element(
        'span',
        'mission-exact-evidence',
        'Exact read-only Mission execution ID will be allocated on confirmed Start Squad.',
      ),
    );
    gates.append(item);
  }
  for (const blocker of preview.blockers) {
    blockers.append(element('li', '', blocker));
  }
  const start = byId('start-squad-button');
  start.disabled = !window.DecagramCouncilMissionViewModel.canStartPreview(preview);
}

function renderIntegrationPreview() {
  const section = byId('integration-preview');
  const preview = pendingIntegrationPreview;
  section.hidden = preview === undefined;
  const meta = byId('integration-preview-meta');
  meta.replaceChildren();
  if (!preview) return;
  appendMeta(meta, 'Mission', preview.missionId);
  appendMeta(meta, 'Candidate commit', preview.candidateCommitSha);
  appendMeta(meta, 'Candidate tree', preview.candidateTreeSha);
  appendMeta(meta, 'Target', preview.targetLabel);
  appendMeta(meta, 'Expected target commit', preview.expectedTargetCommitSha);
  appendMeta(meta, 'Expected target tree', preview.expectedTargetTreeSha);
  appendMeta(meta, 'Passed test gate', preview.testGateId);
  appendMeta(meta, 'Passed review gate', preview.reviewGateId);
  appendMeta(meta, 'Approval revision', String(preview.approvalRevision));
  appendMeta(meta, 'Approval fingerprint', preview.digest);
  byId('approve-integration-button').disabled =
    !window.DecagramCouncilMissionViewModel.canApproveIntegration(preview);
}

function gateLine(label, gate) {
  if (!gate) return `${label}: not recorded`;
  const commands =
    (gate.commandIds ?? []).length > 0
      ? gate.commandIds.join(', ')
      : 'provider review';
  return `${label}: ${gate.status} · commit ${shortSha(gate.commitSha)} · tree ${shortSha(gate.treeSha)} · executor ${gate.executorProfileId}/${gate.executorExecutionId} · policy ${shortSha(gate.gatePolicyFingerprint)} · ${commands}`;
}

function renderMissionList() {
  const list = byId('mission-list');
  list.replaceChildren();
  const missions = missionState?.projection?.missions ?? [];
  if (missions.length === 0) {
    list.append(
      element(
        'p',
        'muted',
        missionState?.problem ??
          'No Council-owned missions have been recorded in this workspace.',
      ),
    );
    return;
  }

  for (const mission of missions) {
    const card = element('article', 'mission-card');
    const heading = element('div', 'mission-card-heading');
    const title = element('div');
    title.append(
      element('h3', '', mission.title),
      element('p', 'mission-objective', mission.objective),
    );
    heading.append(
      title,
      element('span', `state-pill ${statusClass(mission.phase)}`, mission.phase),
    );
    card.append(heading);

    const tasks = element('ol', 'mission-task-list');
    for (const task of mission.tasks) {
      const item = element('li', 'mission-task');
      const taskHeading = element('div', 'mission-task-heading');
      taskHeading.append(
        element('strong', '', task.title),
        element('span', 'state-pill', task.state),
      );
      item.append(taskHeading);
      const facts = [];
      if (task.assigneeProfileId) facts.push(`Assigned ${task.assigneeProfileId}`);
      if (task.execution) {
        facts.push(
          `${providerDisplayName(task.execution.providerId)} · ${task.execution.state} · ${task.execution.providerAction} · ${task.execution.accessMode}${
            task.execution.gateResponsibility
              ? ` · ${task.execution.gateResponsibility === 'test' ? 'Test' : 'Review'} gate responsibility`
              : ''
          }`,
        );
      }
      if (task.lease) {
        facts.push(
          `${task.lease.accessMode} lease ${task.lease.id} · ${task.lease.state} · base ${shortSha(task.lease.baseCommitSha)}`,
        );
      }
      item.append(
        element(
          'p',
          'muted mission-task-facts',
          facts.join(' · ') || 'Not assigned',
        ),
      );
      if (
        missionState?.status === 'ready' &&
        task.state === 'blocked' &&
        task.execution?.state === 'blocked'
      ) {
        const retryButton = element(
          'button',
          'button button-compact',
          'Retry exact assignment',
        );
        retryButton.type = 'button';
        retryButton.addEventListener('click', async () => {
          const result = await runAction(retryButton, 'Retrying…', () =>
            api.retryMissionExecution({
              expectedRevision: missionState.revision,
              executionId: task.execution.id,
            }),
          );
          if (result?.ok) {
            byId('mission-feedback').textContent =
              `${providerDisplayName(result.value.execution.providerId)} assignment is ${result.value.execution.state}.`;
            await refreshMissionState();
          }
        });
        item.append(retryButton);
      }
      if (
        task.execution &&
        task.lease?.state === 'ready' &&
        task.lease.accessMode === 'workspace-write' &&
        ['running', 'blocked', 'handoff-ready'].includes(task.state)
      ) {
        const handoffButton = element(
          'button',
          'button button-compact',
          task.activeHandoff ? 'Supersede handoff' : 'Record handoff',
        );
        handoffButton.type = 'button';
        handoffButton.addEventListener('click', () => {
          pendingHandoffTarget = { mission, task };
          renderHandoffPanel();
          byId('handoff-panel').scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        });
        item.append(handoffButton);
      }
      if (task.activeHandoff) {
        const handoff = element('div', 'mission-handoff');
        handoff.append(
          element('strong', '', 'Exact handoff'),
          element('span', '', task.activeHandoff.summary),
          element(
            'code',
            '',
            `commit ${task.activeHandoff.commitSha} · tree ${task.activeHandoff.treeSha}`,
          ),
        );
        item.append(handoff);
      }
      tasks.append(item);
    }
    card.append(tasks);

    const gates = element('div', 'mission-gates');
    gates.append(
      element('p', '', gateLine('Test gate', mission.testGate)),
      element('p', '', gateLine('Review gate', mission.reviewGate)),
    );
    for (const gate of [mission.testGate, mission.reviewGate].filter(Boolean)) {
      if ((gate.evidence ?? []).length > 0) {
        gates.append(
          element(
            'p',
            'mission-gate-evidence',
            `${gate.kind} evidence: ${gate.evidence.join(' · ')}`,
          ),
        );
      }
    }
    card.append(gates);

    const activeHandoffs = mission.tasks
      .map((task) => task.activeHandoff)
      .filter(Boolean);
    if (
      activeHandoffs.length > 0 &&
      mission.latestCandidate?.state !== 'ready'
    ) {
      const createCandidate = element(
        'button',
        'button',
        'Build candidate from exact handoffs',
      );
      createCandidate.type = 'button';
      createCandidate.addEventListener('click', async () => {
        const result = await runAction(createCandidate, 'Building…', () =>
          api.createCandidate({
            expectedRevision: missionState.revision,
            missionId: mission.id,
            orderedHandoffIds: activeHandoffs.map((handoff) => handoff.id),
          }),
        );
        if (result?.ok) {
          byId('mission-feedback').textContent =
            `Candidate ${shortSha(result.value.commitSha)} prepared for independent gates.`;
          await refreshMissionState();
        }
      });
      card.append(createCandidate);
    }

    if (mission.latestCandidate) {
      const candidate = mission.latestCandidate;
      const candidatePanel = element('div', 'mission-candidate');
      candidatePanel.append(
        element(
          'p',
          '',
          `Candidate ${candidate.state} · commit ${candidate.commitSha} · tree ${candidate.treeSha} · target ${candidate.targetLabel}`,
        ),
      );
      if (candidate.state === 'ready') {
        const recordGate = element('button', 'button', 'Run independent gate');
        recordGate.type = 'button';
        recordGate.addEventListener('click', () => {
          pendingGateTarget = { mission, candidate };
          renderGatePanel(state?.snapshot);
          byId('gate-panel').scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        });
        const preview = element('button', 'button', 'Preview integration');
        preview.type = 'button';
        preview.disabled = missionState?.status !== 'ready';
        preview.addEventListener('click', async () => {
          const result = await runAction(preview, 'Previewing…', () =>
            api.previewIntegration({
              missionId: mission.id,
              candidateId: candidate.id,
              expectedRevision: missionState.revision,
            }),
          );
          if (result?.ok) {
            pendingIntegrationPreview = result.value;
            renderIntegrationPreview();
          }
        });
        candidatePanel.append(recordGate, preview);
      }
      card.append(candidatePanel);
    }
    list.append(card);
  }
}

function renderMissions(snapshot) {
  byId('mission-revision').textContent =
    missionState?.status === 'ready'
      ? `LEDGER REVISION ${missionState.revision}`
      : missionState?.status === 'blocked'
        ? 'LEDGER BLOCKED'
        : 'LEDGER UNAVAILABLE';
  renderMissionProviders();
  renderMissionRoles(snapshot);
  renderSquadPreview();
  renderHandoffPanel();
  renderGatePanel(snapshot);
  renderIntegrationPreview();
  renderMissionList();
}

async function refreshMissionState() {
  try {
    const result = await api.getMissionState();
    missionState = result.ok
      ? result.value
      : {
          status: 'unavailable',
          workspaceId: state?.workspace.id,
          revision: 0,
          problem: result.message,
          providers: [],
          gatePolicy: undefined,
          projection: undefined,
        };
  } catch (error) {
    missionState = {
      status: 'unavailable',
      workspaceId: state?.workspace.id,
      revision: 0,
      problem: error instanceof Error ? error.message : String(error),
      providers: [],
      gatePolicy: undefined,
      projection: undefined,
    };
  }
  if (state) render();
  else renderMissions(undefined);
}

function diagnosticCard(label, value, detail, tone) {
  const card = element('article', 'diagnostic-card');
  card.append(element('h3', '', label));
  card.append(element('p', `diagnostic-value ${tone ?? ''}`, value));
  card.append(element('p', 'diagnostic-detail', detail));
  return card;
}

function providerDiagnosticCards() {
  return ['claude-code', 'codex'].map((providerId) => {
    const provider = missionProviderStatus(providerId);
    const value = providerReady(provider)
      ? 'Mission ready'
      : !provider.available
        ? 'Unavailable'
        : !provider.authenticated
          ? 'Authentication required'
          : 'Protocol unavailable';
    const detail = [
      provider.persistentConversations ? 'Persistent conversations' : 'No persistent conversations',
      provider.approvals ? 'approval-aware' : 'no approval protocol',
      provider.diagnostic,
    ]
      .filter(Boolean)
      .join(' · ');
    return diagnosticCard(
      `${provider.displayName} provider`,
      value,
      detail,
      window.DecagramCouncilMissionViewModel.providerTone(provider),
    );
  });
}

function renderDiagnostics() {
  if (!state) return;
  const p = state.preflight;
  const snapshot = state.snapshot;
  const grid = byId('diagnostics-grid');
  if (!p) {
    grid.replaceChildren(
      diagnosticCard(
        'Workspace',
        state.workspace.status === 'setup' ? 'Setup required' : 'Unavailable',
        state.workspace.diagnostic ?? 'Choose and trust a repository to run preflight.',
        'is-warning',
      ),
      diagnosticCard(
        'Configuration',
        state.bindingProblem ? 'Needs attention' : 'Ready for setup',
        state.bindingProblem?.message ?? 'No runtime has been initialized.',
        state.bindingProblem ? 'is-warning' : '',
      ),
      ...providerDiagnosticCards(),
    );
    byId('preflight-time').textContent = '';
    const list = byId('startup-messages');
    list.replaceChildren();
    const messages = [...state.startupMessages];
    if (messages.length === 0) messages.push('No startup problems reported.');
    messages.forEach((message) => list.append(element('li', '', message)));
    return;
  }
  const daemon = snapshot?.daemon ?? p.supervisor;
  const daemonValue = !daemon ? 'Unavailable' : !daemon.recognized ? 'Unknown' : daemon.running ? 'Running' : 'Resting';
  const daemonTone = p.supervisor.versionMismatch
    ? 'is-bad'
    : !daemon || !daemon.recognized
      ? 'is-warning'
      : daemon.running
        ? 'is-good'
        : '';
  const guard = p.guardSelfTest;
  const guardPassed = guard.status === 'passed';
  const claudeUsable = p.claude?.meetsMinimum === true;
  const hookCount = p.hookHandlerCount;
  grid.replaceChildren(
    diagnosticCard('Platform', p.supportedPlatform ? 'Windows supported' : `Unsupported: ${p.platform}`, 'Windows 10 or Windows 11 is required.', p.supportedPlatform ? 'is-good' : 'is-bad'),
    diagnosticCard('Claude CLI', !p.claude ? 'Not found' : claudeUsable ? 'Found' : 'Version too old', p.claude ? `${p.claude.version ?? 'version unknown'} · ${p.claude.discoveredVia}` : 'Install Claude Code for Windows or configure an override.', claudeUsable ? 'is-good' : 'is-bad'),
    diagnosticCard('PowerShell', p.powershell.available ? 'Available' : 'Missing', p.powershell.available ? `${p.powershell.version ?? 'version unknown'} · ${p.powershell.discoveredVia}` : 'Guard hooks require PowerShell.', p.powershell.available ? 'is-good' : 'is-bad'),
    diagnosticCard(
      'Git Bash',
      p.bash.available ? 'Available' : 'Missing',
      p.bash.available
        ? `${p.bash.version ?? 'version unknown'} · ${p.bash.resolvedPath ?? p.bash.discoveredVia}`
        : 'Install Git for Windows. Expected bash.exe under the Git installation bin directory.',
      p.bash.available ? 'is-good' : 'is-bad',
    ),
    diagnosticCard('Guard self-test', guardPassed ? 'Passed' : guard.status === 'failed' ? 'Failed' : 'Not verified', guardPassed ? 'Windows write and shell guards accepted their safety cases.' : guard.message, guardPassed ? 'is-good' : guard.status === 'failed' ? 'is-bad' : 'is-warning'),
    diagnosticCard('Git', p.git.available ? 'Available' : 'Missing', p.git.available ? `${p.git.version ?? 'version unknown'} · ${p.git.discoveredVia}` : 'Git for Windows is required.', p.git.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Node.js', p.node.available ? 'Available' : 'Missing', `${p.node.version ?? 'version unknown'} · ${p.node.discoveredVia}`, p.node.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Hook registration', `${hookCount} Windows handlers`, 'Edit|Write, PowerShell, TaskCompleted, and TeammateIdle are generated from one configuration.', hookCount === 4 ? 'is-good' : 'is-warning'),
    diagnosticCard('Terminal bridge', p.ptyAvailable ? 'Available' : 'Logs only', p.ptyAvailable ? 'Direct plain-text replies are enabled.' : 'Install the optional node-pty module to enable replies.', p.ptyAvailable ? 'is-good' : 'is-warning'),
    diagnosticCard(
      'Claude daemon',
      p.supervisor.versionMismatch ? 'Version mismatch' : daemonValue,
      [
        `Reachable: ${p.supervisor.reachable ? 'yes' : 'no'}`,
        `Version: ${p.supervisor.version ?? 'unknown'}`,
        `Workers: ${p.supervisor.workerCount ?? 'unknown'}`,
        p.supervisor.diagnostic,
        daemon?.raw,
      ].filter(Boolean).join('\n'),
      daemonTone,
    ),
    diagnosticCard('Agent catalog', state.catalog ? `${state.catalog.entries.length} definitions` : 'Unavailable', [...state.rosterProblems, ...(state.catalog?.diagnostics.map((problem) => problem.message) ?? [])].join(' · ') || 'Definitions and preferences parsed without reported problems.', state.rosterProblems.length || state.catalog?.diagnostics.length ? 'is-warning' : 'is-good'),
    diagnosticCard('Workspace', state.workspace.label ?? 'Unavailable', `${state.projectDir ?? 'No canonical path'}${state.workspace.developmentOverride ? ' · development override' : ''}`, state.workspace.status === 'ready' ? 'is-good' : 'is-warning'),
    diagnosticCard('Session bindings', state.bindingProblem ? 'Needs attention' : 'Loaded', state.bindingProblem?.message ?? 'Exact profile ownership store parsed without reported problems.', state.bindingProblem ? 'is-warning' : 'is-good'),
    ...providerDiagnosticCards(),
  );

  byId('preflight-time').textContent = `Checked ${humanDate(p.checkedAt)}`;
  const messages = [...state.startupMessages];
  if (snapshot?.rosterError) messages.push(snapshot.rosterError.message);
  if (snapshot?.definitionError) messages.push(snapshot.definitionError);
  if (snapshot?.roster.problems.length) {
    messages.push(...snapshot.roster.problems.map((problem) => `${problem.path}: ${problem.message}`));
  }
  if (snapshot?.catalogProblems.length) {
    messages.push(...snapshot.catalogProblems.map((problem) => `${problem.path}: ${problem.message}`));
  }
  const list = byId('startup-messages');
  list.replaceChildren();
  if (messages.length === 0) list.append(element('li', '', 'No startup problems reported.'));
  else messages.forEach((message) => list.append(element('li', '', message)));
}

function renderWorkspace() {
  const workspace = state?.workspace;
  const ready = workspace?.status === 'ready' && workspace.trusted;
  byId('workspace-setup').hidden = ready;
  document.querySelector('.tabs').hidden = !ready;
  document.querySelector('main').hidden = false;
  byId('workspace-label').textContent = workspace?.label ?? 'No workspace';
  byId('change-workspace-button').textContent = ready ? 'Change workspace' : 'Choose workspace';
  if (!ready) {
    activeView = 'diagnostics';
    document.querySelectorAll('.view').forEach((view) => {
      view.classList.toggle('is-active', view.id === 'view-diagnostics');
    });
    byId('workspace-setup-title').textContent =
      workspace?.status === 'invalid' ? 'Workspace needs attention' : 'Choose a repository';
    byId('workspace-setup-detail').textContent =
      workspace?.diagnostic ??
      'Council needs a trusted repository before it can discover or launch agent instructions.';
  }
}

function render() {
  const snapshot = state?.snapshot;
  const connection = byId('connection-state');
  renderWorkspace();
  if (state?.workspace.status !== 'ready') {
    connection.textContent = 'Workspace required';
    connection.className = 'connection-pill is-warning';
  } else if (!state?.preflight?.claude || !state.preflight.claude.meetsMinimum) {
    connection.textContent = 'Claude unavailable';
    connection.className = 'connection-pill is-bad';
  } else if (!snapshot) {
    connection.textContent = 'Connecting…';
    connection.className = 'connection-pill is-warning';
  } else {
    connection.textContent = snapshot.rosterError
      ? 'Roster stale'
      : snapshot.definitionError
        ? 'Definitions stale'
        : 'Connected';
    connection.className = `connection-pill ${
      snapshot.rosterError || snapshot.definitionError ? 'is-warning' : 'is-good'
    }`;
  }
  byId('updated-at').textContent = snapshot ? `Updated ${humanDate(snapshot.updatedAt)}` : '';
  byId('wake-button').hidden = !snapshot?.needsWake;
  byId('wake-button').disabled = state?.capabilities.start !== true;
  renderAttention(snapshot);
  renderOffice(snapshot);
  renderSquad(snapshot);
  renderBackgroundRoster(snapshot);
  renderMissions(snapshot);
  renderCouncil(snapshot);
  renderDiagnostics();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    activateView(tab.dataset.view);
  });
}

async function chooseWorkspace() {
  const button = byId('change-workspace-button');
  const setupButton = byId('workspace-setup-button');
  button.disabled = true;
  setupButton.disabled = true;
  try {
    const result = await api.chooseWorkspace();
    if (!result.ok) {
      setFeedback(result.message);
      return;
    }
    state = result.value;
    missionState = undefined;
    pendingSquadPreview = undefined;
    pendingIntegrationPreview = undefined;
    pendingHandoffTarget = undefined;
    pendingGateTarget = undefined;
    missionRoleSelections.clear();
    byId('council-project').textContent = state.projectDir ?? 'No workspace';
    render();
    await refreshMissionState();
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    setupButton.disabled = false;
  }
}

byId('change-workspace-button').addEventListener('click', chooseWorkspace);
byId('workspace-setup-button').addEventListener('click', chooseWorkspace);

byId('mission-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const feedback = byId('mission-feedback');
  const slots = visibleSlots(state?.snapshot);
  const selections = slots
    .filter(
      (slot) =>
        slot.validation?.launchable === true &&
        /^[0-9a-f]{64}$/.test(slot.validation?.fingerprint ?? ''),
    )
    .map((slot) => ({
      slot,
      choice: missionRoleSelections.get(slot.member.key),
    }))
    .filter(({ choice }) => choice?.selected === true);
  if (selections.length === 0) {
    feedback.textContent = 'Choose at least one role.';
    return;
  }
  if (missionState?.status !== 'ready') {
    feedback.textContent =
      missionState?.problem ?? 'The Mission ledger is not ready.';
    return;
  }

  const title = byId('mission-title').value;
  const objective = byId('mission-objective').value;
  const testProfileId = byId('mission-test-profile').value;
  const reviewProfileId = byId('mission-review-profile').value;
  const readOnlyProfiles = new Set(
    selections
      .filter(({ choice }) => choice.writeCapable === false)
      .map(({ slot }) => slot.member.key),
  );
  if (
    testProfileId === reviewProfileId ||
    !readOnlyProfiles.has(testProfileId) ||
    !readOnlyProfiles.has(reviewProfileId)
  ) {
    feedback.textContent =
      'Choose two distinct selected read-only roles for Test and Review.';
    return;
  }
  const created = await runAction(button, 'Creating…', () =>
    api.createMission({
      expectedRevision: missionState.revision,
      title,
      objective,
      tasks: selections.map(({ slot }) => ({
        title: `${slot.member.label} assignment`,
        description: objective,
      })),
    }),
  );
  if (!created?.ok) {
    feedback.textContent = created?.message ?? 'Mission draft could not be created.';
    return;
  }
  const mission = created.value.mission;
  if (mission.tasks.length !== selections.length) {
    feedback.textContent =
      'The Mission draft changed unexpectedly; refresh before previewing.';
    await refreshMissionState();
    return;
  }
  const previewed = await runAction(button, 'Previewing…', () =>
    api.previewSquad({
      missionId: mission.id,
      expectedRevision: created.value.revision,
      selections: selections.map(({ slot, choice }, index) => ({
        taskId: mission.tasks[index].id,
        profileId: slot.member.key,
        providerId: choice.providerId,
        expectedDefinitionFingerprint: slot.validation.fingerprint,
        writeCapable: choice.writeCapable,
      })),
      gateAssignments: {
        testProfileId,
        reviewProfileId,
      },
    }),
  );
  if (!previewed?.ok) {
    feedback.textContent =
      previewed?.message ?? 'The privileged squad preview could not be prepared.';
    await refreshMissionState();
    return;
  }
  pendingSquadPreview = previewed.value;
  feedback.textContent = 'Draft recorded. Review the exact squad preview.';
  renderSquadPreview();
  await refreshMissionState();
});

byId('handoff-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const target = pendingHandoffTarget;
  if (!target || missionState?.status !== 'ready') return;
  const button = form.querySelector('button[type="submit"]');
  const result = await runAction(button, 'Verifying…', () =>
    api.recordHandoff({
      expectedRevision: missionState.revision,
      taskId: target.task.id,
      executionId: target.task.execution.id,
      claimedCommitSha: byId('handoff-commit').value.trim(),
      claimedTreeSha: byId('handoff-tree').value.trim(),
      summary: byId('handoff-summary').value,
      evidence: boundedLineItems(byId('handoff-evidence').value),
      risks: boundedLineItems(byId('handoff-risks').value),
      ...(target.task.activeHandoff
        ? { supersedesHandoffId: target.task.activeHandoff.id }
        : {}),
    }),
  );
  if (result?.ok) {
    byId('mission-feedback').textContent =
      `Verified handoff ${result.value.id} at commit ${shortSha(result.value.commitSha)}.`;
    pendingHandoffTarget = undefined;
    form.reset();
    await refreshMissionState();
  }
});

byId('cancel-handoff-button').addEventListener('click', () => {
  pendingHandoffTarget = undefined;
  byId('handoff-form').reset();
  renderHandoffPanel();
});

byId('gate-kind').addEventListener('change', () => {
  renderGatePanel(state?.snapshot);
});

byId('gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const target = pendingGateTarget;
  const policy = missionState?.gatePolicy;
  if (!target || !policy || missionState?.status !== 'ready') return;
  const button = form.querySelector('button[type="submit"]');
  const kind = byId('gate-kind').value;
  const result = await runAction(button, 'Running gate…', () =>
    api.recordGate({
      expectedRevision: missionState.revision,
      candidateId: target.candidate.id,
      kind,
      commandIds:
        boundedLineItems(byId('gate-command-ids').value),
      gatePolicyFingerprint: byId('gate-policy-fingerprint').value,
      executorProfileId: byId('gate-executor').value,
    }),
  );
  if (result?.ok) {
    byId('mission-feedback').textContent =
      `${result.value.kind === 'test' ? 'Test' : 'Review'} gate ${result.value.status} for exact commit ${shortSha(result.value.commitSha)}.`;
    pendingGateTarget = undefined;
    form.reset();
    await refreshMissionState();
  }
});

byId('cancel-gate-button').addEventListener('click', () => {
  pendingGateTarget = undefined;
  byId('gate-form').reset();
  renderGatePanel(state?.snapshot);
});

byId('start-squad-button').addEventListener('click', async (event) => {
  const preview = pendingSquadPreview;
  if (!window.DecagramCouncilMissionViewModel.canStartPreview(preview)) return;
  const result = await runAction(event.currentTarget, 'Starting…', () =>
    api.startSquad(preview.digest),
  );
  if (result?.ok) {
    pendingSquadPreview = undefined;
    const failures = result.value.failures ?? [];
    byId('mission-feedback').textContent =
      failures.length === 0
        ? `${result.value.startedTaskIds.length} mission task(s) started.`
        : `${result.value.startedTaskIds.length} started; ${failures.length} failed.`;
    await refreshMissionState();
  }
});

byId('approve-integration-button').addEventListener(
  'click',
  async (event) => {
    const preview = pendingIntegrationPreview;
    if (!window.DecagramCouncilMissionViewModel.canApproveIntegration(preview)) return;
    const result = await runAction(event.currentTarget, 'Integrating…', () =>
      api.approveIntegration(preview.digest),
    );
    if (result?.ok) {
      pendingIntegrationPreview = undefined;
      byId('mission-feedback').textContent =
        result.value.status === 'integrated'
          ? `Integrated exact commit ${result.value.resultingCommitSha ?? 'reported by coordinator'}.`
          : `Integration ${result.value.status}.`;
      await refreshMissionState();
    }
  },
);

byId('reject-integration-button').addEventListener(
  'click',
  async (event) => {
    const preview = pendingIntegrationPreview;
    if (!preview) return;
    const result = await runAction(event.currentTarget, 'Rejecting…', () =>
      api.rejectIntegration(preview.digest),
    );
    if (result?.ok) {
      pendingIntegrationPreview = undefined;
      byId('mission-feedback').textContent = 'Integration candidate rejected.';
      await refreshMissionState();
    }
  },
);

byId('refresh-missions-button').addEventListener(
  'click',
  refreshMissionState,
);

officeRenderer = window.CouncilPixelOffice.create(byId('pixel-office'), {
  onAgentSelected(key) {
    selectedKey = key;
    renderOffice(state?.snapshot);
  },
  onRoomSelected(room) {
    if (room === 'diagnostics') activateView('diagnostics');
    if (room === 'council') activateView('council');
  },
});

byId('office-previous').addEventListener('click', () => {
  officePage = Math.max(0, officePage - 1);
  selectedKey = undefined;
  renderOffice(state?.snapshot);
});

byId('office-next').addEventListener('click', () => {
  officePage += 1;
  selectedKey = undefined;
  renderOffice(state?.snapshot);
});

window.addEventListener('keydown', (event) => {
  const target = event.target;
  const tagName = target?.tagName ?? '';
  if (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target?.isContentEditable
  ) {
    return;
  }
  if (event.key.toLowerCase() !== 'v') return;
  event.preventDefault();
  activateView(activeView === 'office' ? previousConsoleView : 'office');
});

byId('wake-button').addEventListener('click', async (event) => {
  await runAction(event.currentTarget, 'Waking…', () => api.wakeSquad());
});

byId('recover-supervisor-button').addEventListener('click', async (event) => {
  const result = await runAction(event.currentTarget, 'Recovering…', () =>
    api.recoverSupervisor(),
  );
  const output = byId('recovery-output');
  if (!result?.ok) {
    output.textContent = [result?.message, result?.details].filter(Boolean).join('\n');
    return;
  }
  const recovery = result.value;
  output.textContent = recovery.manualKillPid
    ? `${recovery.raw}\nRun: taskkill /PID ${recovery.manualKillPid} /F`
    : recovery.raw || (recovery.alreadyStopped ? 'No daemon was running.' : 'Supervisor stopped.');
});

byId('council-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const feedback = byId('council-feedback');
  const councilSlot = window.DecagramCouncilSceneViewModel.findCouncilSlot(
    state?.snapshot,
  );
  const result = await runAction(button, 'Convening…', () =>
    api.council(
      byId('council-question').value,
      councilSlot?.validation?.fingerprint,
    ),
  );
  feedback.textContent = result?.ok
    ? `Council started as session ${result.value.id}.`
    : result?.message ?? 'Council could not start.';
});

api.onSnapshot((snapshot) => {
  if (!state) return;
  state = { ...state, snapshot };
  render();
});

api.onState((nextState) => {
  state = nextState;
  byId('council-project').textContent = nextState.projectDir ?? 'No workspace';
  render();
});

api.onMissionState((nextMissionState) => {
  missionState = nextMissionState;
  render();
});

Promise.all([api.getState(), api.getMissionState()])
  .then(([initial, initialMissionResult]) => {
    state = initial;
    missionState = initialMissionResult.ok
      ? initialMissionResult.value
      : {
          status: 'unavailable',
          workspaceId: initial.workspace.id,
          revision: 0,
          problem: initialMissionResult.message,
          providers: [],
          gatePolicy: undefined,
          projection: undefined,
        };
    byId('council-project').textContent = initial.projectDir ?? 'No workspace';
    render();
  })
  .catch((error) => {
    setFeedback(error instanceof Error ? error.message : String(error));
  });
