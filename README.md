# Decagram Council

Decagram Council is a **Windows-targeted Electron desktop application** for
coordinating durable, provider-neutral Missions across Claude Code and Codex.
It targets 64-bit Windows 10 and Windows 11 and packages as an assisted NSIS
installer.

Council owns the Mission ledger, isolated worktree leases, exact-commit
handoffs, independent Test and Review gates, and user-approved fast-forward
integration. Claude sessions and Codex threads remain provider-owned execution
contexts; Council does not adopt their internal task models or store provider
credentials.

## Current status

| Surface | State |
|---|---|
| Integration module and parsers | Implemented; platform-neutral tests pass |
| Trusted workspace, resolved catalog, and exact session bindings | Implemented; Windows verification pending |
| Provider-neutral Mission ledger and typed Missions UI | Implemented |
| Council-owned writer and detached gate worktrees | Implemented; real Windows filesystem verification pending |
| Codex App Server stdio client, auth status, exact thread bindings, turns, and approvals | Implemented; live macOS handshake completed; Windows verification pending |
| Exact handoffs, independent gates, and approved fast-forward integration | Implemented with real-Git and adversarial tests |
| PowerShell hooks and runtime guards | Implemented; awaiting a real Windows execution |
| Discovered-agent catalog UI | Implemented |
| Snapshot-driven pixel office | Initial paged implementation |
| Council Review pipeline | Implemented |
| Windows launch preflight and diagnostics | Implemented |
| x64 NSIS installer configuration | Implemented with final app ID; Windows packaging verification pending |

This checkout has not been claimed Windows-verified. The implementation/evidence distinction
is maintained in [docs/windows-verification.md](docs/windows-verification.md), and the
Milestone 2 outcome — decisions, commands and results, and outstanding Windows evidence — is
recorded in
[docs/codex-milestone-02-completion-report.md](docs/codex-milestone-02-completion-report.md).

## Windows requirements

- 64-bit Windows 10 or Windows 11
- Claude Code 2.1.220 or newer
- Codex CLI/App Server when Codex roles are used; Claude-only Missions remain
  available without it
- PowerShell
- Git for Windows
- Node.js 20.11 or newer for development
- Optional `node-pty` native module for direct replies; the app degrades to logs-only when
  it is unavailable

The package identifier is `com.decagram.council`.

## Application

The Electron main process owns every CLI call and filesystem read. The renderer is sandboxed,
has context isolation enabled, and has no Node access. A narrow preload bridge exposes typed
IPC operations for:

- reading the live roster;
- selecting and explicitly trusting a workspace through a privileged folder picker;
- starting or stopping a specialist;
- resuming, starting new, or clearing an exact profile binding without deleting provider work;
- explicitly waking sessions left failed after a machine restart;
- reading recent logs and sending a plain-text PTY reply;
- starting a Council Review through the `council-lead` main agent; and
- reading Windows launch diagnostics;
- creating and previewing a Mission squad with an explicit provider and access
  mode for every role;
- recording exact clean-commit handoffs, running allowlisted gates, and
  preparing an integration preview; and
- approving the exact single-use integration fingerprint through a native
  confirmation.

The UI shows one card per configured or discovered agent with identity, role, state, hot/cold
status, and pin state. Human-blocked sessions share one amber attention channel; when several need
attention, the first is shown with a count instead of creating competing alert surfaces.

The default Office view recreates the supplied Ops Deck art direction with local
canvas primitives. It shows five data-driven workstations per paged office, so
the scene scales beyond a fixed roster. Character, workstation, diagnostics-room,
and Council-room interactions route back to the same supervisor-backed controls
as the accessible Agents, Council, and Diagnostics views. Press `V` outside a
text field to toggle between the office and the most recent console view.

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
src/config/
  appConfig.ts            trusted workspace registry
src/supervisor/
  catalog.ts              precedence-aware definition inventory
  sessionBindings.ts      exact durable profile ownership
  launchCoordinator.ts    locked, journaled launch transactions
src/providers/
  missionContracts.ts     provider-neutral execution and event boundary
  codex/                  bounded App Server client + exact thread bindings
src/git/                  semantic, argv-only Git process authority
src/orchestration/worktrees/
                          strict writer and detached-gate ownership journals
src/missions/
  coordinator.ts          durable state transitions and stale-plan rejection
  ledger.ts               strict atomic Mission authority
  gitAdapter.ts           clean handoffs and fast-forward-only integration
  gateRunner.ts           allowlisted detached Test/Review execution
src/ui/
  main.ts                 Windows-only Electron main process
  missionController.ts    renderer-safe privileged Mission composition
  preload.cjs             isolated IPC bridge
  renderer/               static HTML, CSS, and JavaScript UI
scripts/gates/            shipped PowerShell runtime guards
.claude/agents/           specialist and council agent definitions
.claude/skills/           Council Review router
test/                     parser, guard, council, IPC, and integration tests
```

Council is single-instance. One long-lived local Codex App Server connection is
shared by the active application runtime and initialized once. Packaged startup never uses its process working
directory as a repository: first run stays in a recoverable setup screen until
the user chooses and trusts a folder. The app stores the workspace registry in
`app-config.json` and exact profile-to-Claude ownership in
`session-bindings.json`, both under Electron `userData`. Council also stores
`codex-thread-bindings.json`, `worktree-leases.json`, and
`mission-ledger.json` there. These stores use strict schemas, atomic
same-directory replacement, revision checks where applicable, and
last-known-good retention after malformed edits or unexpected deletion. The
Claude binding document
also journals an in-flight launch before spawning so an uncertain
acknowledgement can be reconciled after a crash.

Hooks provide the millisecond fast path, filesystem watches catch state changes, and
`claude agents --json --all` polling reconciles drift. Hooks schedule a refresh rather than
mutating UI state, so the CLI remains the source of truth. A failed roster read retains the
previous roster and marks it stale instead of making the squad disappear.
Definition/profile watcher failures retain the last-known-good catalog and
block new definition-based launches while exact already-bound lifecycle
actions remain available.

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

Before release, complete every required probe in
[docs/windows-verification.md](docs/windows-verification.md). The original macOS CLI
transcript in [docs/cli-surface.md](docs/cli-surface.md) is retained only as historical parser
evidence; it does not qualify the Windows build.

## Agent discovery and roster preferences

Opening a trusted workspace does not create or migrate `roster.json`. Existing
version-1 files remain readable and are normalized only in memory; version 2 is
written only by an explicit preference save.
Effective definitions visible from the selected project's `.claude/agents/` hierarchy
and the user Claude configuration are merged into the live catalog as on-demand profiles. Saved
members remain label, prompt, model, effort, and ordering overrides. A malformed edit retains the
last-known-good profiles, blocks overwrite, and surfaces a visible diagnostic.

```json
{
  "version": 2,
  "profiles": [
    {
      "id": "profile-configured123",
      "workspaceId": "ws_11111111-1111-4111-8111-111111111111",
      "catalogId": "catalog_…",
      "agentName": "builder",
      "label": "Builder",
      "order": 0,
      "visible": true,
      "mode": "normal",
      "autoStart": false
    }
  ],
  "pollIntervalMs": 10000
}
```

Newly discovered definitions and providers are never started automatically.
See
[`docs/codex-milestone-02-provider-neutral-missions.md`](docs/codex-milestone-02-provider-neutral-missions.md)
for the implemented Milestone 2 contract.

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
- Profile ownership is app-owned and exact: labels, agent names, and cwd are
  never used to claim a Claude session.

Windows wording, locations, watcher behavior, PTY ABI compatibility, and installer behavior
must be captured on a Windows host before release.

Codex App Server was additionally checked on the macOS development host using
the real bundled Codex executable: the stable stdio connection initialized,
reported non-secret authenticated state, and was closed without deleting or
archiving a thread. That evidence validates the local protocol seam only; it is
not Windows verification.
