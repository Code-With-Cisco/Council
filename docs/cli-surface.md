# Claude Code CLI probe transcript

Verbatim record of what the installed CLI actually does, captured on
**2026-07-25** against **Claude Code 2.1.220** (macOS, darwin-x64). Source of truth for the
parsers in `src/integration/parse/` and the fixtures in `test/fixtures/`.

Re-run these probes after a Claude Code upgrade. Agent view is a research preview and this
surface is expected to drift.

```
$ claude --version
2.1.220 (Claude Code)
```

On this machine there is no `claude` on PATH; the only copy is the one bundled with the VS
Code extension, which is why `locateClaude` probes extension directories:

```
~/.vscode/extensions/anthropic.claude-code-2.1.220-darwin-x64/resources/native-binary/claude
```

## Visible vs. hidden commands

`claude --help` lists only: `agents`, `auth`, `auto-mode`, `doctor`, `gateway`, `install`,
`mcp`, `plugin`, `project`, `setup-token`, `ultrareview`, `update`.

The session-control commands are **hidden but present**:

```
$ claude attach --help
Usage: claude attach <id>
  Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops back to your shell. The session keeps running either way.

$ claude logs --help
Usage: claude logs <id>
  Print the background session's recent terminal output.

$ claude stop --help
Usage: claude stop <id>
  Stop a background session. Its conversation is kept; resume it later with `claude attach <id>`.

$ claude kill --help
Usage: claude stop <id>            # alias for stop

$ claude respawn --help
Usage: claude respawn <id>|--all
  Restart a background session (or all of them) so it picks up the current Claude binary.

$ claude rm --help
Usage: claude rm <id>
  Delete a background session and its worktree. Unlike `stop`, works on already-exited sessions.
```

**`reply` and `peek` do not exist.** They fall through to the default command, so
`claude reply <id> "text"` would start a new interactive session with the prompt `reply`.
This is why the reply path is implemented over the PTY.

```
$ claude daemon --help
Usage: claude daemon [subcommand] [options]

Service lifecycle:
  run [json-path]   Run the supervisor in the foreground (default when piped)
  status            Show daemon pid, version, uptime
  logs              Tail the daemon log (Ctrl-C to stop)
  uninstall         Remove the background service (launchctl/systemd)
  stop              Shut down the supervisor and terminate background sessions
                      --any           also stop a transient (non-service) daemon
                      --keep-workers  leave detached sessions running

  Service install is disabled in this version — the daemon runs on demand
  and exits when the last client disconnects.
```

That last sentence is why a stopped daemon is the resting state, not a fault.

## Roster: interactive rows carry no id and no state

```
$ claude agents --json
[
  {
    "pid": 6469,
    "cwd": "/Users/cisco/Documents/GitHub/Council",
    "kind": "interactive",
    "startedAt": 1785023767217,
    "sessionId": "5e501e5b-dfaa-4156-beb2-38708653b2fc",
    "name": "council-b5"
  }
]
```

No `id`, no `state`. Anything that assumes a roster row is a controllable background job
breaks as soon as the user has a terminal open. Recorded as `test/fixtures/roster-mixed.json`.

## Dispatch and the background row

Probed with `--exec` so no model quota is spent:

```
$ claude --bg --name "probe-job" --exec 'echo hello-from-probe; sleep 20'
Starting background service…
backgrounded · e1f523d7 · probe-job
  claude agents             list sessions
  claude attach e1f523d7    open in this terminal
  claude logs e1f523d7      show recent output
```

The id line is preceded by a cold-start notice and followed by hint lines, so
`parseStartedSession` matches a single line rather than parsing the whole output.

```
$ claude agents --json --all      # background entries only
[
  {
    "id": "e1f523d7",
    "cwd": "/private/tmp/scratch",
    "kind": "background",
    "startedAt": 1785025576080,
    "sessionId": "e1f523d7-e83b-46b8-9eca-538f4e74e609",
    "name": "probe-job",
    "state": "working"
  }
]
```

Two things here:

1. **`id` is the first 8 characters of `sessionId`.** Confirmed independently by
   `state.json`'s `daemonShort` field.
2. **No `pid`, despite `state: "working"`.** The docs describe `pid` as present while the
   process is alive, but the supervisor hosts the process so the roster has no CLI pid to
   report. Deriving cold/dormant from a missing `pid` therefore renders an actively-working
   agent as asleep — cold is derived from `state` instead.

## `state.json` is richer than the docs describe

```
$ cat ~/.claude/jobs/e1f523d7/state.json
{
  "state": "done",
  "detail": "hello-from-probe",
  "tempo": "idle",
  "output": null,
  "children": null,
  "linkScanOffset": 0,
  "template": "exec",
  "respawnFlags": [],
  "providerEnv": {},
  "intent": "echo hello-from-probe; sleep 20",
  "name": "probe-job",
  "nameSource": "user",
  "sessionId": "e1f523d7-e83b-46b8-9eca-538f4e74e609",
  "resumeSessionId": "e1f523d7-e83b-46b8-9eca-538f4e74e609",
  "daemonShort": "e1f523d7",
  "cwd": "/private/tmp/scratch",
  "createdAt": "2026-07-26T00:26:16.080Z",
  "updatedAt": "2026-07-26T00:26:37.922Z",
  "firstTerminalAt": "2026-07-26T00:26:37.922Z",
  "backend": "daemon"
}
```

`detail`, `intent` and `updatedAt` appear nowhere in `agents --json`, which is why the unified
roster merges this file. Entirely undocumented, so every field is read best-effort.

Also present: `~/.claude/jobs/pins.json` (`[]` when nothing is pinned) — pin state is readable
even though there is no CLI pin command.

## Daemon status is prose, in two shapes

```
$ claude daemon status            # running
pid:     9806
version: 2.1.220
uptime:  4s
origin:  transient — started on-demand by `claude --bg` (pid 9798) in /private/tmp/scratch
config:  /Users/cisco/.claude/daemon.json
log:     /Users/cisco/.claude/daemon.log

bg sessions:
  sock dir:     /tmp/cc-daemon-501/1d662268
  control.sock: reachable
  bg workers:   1 running (control.sock), 1 in roster.json
  roster.json:  updated 4s ago
```

```
$ claude daemon status            # not running
not running

bg sessions:
  sock dir:     /tmp/cc-daemon-501/1d662268
  control.sock: unreachable (connect ENOENT /tmp/cc-daemon-501/1d662268/control.sock)
  bg workers:   0 in roster.json (control unreachable)
  roster.json:  absent
  daemon.log:   absent
```

Both recorded as fixtures. Note `roster.json` lives at `~/.claude/daemon/roster.json`, not in
the socket directory.

## Everything exits 0, including failures

```
$ claude logs zzzzzzzz
No job matching 'zzzzzzzz'. Run 'claude agents' to list running sessions.
$ echo $?
0

$ claude logs e1f523d7            # daemon since exited
Couldn't read logs for e1f523d7 — connect ENOENT /tmp/cc-daemon-501/1d662268/control.sock
$ echo $?
0

$ claude stop e1f523d7
stopped e1f523d7
$ claude rm e1f523d7
removed e1f523d7
```

Exit codes carry no signal. `classifyOutput` pattern-matches output text, and treats a
non-zero exit as a failure only as a backstop.

Note also that `logs` requires a reachable supervisor — expected for a cold session, not a
fault.

## An unknown agent name only warns

```
$ claude --bg --agent __no_such_agent__ --name probe2 "say hi"
warning: no agent named '__no_such_agent__' — spawning with default template
Starting background service…
backgrounded · 4f544317 · probe2
```

The session is live and running the wrong agent. Agent names are validated against
`.claude/agents/` before dispatch, with `detectUnknownAgentWarning` as a backstop.

## Directories are created on demand

On a machine that has never run a background session, none of `~/.claude/jobs`,
`~/.claude/teams`, `~/.claude/tasks` or `~/.claude/daemon` exist. Watchers must tolerate that
and pick the directories up when they appear, which is why `ClaudeStateWatcher` watches the
config root at bounded depth rather than watching those paths directly.

## Hook events confirmed in the shipped schema

Read from `claude-code-settings.schema.json` inside the installed extension — authoritative
for this version, not just the docs. All seven events Muster subscribes to are present:

```
Notification, SubagentStart, SubagentStop, TaskCreated, TaskCompleted,
TeammateIdle, PostToolUseFailure
```

Handler shapes, per the schema:

| type | fields |
|---|---|
| `command` | `command`, `args`, `shell` (`bash` \| `powershell`), `async`, `asyncRewake`, `if`, `once`, `timeout`, `statusMessage` |
| `http` | `url`, `headers`, `allowedEnvVars`, `if`, `once`, `timeout`, `statusMessage` |
| `prompt` | `prompt`, `model`, `continueOnBlock`, … |
| `agent` | `prompt`, `model`, … |
| `mcp_tool` | `server`, `tool`, `input`, … |

Related settings that exist in this version: `allowedHttpHookUrls`, `httpHookAllowedEnvVars`,
`disableAllHooks`, `allowManagedHooksOnly`, `daemonColdStart`, `disableAgentView`,
`agentPushNotifEnabled`, `inputNeededNotifEnabled`, `preferredNotifChannel`.
