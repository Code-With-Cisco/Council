'use strict';

const api = window.decagramCouncil;
const identity = {
  arden: { color: '#8ea1ff', sigil: 'A' },
  bram: { color: '#ff9d73', sigil: 'B' },
  rook: { color: '#d0a4ff', sigil: 'R' },
  tess: { color: '#63d9d0', sigil: 'T' },
  sage: { color: '#b5da72', sigil: 'S' },
};

let state;
let selectedKey;

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

function renderSquad(snapshot) {
  const grid = byId('squad-grid');
  grid.replaceChildren();

  if (!snapshot) {
    grid.append(element('p', 'muted', 'No roster snapshot is available. Open Diagnostics for details.'));
    return;
  }

  for (const slot of snapshot.roster.squad) {
    const session = slot.session;
    const theme = identity[slot.member.key] ?? { color: '#8ea1ff', sigil: slot.member.label[0] ?? '?' };
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
  const panel = byId('session-detail');
  panel.replaceChildren();
  const session = slot.session;
  panel.append(element('p', 'eyebrow', 'SESSION DETAIL'));
  panel.append(element('h3', '', slot.member.label));
  if (!session?.id) {
    panel.append(element('p', 'muted', 'This specialist does not have an actionable background session.'));
    return;
  }

  const meta = element('dl', 'detail-meta');
  appendMeta(meta, 'Session', session.id);
  appendMeta(meta, 'State', session.state ?? 'unknown');
  appendMeta(meta, 'Started', humanDate(session.startedAt));
  appendMeta(meta, 'Updated', humanDate(session.updatedAt));
  appendMeta(meta, 'Folder', session.cwd);
  panel.append(meta);

  const log = element('pre', 'log-output', 'Select “Load recent output” to read this session.');
  const load = element('button', 'button', 'Load recent output');
  load.addEventListener('click', async () => {
    const result = await runAction(load, 'Loading…', () => api.logs(session.id));
    log.textContent = result?.ok ? result.value || '(No output)' : result?.message ?? 'Unable to load output.';
  });
  panel.append(load, log);

  const replyRow = element('div', 'reply-row');
  const reply = element('input');
  reply.type = 'text';
  reply.placeholder = state?.preflight.ptyAvailable ? 'Send a plain-text reply' : 'Reply unavailable: node-pty missing';
  reply.disabled = !state?.preflight.ptyAvailable;
  const send = element('button', 'button button-primary', 'Send');
  send.disabled = !state?.preflight.ptyAvailable;
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
    diagnosticCard('Roster', snapshot ? `${snapshot.roster.squad.length} specialists` : 'Unavailable', state.rosterProblems.length ? state.rosterProblems.join(' · ') : 'Configuration parsed without reported problems.', state.rosterProblems.length ? 'is-warning' : 'is-good'),
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
  renderSquad(snapshot);
  renderDiagnostics();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('is-active', node === tab));
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('is-active', view.id === `view-${tab.dataset.view}`));
  });
}

byId('wake-button').addEventListener('click', async (event) => {
  await runAction(event.currentTarget, 'Waking…', () => api.wakeSquad());
});

byId('council-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const feedback = byId('council-feedback');
  const result = await runAction(button, 'Convening…', () =>
    api.council(byId('council-question').value, byId('council-cwd').value),
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
    byId('council-cwd').value = initial.projectDir;
    render();
  })
  .catch((error) => {
    setFeedback(error instanceof Error ? error.message : String(error));
  });
