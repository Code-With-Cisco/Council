# Decagram Council

Decagram Council is a **Windows-only Electron desktop application** for observing and
controlling Claude Code's existing multi-agent runtime. It targets 64-bit Windows 10 and
Windows 11 and packages as an assisted NSIS installer.

The application is not an agent runtime. Claude Code's supervisor owns background sessions,
persistence, worktrees, and scheduling. Decagram Council calls the `claude.exe` CLI, reads
Claude's state files, and renders that authoritative state.

## Current status

| Surface | State |
|---|---|
| Integration module and parsers | Implemented; platform-neutral tests pass |
| PowerShell hooks and runtime guards | Implemented; awaiting a real Windows execution |
| Discovered-agent catalog UI | Implemented |
| Council Review pipeline | Implemented |
| Windows launch preflight and diagnostics | Implemented |
| x64 NSIS installer configuration | Implemented; packaging awaits final app ID and Windows verification |

This checkout has not been claimed Windows-verified. The implementation/evidence distinction
is maintained in [docs/windows-verification.md](docs/windows-verification.md).

## Windows requirements

- 64-bit Windows 10 or Windows 11
- Claude Code 2.1.220 or newer
- PowerShell
- Git for Windows
- Node.js 20.11 or newer for development
- Optional `node-pty` native module for direct replies; the app degrades to logs-only when
  it is unavailable

The package identifier is intentionally still
`com.PLACEHOLDER.decagram-council`. Replace it with the final reverse-domain identifier
before signing or distributing an installer.

## Application

The Electron main process owns every CLI call and filesystem read. The renderer is sandboxed,
has context isolation enabled, and has no Node access. A narrow preload bridge exposes typed
IPC operations for:

- reading the live roster;
- starting or stopping a specialist;
- explicitly waking sessions left failed after a machine restart;
- reading recent logs and sending a plain-text PTY reply;
- starting a Council Review through the `council-lead` main agent; and
- reading Windows launch diagnostics.

The UI shows one card per configured or discovered agent with identity, role, state, hot/cold
status, and pin state. Human-blocked sessions share one amber attention channel; when several need
attention, the first is shown with a count instead of creating competing alert surfaces.

The diagnostics view does not guess. Missing dependencies remain visible, a stopped Claude
daemon is shown as a normal resting state, and unrecognized daemon prose is shown as
**Unknown** with the raw text retained.

## Council Review

Council Review is an executable multi-agent pipeline, not a single-context role-play:

1. `council-lead` freezes one evidence packet.
2. Five read-only advisors analyze it independently.
3. Their findings are shuffled as Responses A–E.
4. Advisors perform a structured peer review.
5. The read-only chairman returns the final verdict.

The app starts the lead with `claude.exe --bg --agent council-lead ...`; arguments are passed
as an array without shell interpolation. The lead definition carries the exact advisor
allowlist.

## Runtime guards

`scripts/gates/` contains one Windows PowerShell implementation. There is no Bash gate path.

- `agent-write-dispatch.ps1` routes `Edit|Write` events by `agent_type`.
- `agent-shell-dispatch.ps1` evaluates PowerShell operations for guarded agents.
- The builder, test engineer, and PRD lead receive role-specific write restrictions.
- `story-gate.ps1` enforces PRD traceability and runs acceptance commands in a fresh,
  non-interactive PowerShell process.
- `guard-self-test.ps1` exercises the installed guard set during launch preflight.

The guards are registered in `.claude/settings.json` with PowerShell as the default shell.
They are defense in depth for supported Claude tool events, not an operating-system sandbox.
See [scripts/gates/README.md](scripts/gates/README.md) for the exact boundary.

## Architecture

```text
src/integration/          Electron-free runtime integration
  client.ts               argv-array Claude CLI client
  runtime.ts              poll + watch + hooks -> one Snapshot
  preflight.ts            Windows launch diagnostics
  cli/                    claude.exe discovery, execution, error classification
  parse/                  roster and daemon parsers
  fs/                     jobs, teams, definitions, and watchers
  roster/                 editable squad config and unified roster
  hooks/                  authenticated localhost receiver and hook generation
  pty/                    attach and headless reply
  gates/                  PowerShell install planning and self-test wrapper
src/ui/
  main.ts                 Windows-only Electron main process
  preload.cjs             isolated IPC bridge
  renderer/               static HTML, CSS, and JavaScript UI
scripts/gates/            shipped PowerShell runtime guards
.claude/agents/           specialist and council agent definitions
.claude/skills/           Council Review router
test/                     parser, guard, council, IPC, and integration tests
```

Hooks provide the millisecond fast path, filesystem watches catch state changes, and
`claude agents --json --all` polling reconciles drift. Hooks schedule a refresh rather than
mutating UI state, so the CLI remains the source of truth. A failed roster read retains the
previous roster and marks it stale instead of making the squad disappear.

## Development

Windows is the only supported packaged target. Unpackaged development builds may
also run on macOS so the UI and supervisor integration can be developed on the
authoring machine; Diagnostics continues to mark that platform unsupported.

Run these commands from PowerShell or a macOS terminal:

```powershell
npm install
npm run typecheck
npm test
npm start
```

Build an unpacked Windows directory or an NSIS installer:

```powershell
npm run pack:win
npm run dist:win
```

Before release, replace the placeholder app ID and complete every required probe in
[docs/windows-verification.md](docs/windows-verification.md). The original macOS CLI
transcript in [docs/cli-surface.md](docs/cli-surface.md) is retained only as historical parser
evidence; it does not qualify the Windows build.

## Agent discovery and roster preferences

On first run, the application writes an empty `roster.json` preferences file under its user-data
directory. Effective definitions visible from the selected project's `.claude/agents/` hierarchy
and the user Claude configuration are merged into the live catalog as on-demand profiles. Saved
members remain label, prompt, model, effort, and ordering overrides. An invalid edit degrades with a
visible diagnostic rather than crashing.

```json
{
  "version": 1,
  "members": [
    {
      "key": "builder-main",
      "label": "Builder",
      "agent": "builder",
      "cwd": "C:\\work\\meridian",
      "role": "Implementation"
    }
  ],
  "pollIntervalMs": 10000
}
```

Newly discovered definitions are never started automatically. See
[`docs/codex-next-phase-brief.md`](docs/codex-next-phase-brief.md) for the supervisor, catalog,
session-binding, pixel-office, and Windows verification roadmap.

## Verified integration assumptions

The implementation was originally probed against Claude Code 2.1.220. Important mismatches
between the requested product behavior and that CLI surface are preserved:

- There is no `claude reply`; direct replies use `claude attach <id>` through a PTY.
- Some CLI failures exit zero, so anchored output envelopes are classified instead.
- `claude daemon status` is prose and a stopped transient daemon is normal.
- An unknown `--agent` warns and starts a default agent, so definitions are validated before
  dispatch.
- The five persistent specialists are background sessions, not one ephemeral Claude team.
- Background sessions can relocate to `.claude/worktrees/`.
- Pin state is readable, but the CLI has no pin command.

Windows wording, locations, watcher behavior, PTY ABI compatibility, and installer behavior
must be captured on a Windows host before release.
