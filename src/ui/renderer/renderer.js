'use strict';

const api = window.decagramCouncil;
const profileActions = window.CouncilSceneViewModel.createProfileActionRouter(api);
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
  return window.CouncilSceneViewModel.actionState(slot, {
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
  if (stateName === 'working' || stateName === 'done') return 'is-good';
  if (stateName === 'blocked') return 'is-warning';
  if (
    stateName === 'failed' ||
    stateName === 'stale binding' ||
    stateName.startsWith('definition ')
  ) {
    return 'is-bad';
  }
  return '';
}

function humanDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
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
  const scene = window.CouncilSceneViewModel.mapSnapshot(snapshot, {
    page: officePage,
    perPage: AGENTS_PER_OFFICE,
    runtimeAvailable: state?.preflight?.claude?.meetsMinimum === true,
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
    const button = element(
      'button',
      `station-button ${currentState === 'blocked' ? 'is-blocked' : ''} ${currentState === 'failed' ? 'is-failed' : ''} ${selectedKey === slot.member.key ? 'is-selected' : ''}`,
    );
    button.type = 'button';
    button.style.setProperty('--identity', theme.color);
    button.setAttribute('aria-pressed', selectedKey === slot.member.key ? 'true' : 'false');
    button.setAttribute('aria-label', `${slot.member.label}, ${currentState}`);
    button.append(
      element('span', 'station-sigil', theme.sigil),
      element('span', 'station-name', slot.member.label),
      element('span', 'station-state', currentState),
    );
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
    card.append(status);

    const actions = element('div', 'card-actions');
    if (slot.bindingState === 'none') {
      const start = element('button', 'button button-primary', 'Start');
      start.disabled = !canStart(slot);
      start.addEventListener('click', async () => {
        await runAction(start, 'Starting…', () =>
          window.CouncilSceneViewModel.invokeProfileStart(slot, profileActions),
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
          window.CouncilSceneViewModel.invokeProfileStart(slot, profileActions),
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
    ? 'Send a plain-text reply'
    : session.waitingFor && session.waitingFor !== 'input needed'
      ? `Reply disabled: waiting for ${session.waitingFor}`
      : 'Reply unavailable unless waiting for ordinary text input';
  reply.disabled = !canReply(slot);
  const send = element('button', 'button button-primary', 'Send');
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
  const slot = window.CouncilSceneViewModel.findCouncilSlot(snapshot);
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

function diagnosticCard(label, value, detail, tone) {
  const card = element('article', 'diagnostic-card');
  card.append(element('h3', '', label));
  card.append(element('p', `diagnostic-value ${tone ?? ''}`, value));
  card.append(element('p', 'diagnostic-detail', detail));
  return card;
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
    );
    byId('preflight-time').textContent = '';
    const list = byId('startup-messages');
    list.replaceChildren();
    const messages = [...state.startupMessages];
    if (messages.length === 0) messages.push('No startup problems reported.');
    messages.forEach((message) => list.append(element('li', '', message)));
    return;
  }
  const daemon = snapshot?.daemon;
  const daemonValue = !daemon ? 'Unavailable' : !daemon.recognized ? 'Unknown' : daemon.running ? 'Running' : 'Resting';
  const daemonTone = !daemon || !daemon.recognized ? 'is-warning' : daemon.running ? 'is-good' : '';
  const guard = p.guardSelfTest;
  const guardPassed = guard.status === 'passed';
  const claudeUsable = p.claude?.meetsMinimum === true;
  const hookCount = p.hookHandlerCount;
  grid.replaceChildren(
    diagnosticCard('Platform', p.supportedPlatform ? 'Windows supported' : `Unsupported: ${p.platform}`, 'Windows 10 or Windows 11 is required.', p.supportedPlatform ? 'is-good' : 'is-bad'),
    diagnosticCard('Claude CLI', !p.claude ? 'Not found' : claudeUsable ? 'Found' : 'Version too old', p.claude ? `${p.claude.version ?? 'version unknown'} · ${p.claude.discoveredVia}` : 'Install Claude Code for Windows or configure an override.', claudeUsable ? 'is-good' : 'is-bad'),
    diagnosticCard('PowerShell', p.powershell.available ? 'Available' : 'Missing', p.powershell.available ? `${p.powershell.version ?? 'version unknown'} · ${p.powershell.discoveredVia}` : 'Guard hooks require PowerShell.', p.powershell.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Guard self-test', guardPassed ? 'Passed' : guard.status === 'failed' ? 'Failed' : 'Not verified', guardPassed ? 'Windows write and shell guards accepted their safety cases.' : guard.message, guardPassed ? 'is-good' : guard.status === 'failed' ? 'is-bad' : 'is-warning'),
    diagnosticCard('Git', p.git.available ? 'Available' : 'Missing', p.git.available ? `${p.git.version ?? 'version unknown'} · ${p.git.discoveredVia}` : 'Git for Windows is required.', p.git.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Node.js', p.node.available ? 'Available' : 'Missing', `${p.node.version ?? 'version unknown'} · ${p.node.discoveredVia}`, p.node.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Hook registration', `${hookCount} Windows handlers`, 'Edit|Write, PowerShell, TaskCompleted, and TeammateIdle are generated from one configuration.', hookCount === 4 ? 'is-good' : 'is-warning'),
    diagnosticCard('Terminal bridge', p.ptyAvailable ? 'Available' : 'Logs only', p.ptyAvailable ? 'Direct plain-text replies are enabled.' : 'Install the optional node-pty module to enable replies.', p.ptyAvailable ? 'is-good' : 'is-warning'),
    diagnosticCard('Claude daemon', daemonValue, daemon?.raw || 'No verified daemon status has been read.', daemonTone),
    diagnosticCard('Agent catalog', state.catalog ? `${state.catalog.entries.length} definitions` : 'Unavailable', [...state.rosterProblems, ...(state.catalog?.diagnostics.map((problem) => problem.message) ?? [])].join(' · ') || 'Definitions and preferences parsed without reported problems.', state.rosterProblems.length || state.catalog?.diagnostics.length ? 'is-warning' : 'is-good'),
    diagnosticCard('Workspace', state.workspace.label ?? 'Unavailable', `${state.projectDir ?? 'No canonical path'}${state.workspace.developmentOverride ? ' · development override' : ''}`, state.workspace.status === 'ready' ? 'is-good' : 'is-warning'),
    diagnosticCard('Session bindings', state.bindingProblem ? 'Needs attention' : 'Loaded', state.bindingProblem?.message ?? 'Exact profile ownership store parsed without reported problems.', state.bindingProblem ? 'is-warning' : 'is-good'),
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
    byId('council-project').textContent = state.projectDir ?? 'No workspace';
    render();
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    setupButton.disabled = false;
  }
}

byId('change-workspace-button').addEventListener('click', chooseWorkspace);
byId('workspace-setup-button').addEventListener('click', chooseWorkspace);

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

byId('council-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const feedback = byId('council-feedback');
  const councilSlot = window.CouncilSceneViewModel.findCouncilSlot(
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

api.getState()
  .then((initial) => {
    state = initial;
    byId('council-project').textContent = initial.projectDir ?? 'No workspace';
    render();
  })
  .catch((error) => {
    setFeedback(error instanceof Error ? error.message : String(error));
  });
