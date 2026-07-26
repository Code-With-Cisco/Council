/**
 * Every filesystem location the integration layer touches.
 *
 * Nothing outside this file joins path segments by hand. The config directory
 * moves (CLAUDE_CONFIG_DIR) and the separator differs by platform, so callers
 * ask for a named path and get a resolved absolute one.
 *
 * WRITE POLICY: the app treats the Claude config directory as read-only with
 * exactly two exceptions, both under `musterDir()`: its own hook scripts and
 * the receiver port file. Settings edits go through an explicit user-approved
 * flow and are the only writes outside that subtree.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

export interface PathsOptions {
  /** Overrides CLAUDE_CONFIG_DIR and the home-directory default. Tests use this. */
  readonly configDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly home?: string | undefined;
}

/**
 * Resolves the Claude Code configuration directory.
 *
 * Honours CLAUDE_CONFIG_DIR when set and non-empty; a relative value is
 * resolved against the current working directory, matching how the CLI reads it.
 */
export function claudeConfigDir(opts: PathsOptions = {}): string {
  if (opts.configDir !== undefined && opts.configDir !== '') {
    return path.resolve(opts.configDir);
  }
  const env = opts.env ?? process.env;
  const override = env['CLAUDE_CONFIG_DIR'];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  return path.join(opts.home ?? homedir(), '.claude');
}

/**
 * Named accessors for the Claude Code state the app reads.
 *
 * Construct once at boot and pass it down; do not re-derive per call, so a
 * mid-session CLAUDE_CONFIG_DIR change cannot half-apply.
 */
export class ClaudePaths {
  readonly configDir: string;

  constructor(opts: PathsOptions = {}) {
    this.configDir = claudeConfigDir(opts);
  }

  /** `<config>/settings.json` — user settings. Written only on explicit approval. */
  settingsFile(): string {
    return path.join(this.configDir, 'settings.json');
  }

  /** `<config>/agents` — user-scope subagent definitions (`*.md`, scanned recursively). */
  agentsDir(): string {
    return path.join(this.configDir, 'agents');
  }

  /** `<project>/.claude/agents` — project-scope definitions, which win over user scope. */
  projectAgentsDir(projectDir: string): string {
    return path.join(projectDir, '.claude', 'agents');
  }

  /** `<config>/jobs` — one subdirectory per background session. */
  jobsDir(): string {
    return path.join(this.configDir, 'jobs');
  }

  /** `<config>/jobs/<id>` — also exported to the session as CLAUDE_JOB_DIR. */
  jobDir(id: string): string {
    return path.join(this.jobsDir(), id);
  }

  /** `<config>/jobs/<id>/state.json` — supervisor-maintained session state. */
  jobStateFile(id: string): string {
    return path.join(this.jobDir(id), 'state.json');
  }

  /**
   * `<config>/jobs/pins.json` — a JSON array of pinned session ids.
   *
   * Read-only for us: pinning is Ctrl+T inside the agent-view TUI and has no
   * CLI equivalent in v2.1.220.
   */
  pinsFile(): string {
    return path.join(this.jobsDir(), 'pins.json');
  }

  /** `<config>/daemon/roster.json` — supervisor's own view of running sessions. */
  daemonRosterFile(): string {
    return path.join(this.configDir, 'daemon', 'roster.json');
  }

  /** `<config>/daemon.log` — supervisor log, tailed by the diagnostics view. */
  daemonLogFile(): string {
    return path.join(this.configDir, 'daemon.log');
  }

  /** `<config>/teams` — one directory per agent team, named `session-<8 chars>`. */
  teamsDir(): string {
    return path.join(this.configDir, 'teams');
  }

  /**
   * `<config>/teams/<team>/config.json` — runtime state, removed when the
   * lead session ends. Read-only: the docs warn that hand edits are overwritten.
   */
  teamConfigFile(team: string): string {
    return path.join(this.teamsDir(), team, 'config.json');
  }

  /** `<config>/teams/<team>/inboxes/<agent>.json` — per-agent mailbox. */
  teamInboxFile(team: string, agent: string): string {
    return path.join(this.teamsDir(), team, 'inboxes', `${agent}.json`);
  }

  /** `<config>/tasks/<team>` — shared task list; persists after the session ends. */
  teamTasksDir(team: string): string {
    return path.join(this.configDir, 'tasks', team);
  }

  /** `<config>/muster` — the only subtree this app writes to. */
  musterDir(): string {
    return path.join(this.configDir, 'muster');
  }

  /** `<config>/muster/hooks` — generated bash + PowerShell hook scripts. */
  hookScriptsDir(): string {
    return path.join(this.musterDir(), 'hooks');
  }

  /**
   * `<config>/muster/receiver.json` — the well-known file carrying the push
   * receiver's randomly chosen port and shared secret.
   *
   * Hook scripts read this at fire time, which is what lets the receiver bind
   * an ephemeral port instead of a fixed one.
   */
  receiverFile(): string {
    return path.join(this.musterDir(), 'receiver.json');
  }
}

/** Project-repo paths for the work board. The app renders these files; it never owns them. */
export class ProjectPaths {
  constructor(readonly root: string) {}

  /** `<project>/docs/prd.md` */
  prdFile(): string {
    return path.join(this.root, 'docs', 'prd.md');
  }

  /** `<project>/epics` */
  epicsDir(): string {
    return path.join(this.root, 'epics');
  }

  /** `<project>/stories` */
  storiesDir(): string {
    return path.join(this.root, 'stories');
  }

  /** `<project>/.claude/hooks` — where per-project gate scripts are installed. */
  gateScriptsDir(): string {
    return path.join(this.root, '.claude', 'hooks');
  }

  /** `<project>/.claude/settings.json` — project settings carrying the gate hooks. */
  projectSettingsFile(): string {
    return path.join(this.root, '.claude', 'settings.json');
  }

  /**
   * `<project>/.claude/worktrees` — background sessions relocate here before
   * editing files, so board state for an in-flight story lives under a worktree
   * rather than the main checkout. Watched alongside the primary directories.
   */
  worktreesDir(): string {
    return path.join(this.root, '.claude', 'worktrees');
  }
}
