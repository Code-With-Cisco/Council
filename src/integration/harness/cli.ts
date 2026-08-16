/**
 * Integration test harness — `npm run harness <command>`.
 *
 * Exercises the integration module against a real local Claude Code, with no
 * Electron and no UI involved. This is what proves the layer works before any
 * renderer exists.
 *
 * Commands:
 *   doctor              locate the CLI, read its version, read daemon status
 *   daemon-stop         supervisor recovery, keeping detached sessions alive
 *   roster              read and print the unified roster
 *   agents [dir]        list subagent definitions visible from a directory
 *   roundtrip           start → poll → logs → stop → rm, using `--bg --exec`
 *   roundtrip --agent   the same cycle with a real model-backed session
 *   hooks               start the receiver and wait, printing a test command
 *   board <dir>         read and print a project's work board
 *   watch               print state changes as they arrive
 *
 * `roundtrip` defaults to `--bg --exec 'echo ...'`, which runs a shell job under
 * the supervisor instead of a Claude session: it exercises the identical
 * dispatch, roster, logs, stop and rm paths without spending any model quota.
 * Pass `--agent <name>` when you specifically need to prove a model-backed
 * session, which does consume quota.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ClaudeClient } from '../client.js';
import { ClaudePaths } from '../paths.js';
import { MINIMUM_CLAUDE_VERSION } from '../cli/locate.js';
import { readJobState, readJobsSnapshot } from '../fs/jobs.js';
import { readAllTeams } from '../fs/teams.js';
import { listAgentDefinitions } from '../fs/agentDefs.js';
import { ClaudeStateWatcher } from '../fs/watch.js';
import { HookReceiver, SECRET_HEADER } from '../hooks/receiver.js';
import { buildUnifiedRoster } from '../roster/unified.js';
import { defaultRosterConfig, mergeDiscoveredAgents } from '../roster/config.js';
import { boardCounts, readBoard } from '../board/read.js';
import type { CliResult, Session } from '../types.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'doctor';

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function log(...parts: unknown[]): void {
  console.log(...parts);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Unwraps a result, exiting with the rendered failure message on error. */
function expectOk<T>(result: CliResult<T>, what: string): T {
  if (!result.ok) {
    console.error(`✗ ${what}: [${result.kind}] ${result.message}`);
    if (result.raw.trim() !== '') console.error(result.raw.trim());
    process.exit(1);
  }
  log(`✓ ${what} (${result.durationMs}ms)`);
  return result.value;
}

async function connect(): Promise<ClaudeClient> {
  const client = await ClaudeClient.create({ locate: { override: flag('bin') } });
  if (client === null) {
    fail('no `claude` binary found. Install Claude Code, or pass --bin <path>.');
  }
  return client;
}

function formatSession(session: Session): string {
  const cells = [
    (session.id ?? '—').padEnd(10),
    (session.state ?? (session.kind === 'interactive' ? 'interactive' : '—')).padEnd(12),
    (session.pinned ? 'pin ' : '    ') + (session.cold ? 'cold' : 'hot '),
    (session.name ?? '—').padEnd(18),
    session.detail ?? session.status ?? '',
  ];
  return `  ${cells.join(' ')}`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function doctor(): Promise<void> {
  const client = await connect();
  const paths = new ClaudePaths();

  log(`binary:      ${client.cli.bin}`);
  log(`discovered:  ${client.cli.discoveredVia}`);
  log(`version:     ${client.cli.version ?? 'unknown'}`);
  log(`minimum:     ${MINIMUM_CLAUDE_VERSION}${client.cli.meetsMinimum ? '' : '  ← BELOW MINIMUM'}`);
  log(`config dir:  ${paths.configDir}`);

  const daemon = expectOk(await client.daemonStatus(), 'daemon status');
  log(`  running:   ${daemon.running}`);
  if (!daemon.running) {
    // Not a fault: service install is disabled in this version.
    log('             (normal — the supervisor starts on demand and exits when idle)');
  }
  log(`  version:   ${daemon.version ?? '—'}`);
  log(`  control:   ${daemon.controlSocketReachable ? 'reachable' : 'unreachable'}`);
  log(`  workers:   ${daemon.workerCount ?? '—'}`);

  const sessions = expectOk(await client.listSessions({ all: true }), 'roster read');
  log(`  sessions:  ${sessions.length} (${sessions.filter((s) => s.kind === 'background').length} background)`);
}

async function roster(): Promise<void> {
  const client = await connect();
  const paths = new ClaudePaths();

  const [sessions, jobs, teams] = await Promise.all([
    client.listSessions({ all: true }).then((r) => expectOk(r, 'roster read')),
    readJobsSnapshot(paths),
    readAllTeams(paths),
  ]);

  const definitions = await listAgentDefinitions(paths, process.cwd());
  const config = mergeDiscoveredAgents(
    defaultRosterConfig(process.cwd()),
    definitions,
    process.cwd(),
  ).config;
  const unified = buildUnifiedRoster({ config, rosterSessions: sessions, jobs, teams });

  log('\nSQUAD');
  for (const slot of unified.squad) {
    const label = slot.member.label.padEnd(8);
    log(slot.session === undefined ? `  ${label} — no session` : `  ${label}${formatSession(slot.session)}`);
  }

  log('\nUNASSIGNED BACKGROUND SESSIONS');
  if (unified.unassigned.length === 0) log('  (none)');
  for (const session of unified.unassigned) log(formatSession(session));

  log('\nINTERACTIVE (never acted on — no id, no state)');
  for (const session of unified.sessions.filter((s) => s.kind === 'interactive')) {
    log(`  pid ${String(session.pid ?? '—').padEnd(8)} ${session.name ?? '—'}  ${session.cwd ?? ''}`);
  }

  if (unified.teams.length > 0) {
    log('\nTEAMS (ephemeral — one per session, removed when the lead exits)');
    for (const team of unified.teams) {
      log(`  ${team.team}: ${team.members.map((m) => m.name).join(', ') || '(no members)'} · ${team.tasks.length} tasks`);
    }
  }

  if (unified.problems.length > 0) {
    log('\nNEEDS ATTENTION');
    for (const problem of unified.problems) log(`  ${problem.path}: ${problem.message}`);
  }
}

async function agents(): Promise<void> {
  const dir = argv[1] ?? process.cwd();
  const definitions = await listAgentDefinitions(new ClaudePaths(), dir);
  if (definitions.length === 0) {
    log(`no subagent definitions visible from ${dir}`);
    log('create them under .claude/agents/ (project) or ~/.claude/agents/ (user)');
    return;
  }
  log(`subagent definitions visible from ${dir}:`);
  for (const def of definitions) {
    log(`  ${def.name.padEnd(24)} ${def.scope.padEnd(8)} ${def.file}`);
  }
}

/**
 * Full lifecycle round-trip.
 *
 * Uses `--bg --exec` by default so the dispatch/roster/logs/stop/rm paths are
 * proven without spending model quota. `--agent <name>` swaps in a real
 * model-backed session for the cases where that specifically matters.
 */
async function roundtrip(): Promise<void> {
  const client = await connect();
  const paths = new ClaudePaths();
  const agent = flag('agent');
  const cwd = flag('cwd') ?? (await mkdtemp(path.join(tmpdir(), 'decagram-harness-')));
  const label = `decagram-harness-${Date.now().toString(36)}`;

  log(`cwd:   ${cwd}`);
  log(`mode:  ${agent === undefined ? 'shell job (--exec, no model quota)' : `agent "${agent}" (uses quota)`}`);

  const started =
    agent === undefined
      ? expectOk(
          await client.startExec({
            command: `echo decagram-harness-ok-${label}; sleep 30`,
            name: label,
            cwd,
          }),
          'dispatch (--exec)',
        )
      : expectOk(
          await client.start({ agent, name: label, cwd, prompt: 'Reply with the single word: ready.' }),
          `dispatch (--agent ${agent})`,
        );

  if (started.unknownAgent !== undefined) {
    // The CLI only warns here; a typo silently runs a default template.
    log(`⚠ no agent named "${started.unknownAgent}" — the CLI substituted a default template`);
  }

  const id = started.id;
  log(`✓ dispatched ${id}`);

  try {
    // Poll until the session appears, proving the roster read sees new work.
    let seen: Session | undefined;
    for (let attempt = 0; attempt < 20 && seen === undefined; attempt += 1) {
      await delay(500);
      const sessions = expectOk(await client.listSessions({ all: true }), `roster read #${attempt + 1}`);
      seen = sessions.find((session) => session.id === id);
    }
    if (seen === undefined) fail(`session ${id} never appeared in the roster`);
    log(`✓ roster shows ${id}: state=${seen.state ?? '—'} cold=${seen.cold} name=${seen.name ?? '—'}`);

    const jobState = await readJobState(paths, id);
    if (jobState === undefined) {
      log(`⚠ no state.json yet at ${paths.jobStateFile(id)}`);
    } else {
      log(`✓ state.json: state=${jobState.state ?? '—'} detail=${JSON.stringify(jobState.detail ?? null)}`);
      if (jobState.daemonShort !== undefined && jobState.daemonShort !== id) {
        fail(`daemonShort "${jobState.daemonShort}" does not match roster id "${id}"`);
      }
      if (jobState.sessionId?.startsWith(id) === false) {
        fail(`sessionId "${jobState.sessionId}" does not start with short id "${id}"`);
      }
      log('✓ short id is the first 8 characters of the session id');
    }

    const logs = await client.logs(id);
    if (logs.ok) log(`✓ logs (${logs.value.trim().split('\n').length} lines)`);
    else log(`⚠ logs unavailable: [${logs.kind}] ${logs.message}`);

    // Error-shape checks: both of these exit 0 and are only detectable by text.
    const bogus = await client.logs('zzzzzzzz');
    if (bogus.ok) fail('logs for a bogus id was reported as success');
    if (bogus.kind !== 'unknown-session') fail(`expected unknown-session, got ${bogus.kind}`);
    log('✓ bogus id classified as unknown-session despite exit code 0');

    expectOk(await client.stop(id), `stop ${id}`);
  } finally {
    const removed = await client.remove(id);
    log(removed.ok ? `✓ removed ${id}` : `⚠ could not remove ${id}: ${removed.message}`);
  }

  const after = expectOk(await client.listSessions({ all: true }), 'roster read after cleanup');
  if (after.some((session) => session.id === id)) fail(`${id} still present after rm`);
  log('✓ round-trip complete; no sessions left behind');
}

async function hooks(): Promise<void> {
  const paths = new ClaudePaths();
  const receiver = new HookReceiver(paths, {
    onDelivery: (delivery) => {
      log(`← ${delivery.event}  session=${delivery.shortId ?? '—'}`);
      log(`   ${JSON.stringify(delivery.payload)}`);
    },
    onError: (err) => console.error(`receiver error: ${err.message}`),
  });

  const info = await receiver.start();
  log(`listening on ${info.url} (loopback only)`);
  log(`descriptor:  ${paths.receiverFile()}`);
  log('\ntry it:');
  log(
    `  curl -s -X POST ${info.url}/hook/Notification \\\n` +
      `    -H 'content-type: application/json' -H '${SECRET_HEADER}: ${info.secret}' \\\n` +
      `    -d '{"session_id":"abcdefgh-1111","notification_type":"agent_needs_input"}'`,
  );
  log('\nCtrl+C to stop.');

  const shutdown = (): void => {
    void receiver.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => undefined);
}

async function board(): Promise<void> {
  const dir = argv[1] ?? process.cwd();
  const result = await readBoard(dir);
  const counts = boardCounts(result);

  log(`project:  ${result.projectDir}`);
  log(`prd:      ${result.prd.exists ? (result.prd.title ?? '(untitled)') : 'missing'}`);
  log(`epics:    ${counts.epicsSpecced}/${counts.epicsTotal} specced`);
  log(`gates:    ${counts.gatesPassing}/${counts.gatesTotal} passing`);

  for (const epic of result.epics) {
    log(`\n${epic.id} — ${epic.title ?? '(untitled)'}${epic.unspecced ? '  [unspecced]' : ''}`);
    for (const story of epic.stories) {
      const gate = story.gate.toUpperCase().padEnd(7);
      const trace = story.prdRef ?? '⚠ no prd_ref';
      log(`  ${story.id.padEnd(12)} ${gate} ${trace.padEnd(14)} ${story.title ?? ''}`);
    }
  }

  if (result.orphanStories.length > 0) {
    log('\nSTORIES WITH NO EPIC');
    for (const story of result.orphanStories) log(`  ${story.id}  ${story.title ?? ''}`);
  }

  if (result.problems.length > 0) {
    log('\nNEEDS ATTENTION (parse failures render, never crash)');
    for (const problem of result.problems) log(`  ${problem.path}: ${problem.message}`);
  }
}

async function watchState(): Promise<void> {
  const paths = new ClaudePaths();
  const watcher = new ClaudeStateWatcher(paths);
  watcher.onChange((changes) => {
    for (const change of changes) log(`${new Date().toISOString()}  ${change.area.padEnd(9)} ${change.path}`);
  });
  watcher.start();
  log(`watching ${paths.configDir} — Ctrl+C to stop`);

  const shutdown = (): void => {
    void watcher.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => undefined);
}

/**
 * Supervisor recovery. Detached sessions are kept, so this is safe to run
 * against a wedged daemon without losing in-flight work.
 */
async function daemonStop(): Promise<void> {
  const client = await connect();
  const outcome = expectOk(
    await client.daemonStop({ any: true, keepWorkers: true }),
    'daemon stop --any --keep-workers',
  );

  if (outcome.stopped) log('✓ supervisor stopped; detached sessions were left running');
  else if (outcome.alreadyStopped) log('✓ no supervisor was running — nothing to stop');

  if (outcome.manualKillPid !== undefined) {
    // Windows cannot displace a process still holding the control pipe, so the
    // only remaining step is an explicit kill the operator has to run.
    log(`⚠ the supervisor did not respond. Terminate it with:`);
    log(`    taskkill /PID ${outcome.manualKillPid} /F`);
  }

  if (!outcome.recognized) {
    log('⚠ unrecognised output — reproduced verbatim below:');
    log(outcome.raw.trim());
  }
}

const commands: Record<string, () => Promise<void>> = {
  doctor,
  roster,
  agents,
  roundtrip,
  hooks,
  board,
  watch: watchState,
  'daemon-stop': daemonStop,
};

const handler = commands[command];
if (handler === undefined) {
  console.error(`unknown command "${command}"`);
  console.error(`available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

handler().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
