# Claude Code CLI surface — Windows

Current source of truth for `src/integration/` parser assumptions. Captured on
2026-08-16 on Windows 10.0.26200 against the native Claude Code 2.1.233 binary at
`C:\Users\User\.local\bin\claude.exe`.

## Version and discovery

```text
2.1.233 (Claude Code)
```

The installer reports that location directly. The directory was also added to
the persistent user `PATH`; desktop startup does not depend on that because
`locateClaude` probes the well-known path explicitly.

## Empty roster and resting supervisor

With no sessions:

```json
[]
```

`claude agents --json --all` exits 0. `claude daemon status` describes the
normal cold state and exits 1:

```text
not running

bg sessions:
  sock dir:     \\.\pipe\cc-daemon-*
  control.sock: unreachable (connect ENOENT \\.\pipe\cc-daemon-*-control)
  bg workers:   0 in roster.json (control unreachable)
  roster.json:  absent
  daemon.log:   absent
```

Service installation is disabled in this CLI. The transient supervisor starts
on demand and exits after its last client, so this is a designed cold state.

## Background dispatch and roster shape

A disposable `--bg --exec` probe (which uses no model quota) returned:

```text
backgrounded · <short-id> · <name>
```

Windows background rows carry `id`, `cwd`, `kind`, `startedAt`, `sessionId`,
`name`, and `state`. A working supervisor-hosted row may omit `pid`; state and
process liveness must therefore remain independent UI axes. The short id is the
first eight characters of `sessionId`.

Observed lifecycle values in 2.1.233 include `working`, `blocked`, `done`,
`failed`, `stopped`, `starting`, `resuming`, `adopted`, `crashed`, and `running`.
Observed waiting reasons include `goal proposal` in addition to the earlier
permission/input/sandbox/worker/dialog values. Unknown waiting text remains
pass-through.

## Running supervisor shape

The checked-in `test/fixtures/daemon-status-running-windows.txt` is a captured
2.1.233 transcript. It contains `pid`, `version`, `uptime`, `origin`, named-pipe
transport, live and roster worker counts, and the Windows-only trailing
`holding this daemon open` block. The paired stopped fixture captures the cold
shape above.

`claude daemon stop --any --keep-workers` has two observed successful forms:
`stopped` and `no daemon running`. A truly wedged supervisor has not been
reproduced; its manual PID recovery parser intentionally retains raw output.

## Error envelopes

The CLI can report a semantic failure with exit code 0. Classification therefore
matches anchored diagnostic lines only:

- `No job matching ...` → unknown session
- `Couldn't read logs for ...` → supervisor unavailable
- `error: ...` → CLI error

Arbitrary agent log prose containing the same phrases is not an error.

## Teams and tasks

An existing Windows team config was read from
`%USERPROFILE%\.claude\teams\session-<8 chars>\config.json`. Its top-level
fields are `name`, `createdAt`, `leadAgentId`, `leadSessionId`, and `members`.
Member fields are `agentId`, `name`, `agentType`, `joinedAt`, `tmuxPaneId`,
`cwd`, `subscriptions`, and `backendType`. The current read-only parser already
accepts the fields it consumes.

Creating a fresh task record and testing independent-session messaging were
attempted, but the Claude account reported `Login expired · Please run /login`
before model execution. These remain external verification items rather than
guessed contracts.

## Codex App Server

`npm run verify:codex-live` passed against Codex
`0.148.0-alpha.9` on Windows. It initialized over stdio, reported authenticated
Windows state, and shut down cleanly.
