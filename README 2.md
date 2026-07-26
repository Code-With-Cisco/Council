# Decagram Council

A cross-platform desktop control surface (macOS + Windows, Electron) for Claude Code's
existing multi-agent runtime. The repo is `Council`; the app is **Decagram Council**, per the design
handoff.

**Decagram Council is not an agent runtime.** Claude Code's per-user supervisor daemon already hosts
background sessions that persist across sleep and terminal closes. Decagram Council shells out to the
`claude` CLI and reads state files. That is the whole integration — no Agent SDK, no model
calls of its own, nothing the supervisor already does reimplemented.

## Status

| Phase | State |
|---|---|
| 1. Integration module + test harness | **Done** — 97 tests, round-trip verified against a real local CLI |
| 2. Hook receiver + generated hook config | **Done** — bash forwarder verified end-to-end |
| 3. Minimal UI wired end-to-end | Not started |
| 4. Design-spec UI (`Decagram Council — Ops Deck`) | Not started |
| 5. Tray, notifications, packaging | Not started |

Per the build order, work stops here for review before any UI code.

## Compatibility

**Requires Claude Code >= 2.1.220.**

Agent view is a research preview and its CLI surface changes between versions. Every command,
flag, JSON field and on-disk path this app depends on was verified by probing the installed
binary at **2.1.220** — not from documentation alone. Earlier versions are untested rather
than known-broken; `claude --version` is read at launch and a lower version is surfaced in
the diagnostics panel.

Verified surface:

```
claude agents --json [--all] [--cwd <path>]     roster read
claude --bg [--agent <n>] [--name <l>] "<p>"    dispatch a session
claude --bg --name <l> --exec '<cmd>'           dispatch a shell job (no model quota)
claude logs|stop|kill|respawn|rm <id>           session control
claude respawn --all                            "wake the squad"
claude attach <id>                              PTY attach
claude daemon status                            supervisor state
claude daemon stop --any --keep-workers         recovery
```

`logs`, `stop`, `kill`, `respawn`, `rm`, `attach` and `daemon` are **hidden** subcommands —
present and working, but absent from `claude --help`. They are documented in the official CLI
reference.

On-disk state read (read-only, `CLAUDE_CONFIG_DIR` honoured):

```
<config>/jobs/<id>/state.json     per-session state, richer than the roster
<config>/jobs/pins.json           pinned session ids
<config>/daemon/roster.json       supervisor's own session list
<config>/agents/**.md             subagent definitions (for --agent validation)
<config>/teams/<team>/config.json ephemeral team membership
<config>/tasks/<team>/            shared task list
```

Decagram Council writes to exactly one place under the Claude config directory: `<config>/decagram-council/`
(its own hook scripts and the receiver descriptor). Settings edits happen only through an
explicit, previewed, user-approved flow.

## Spec vs. shipped runtime

Seven places where the original app spec did not match Claude Code 2.1.220. The docs and the
installed binary win; each is handled as described.

### 1. There is no `claude reply` command

The spec's lightweight "logs + reply" path assumed one. The complete set of session
subcommands is `attach / logs / stop / kill / respawn / rm / daemon`. Worse than absent —
`claude reply <id> "text"` falls through to the default command and would start a **new
interactive session whose first prompt is the literal word "reply"**.

**Handled:** both talking paths go through the PTY. `AttachSession` drives the xterm.js
drawer; `sendReply` is the same mechanism run headlessly and torn down (attach → wait for
output to quiesce → type → Ctrl+Z). Attaching a stopped session restarts it from its saved
transcript, so replying to a cold specialist wakes it — the behaviour the spec wanted,
reached a different way.

### 2. The CLI exits 0 on failure

```
$ claude logs zzzzzzzz
No job matching 'zzzzzzzz'. Run 'claude agents' to list running sessions.
$ echo $?
0
```

**Handled:** `src/integration/cli/errors.ts` classifies failures from output text. Exit codes
are only trusted when non-zero. Every call returns a discriminated
`{ok:true,value} | {ok:false,kind,message,raw}` so CLI errors render as states.

### 3. `claude daemon status` is prose, and "not running" is normal

No `--json`. And service install is disabled in this version — the supervisor starts on
demand and exits when the last client disconnects, so a stopped daemon is the resting state.

**Handled:** a text parser with both real shapes as fixtures. The UI must never present a
stopped daemon as a fault.

### 4. `--agent <unknown>` does not fail

```
$ claude --bg --agent __no_such_agent__ --name probe "say hi"
warning: no agent named '__no_such_agent__' — spawning with default template
backgrounded · 4f544317 · probe
```

A roster typo would produce a live session running a generic agent under a specialist's
name — a failure that looks like success.

**Handled:** roster `agent` names are validated against `.claude/agents/` and
`~/.claude/agents/` before dispatch, and `startMember` refuses when the definition is
missing. The warning is also detected post-hoc as a backstop.

### 5. Agent teams are not the squad

The spec modelled the five specialists as a persistent team. Teams are experimental
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), there is exactly **one team per session**, the
name is auto-derived (`session-` + first 8 chars of the session id), and
`<config>/teams/<team>/` is **deleted when the lead session ends**. The docs explicitly warn
against pre-authoring or hand-editing it.

**Handled:** the squad is five background sessions dispatched with `--agent`. Team state is
read-only observation of whatever huddles happen to exist. Teammates genuinely do not appear
in `agents --json`, so the unified roster still merges this source.

### 6. Background sessions relocate into git worktrees

Not mentioned in the spec. Sessions move into `.claude/worktrees/` before editing files, so
the in-flight version of a story often lives in a worktree rather than the main checkout —
the work board would appear to lose edits.

**Handled:** `worktreeBoards()` enumerates them so the UI can show which copy it is reading.
A project can opt out with `{"worktree": {"bgIsolation": "none"}}`.

### 7. There is no pin command — but pin state is readable

Confirmed: pinning is `Ctrl+T` inside the agent-view TUI only. The spec asked us to check.

**Handled:** cold is treated as a normal state, and `<config>/jobs/pins.json` is read so the
UI can still show which sessions are pinned. Pinned sessions are exempt from the ~1h idle
stop and are never rendered dormant.

### Also worth knowing

- **`pid` is not a liveness signal.** The docs describe it as present while the process is
  alive, but a background session in state `working` reports no `pid` at all — the supervisor
  hosts the process. Cold is derived from `state`, and defaults to *not* cold when unknown.
- **Short id == first 8 chars of the session UUID**, confirmed against `state.json`'s
  `daemonShort`. This is how hook payloads (which carry `session_id`) correlate with roster
  rows (keyed by short id).
- **`http`-type hooks exist** (gated by the `allowedHttpHookUrls` setting), but the receiver
  binds an ephemeral port, and an HTTP hook needs a literal URL in settings. Script
  forwarders read the port at fire time, so settings are written once.

## Architecture

```
src/integration/         Electron-free, importable from plain Node
  types.ts               domain types — the reviewable API surface
  paths.ts               every filesystem location; nothing joins paths by hand
  client.ts              ClaudeClient — all session control
  runtime.ts             DecagramCouncilRuntime — poll + watch + hooks -> one Snapshot
  cli/                   locate, exec, error classification
  parse/                 roster JSON, daemon status text, dispatch acks
  fs/                    jobs, teams, agent definitions, chokidar watching
  roster/                user-editable config + the unified roster merge
  hooks/                 receiver, typed events, config generator, scripts
  pty/                   attach + headless reply
  board/                 PRD / epics / stories reader
  gates/                 per-project gate installer
  harness/cli.ts         the integration test harness
scripts/gates/           story-gate.sh + story-gate.ps1 (shipped, installed per-project)
test/                    97 tests; fixtures recorded from a real CLI
```

**Data flow.** Hooks are the fast path (milliseconds), filesystem watches are the second fast
path, and `agents --json --all` polling every ~10s is reconciliation. Hooks are never the only
path: a hook delivery schedules a refresh rather than mutating state, so the CLI stays the
single source of truth and there is no divergent in-app model. A failed roster read keeps the
previous roster and marks it stale rather than blanking the squad screen.

**Finding the CLI.** A desktop app is not launched from the user's login shell, so PATH is
often missing what a terminal would have. `locateClaude` probes an override, then PATH, then
well-known install directories, then the VS Code extension's bundled binary — which on this
machine is the only copy present.

## Running it

```bash
npm install
npm run typecheck
npm test                     # 97 tests, no CLI required (fixtures + real bash scripts)

npm run harness doctor       # locate the CLI, read version + daemon status
npm run harness roster       # the unified roster
npm run harness agents       # subagent definitions visible from here
npm run harness roundtrip    # dispatch -> roster -> logs -> stop -> rm
npm run harness hooks        # start the receiver, print a test curl
npm run harness board <dir>  # read a project's work board
npm run harness watch        # print state changes as they arrive
```

`roundtrip` uses `--bg --exec` by default: a supervisor-hosted shell job that exercises the
identical dispatch, roster, logs, stop and rm paths **without spending model quota**. Pass
`--agent <name>` for a model-backed session when that specifically matters.

Verified output on this machine (Claude Code 2.1.220, macOS):

```
✓ dispatch (--exec) (1600ms)
✓ dispatched 8972dd25
✓ roster shows 8972dd25: state=working cold=false name=decagram-harness-ms13d1uu
✓ state.json: state=working detail="starting…"
✓ short id is the first 8 characters of the session id
✓ bogus id classified as unknown-session despite exit code 0
✓ stop 8972dd25 (821ms)  ✓ removed 8972dd25
✓ round-trip complete; no sessions left behind
```

## Roster config

The five specialists are declared in a user-editable JSON file owned by the app (not under
`~/.claude`). Identity keys are fixed by the design spec — colour and sigil key off `key`.

```json
{
  "version": 1,
  "members": [
    {
      "key": "arden",
      "label": "Arden",
      "agent": "arden",
      "cwd": "/Users/me/work/meridian",
      "role": "Architecture"
    }
  ],
  "pollIntervalMs": 10000
}
```

`agent` must match the `name` frontmatter of a subagent definition under
`<project>/.claude/agents/` or `~/.claude/agents/`. A bad edit degrades to defaults with a
visible explanation rather than crashing the app you need in order to fix it.

## Story gates

`scripts/gates/` ships paired bash + PowerShell gate scripts, installed into a project's
`.claude/hooks/` by an app action and wired to `TaskCompleted` and `TeammateIdle`. They block
completion (exit 2) when a story's `prd_ref` is missing or its `acceptance` command exits
nonzero. Unlike the notification forwarders these are deliberately **synchronous** — `async`
would make exit code 2 meaningless.

Story frontmatter:

```yaml
---
id: MER-101
title: Parse uploads
epic: epic-1
prd_ref: "§1.2"                  # required — traceability to docs/prd.md
acceptance: npm test -- upload   # required — must exit 0
status: done
gate: pass
---
```

## Engineering baseline

TypeScript strict everywhere (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
The integration module has no Electron dependency, so it is testable from plain Node. Every
CLI interaction is mocked for tests via fixtures recorded from a real `--json` run. Errors
from the CLI are states to render, not exceptions to swallow.

For the Electron phases: main process owns all CLI and file access; renderer sandboxed with
`contextIsolation` on and `nodeIntegration` off; typed IPC only.
