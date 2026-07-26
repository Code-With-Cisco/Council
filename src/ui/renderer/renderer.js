'use strict';

const api = window.decagramCouncil;
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
  return slot.session?.state ?? (slot.missing ? 'not started' : 'unknown');
}

function officeMode(slot) {
  if (!slot.session) return 'missing';
  if (slot.session.state === 'working') return slot.session.cold ? 'cold' : 'working';
  if (slot.session.state === 'blocked') return 'blocked';
  if (slot.session.state === 'failed') return 'failed';
  if (slot.session.state === 'done') return 'done';
  if (slot.session.state === 'stopped') return 'stopped';
  return slot.session.cold ? 'cold' : 'idle';
}

function statusClass(stateName) {
  if (stateName === 'working' || stateName === 'done') return 'is-good';
  if (stateName === 'blocked') return 'is-warning';
  if (stateName === 'failed') return 'is-bad';
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
  const slots = snapshot?.roster.squad ?? [];
  const pageCount = Math.max(1, Math.ceil(slots.length / AGENTS_PER_OFFICE));
  officePage = Math.min(officePage, pageCount - 1);
  const firstIndex = officePage * AGENTS_PER_OFFICE;
  const pageSlots = slots.slice(firstIndex, firstIndex + AGENTS_PER_OFFICE);
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
        mode: officeMode(slot),
      };
    }),
    connected: state?.preflight.claude?.meetsMinimum === true && snapshot !== undefined,
    stale: snapshot?.rosterError !== undefined,
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
    return;
  }

  for (const slot of snapshot.roster.squad) {
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

    const stateName = session?.state ?? (slot.missing ? 'not started' : 'unknown');
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
    if (slot.validation && !slot.validation.found) status.append(element('span', 'state-pill is-bad', 'Agent missing'));
    card.append(status);

    const actions = element('div', 'card-actions');
    if (slot.missing) {
      const start = element('button', 'button button-primary', 'Start');
      start.disabled = slot.validation?.found === false;
      start.addEventListener('click', async () => {
        await runAction(start, 'Starting…', () => api.startMember(slot.member.key));
      });
      actions.append(start);
    }
    if (session?.id) {
      const details = element('button', 'button', 'Details');
      details.addEventListener('click', () => {
        selectedKey = slot.member.key;
        renderDetail(slot);
      });
      const stop = element('button', 'button button-danger', 'Stop');
      stop.addEventListener('click', async () => {
        await runAction(stop, 'Stopping…', () => api.stopSession(session.id));
      });
      actions.append(details, stop);
    }
    card.append(actions);
    grid.append(card);
  }

  const selected = snapshot.roster.squad.find((slot) => slot.member.key === selectedKey);
  if (selected) renderDetail(selected);
}

function appendMeta(list, label, value) {
  list.append(element('dt', '', label), element('dd', '', value ?? '—'));
}

function renderDetail(slot) {
  renderAgentDetail(byId('session-detail'), slot, 'SESSION DETAIL');
}

function renderAgentDetail(panel, slot, kicker) {
  panel.replaceChildren();
  const session = slot.session;
  panel.append(element('p', 'eyebrow', kicker));
  panel.append(element('h3', '', slot.member.label));

  const profile = element('dl', 'detail-meta');
  appendMeta(profile, 'Definition', slot.member.agent);
  appendMeta(profile, 'Role', slot.member.role);
  appendMeta(profile, 'Folder', slot.member.cwd);
  panel.append(profile);

  if (!session?.id) {
    const message =
      slot.validation?.found === false
        ? 'The definition is missing, so this workstation cannot launch.'
        : 'This agent is available and has not been started.';
    panel.append(element('p', 'muted', message));
    const start = element('button', 'button button-primary', 'Start agent');
    start.disabled =
      state?.capabilities.start !== true || slot.validation?.found === false;
    start.addEventListener('click', async () => {
      await runAction(start, 'Starting…', () => api.startMember(slot.member.key));
    });
    panel.append(start);
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
  load.disabled = state?.capabilities.logs !== true;
  load.addEventListener('click', async () => {
    const result = await runAction(load, 'Loading…', () => api.logs(session.id));
    log.textContent = result?.ok ? result.value || '(No output)' : result?.message ?? 'Unable to load output.';
  });
  const stop = element('button', 'button button-danger', 'Stop session');
  stop.disabled = state?.capabilities.stop !== true;
  stop.addEventListener('click', async () => {
    await runAction(stop, 'Stopping…', () => api.stopSession(session.id));
  });
  const actions = element('div', 'card-actions');
  actions.append(load, stop);
  panel.append(actions, log);

  const replyRow = element('div', 'reply-row');
  const reply = element('input');
  reply.type = 'text';
  reply.placeholder = state?.capabilities.plainTextReply
    ? 'Send a plain-text reply'
    : 'Reply unavailable: terminal bridge missing';
  reply.disabled = !state?.capabilities.plainTextReply;
  const send = element('button', 'button button-primary', 'Send');
  send.disabled = !state?.capabilities.plainTextReply;
  send.addEventListener('click', async () => {
    const result = await runAction(send, 'Sending…', () => api.reply(session.id, reply.value));
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
  const daemon = snapshot?.daemon;
  const daemonValue = !daemon ? 'Unavailable' : !daemon.recognized ? 'Unknown' : daemon.running ? 'Running' : 'Resting';
  const daemonTone = !daemon || !daemon.recognized ? 'is-warning' : daemon.running ? 'is-good' : '';
  const guard = p.guardSelfTest;
  const guardPassed = guard.status === 'passed';
  const claudeUsable = p.claude?.meetsMinimum === true;
  const hookCount = Object.values(p.hookConfig)
    .flatMap((groups) => groups ?? [])
    .reduce((count, group) => count + (group.hooks?.length ?? 0), 0);
  const grid = byId('diagnostics-grid');
  grid.replaceChildren(
    diagnosticCard('Platform', p.supportedPlatform ? 'Windows supported' : `Unsupported: ${p.platform}`, 'Windows 10 or Windows 11 is required.', p.supportedPlatform ? 'is-good' : 'is-bad'),
    diagnosticCard('Claude CLI', !p.claude ? 'Not found' : claudeUsable ? 'Found' : 'Version too old', p.claude ? `${p.claude.bin}${p.claude.version ? ` · ${p.claude.version}` : ''} · ${p.claude.discoveredVia}` : 'Install Claude Code for Windows or configure an override.', claudeUsable ? 'is-good' : 'is-bad'),
    diagnosticCard('PowerShell', p.powershell.available ? 'Available' : 'Missing', p.powershell.available ? `${p.powershell.executable} · ${p.powershell.version ?? 'version unknown'}` : 'Guard hooks require PowerShell.', p.powershell.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Guard self-test', guardPassed ? 'Passed' : guard.status === 'failed' ? 'Failed' : 'Not verified', guardPassed ? 'Windows write and shell guards accepted their safety cases.' : guard.message, guardPassed ? 'is-good' : guard.status === 'failed' ? 'is-bad' : 'is-warning'),
    diagnosticCard('Git', p.git.available ? 'Available' : 'Missing', p.git.available ? `${p.git.executable} · ${p.git.version ?? 'version unknown'}` : 'Git for Windows is required.', p.git.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Node.js', p.node.available ? 'Available' : 'Missing', `${p.node.executable ?? 'unresolved'} · ${p.node.version ?? 'version unknown'}`, p.node.available ? 'is-good' : 'is-bad'),
    diagnosticCard('Hook registration', `${hookCount} Windows handlers`, 'Edit|Write, PowerShell, TaskCompleted, and TeammateIdle are generated from one configuration.', hookCount === 4 ? 'is-good' : 'is-warning'),
    diagnosticCard('Terminal bridge', p.ptyAvailable ? 'Available' : 'Logs only', p.ptyAvailable ? 'Direct plain-text replies are enabled.' : 'Install the optional node-pty module to enable replies.', p.ptyAvailable ? 'is-good' : 'is-warning'),
    diagnosticCard('Claude daemon', daemonValue, daemon?.raw || 'No verified daemon status has been read.', daemonTone),
    diagnosticCard('Agent catalog', snapshot ? `${snapshot.roster.squad.length} agents` : 'Unavailable', state.rosterProblems.length ? state.rosterProblems.join(' · ') : 'Definitions and preferences parsed without reported problems.', state.rosterProblems.length ? 'is-warning' : 'is-good'),
    diagnosticCard('Project folder', state.projectDir, 'Override with DECAGRAM_COUNCIL_PROJECT_DIR before launch.'),
  );

  byId('preflight-time').textContent = `Checked ${humanDate(p.checkedAt)}`;
  const messages = [...state.startupMessages];
  if (snapshot?.rosterError) messages.push(snapshot.rosterError.message);
  if (snapshot?.roster.problems.length) {
    messages.push(...snapshot.roster.problems.map((problem) => `${problem.path}: ${problem.message}`));
  }
  const list = byId('startup-messages');
  list.replaceChildren();
  if (messages.length === 0) list.append(element('li', '', 'No startup problems reported.'));
  else messages.forEach((message) => list.append(element('li', '', message)));
}

function render() {
  const snapshot = state?.snapshot;
  const connection = byId('connection-state');
  if (!state?.preflight.claude || !state.preflight.claude.meetsMinimum) {
    connection.textContent = 'Claude unavailable';
    connection.className = 'connection-pill is-bad';
  } else if (!snapshot) {
    connection.textContent = 'Connecting…';
    connection.className = 'connection-pill is-warning';
  } else {
    connection.textContent = snapshot.rosterError ? 'Roster stale' : 'Connected';
    connection.className = `connection-pill ${snapshot.rosterError ? 'is-warning' : 'is-good'}`;
  }
  byId('updated-at').textContent = snapshot ? `Updated ${humanDate(snapshot.updatedAt)}` : '';
  byId('wake-button').hidden = !snapshot?.needsWake;
  renderAttention(snapshot);
  renderOffice(snapshot);
  renderSquad(snapshot);
  renderDiagnostics();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    activateView(tab.dataset.view);
  });
}

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
  const result = await runAction(button, 'Convening…', () =>
    api.council(byId('council-question').value),
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

api.getState()
  .then((initial) => {
    state = initial;
    byId('council-project').textContent = initial.projectDir;
    render();
  })
  .catch((error) => {
    setFeedback(error instanceof Error ? error.message : String(error));
  });
