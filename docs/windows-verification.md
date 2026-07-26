# Windows verification ledger

Windows is Decagram Council's only packaged target. Real-host Windows support
verification remains outstanding; this ledger separates implementation from
evidence gathered on a real Windows host. A passing macOS typecheck or a
PowerShell suite skipped because no interpreter exists is not Windows
verification.

Last updated: 2026-07-26

## Current non-Windows evidence

This is implementation evidence only:

- `npm run typecheck`: passed
- `npm run build`: passed
- `npm test`: 43 files, 390 passed, 15 skipped, 0 failed
- skipped tests: PowerShell execution suites; no PowerShell interpreter is available on this host
- `npm audit --omit=dev`: 0 vulnerabilities in the packaged runtime dependency set
- full `npm audit`: 16 high-severity advisories in electron-builder's build-time
  glob/minimatch/brace-expansion chain; npm's offered forced fix is a breaking downgrade and
  was not applied

| Surface | Status | Evidence / next check |
|---|---|---|
| Single-instance startup and focus | implemented-unverified | Unit-tested on macOS; verify two desktop/Start-menu launches against one packaged Windows runtime |
| First-run trusted workspace selection | implemented-unverified | Store, validation, trust, recovery, and IPC tests pass; exercise the privileged picker and junction behavior on Windows |
| Resolved agent catalog and watcher replacement | implemented-unverified | Precedence, ambiguity, fingerprint, diagnostics, and add/edit/remove tests pass on macOS; verify Windows filesystem events |
| Exact session bindings and crash journal | implemented-unverified | Persistence, last-known-good, exact-ID roster, pending recovery, and atomic-failure tests pass; verify real Claude restart behavior on Windows |
| Serialized safe launch and lifecycle | implemented-unverified | Concurrency, substitution cleanup, timeout recovery, CAS replacement, shutdown, and authorization tests pass with fakes; exercise real CLI behavior on Windows |
| Provider-neutral Mission authority | implemented-unverified | Strict Mission transitions, stale previews, partial-start recovery, exact assignments, and mixed-provider routing are covered on macOS; execute a mixed Claude/Codex Mission on Windows |
| Codex App Server stdio transport | implemented-unverified | Unit tests cover initialization, authentication state, malformed/oversized messages, request correlation, approvals, process exit, exact resume, and shutdown; a real authenticated macOS handshake passed, which is not Windows evidence |
| Codex persistent role threads | implemented-unverified | Exact binding, contract fingerprint, access mode, initial-turn journal, resume, interruption, and shutdown-race tests pass; verify provider-owned sign-in and restart behavior with the Windows Codex executable |
| Council-owned writer worktrees | implemented-unverified | Real-Git tests cover generated refs, exact base commit/tree, collision rejection, dirty retention, crash reconciliation, and no shutdown deletion; repeat against Git for Windows, NTFS, and a path containing spaces |
| Detached Test and Review gates | implemented-unverified | Policy-only argv, minimal environment, exact detached commit/tree, bounded hashed evidence, independent assignments, and cleanup recovery are tested; run with PowerShell and Windows process termination semantics |
| Approved fast-forward integration | implemented-unverified | Real-Git and adversarial tests cover exact preview approval, target drift, expected-old ref update, checkout synchronization, and approved-journal recovery; repeat on the packaged Windows runtime |
| Typed Missions UI and shared projections | implemented-unverified | Start Squad, exact handoff, gate, retry, and integration surfaces are covered by controller/IPC/view-model tests; inspect keyboard use, scaling, native confirmations, and provider diagnostics on Windows |
| Sandboxed typed IPC | implemented-unverified | Sender, opaque-ID, type/size/control-byte tests pass; renderer state excludes executable paths and generic process authority |
| TypeScript integration module | implemented-unverified | Typechecks and platform-neutral unit tests pass on macOS; run the full suite on Windows |
| Electron squad and detail UI | implemented-unverified | Static architecture and IPC tests pass; launch and scaling require Windows |
| Council Review UI and dispatch | implemented-unverified | Argv construction and agent-definition tests pass; execute a full council on Windows |
| Native frame and sandboxed renderer | implemented-unverified | Configured in `src/ui/main.ts`; inspect at 100%, 125%, 150%, and 200% Windows scaling |
| PowerShell hook forwarder | implemented-unverified | Source and config tests pass; execute `test/hookScript.test.ts` on Windows |
| Write guards | implemented-unverified | PowerShell suite is present but skipped on this host because PowerShell is unavailable |
| Shell construct guard | implemented-unverified | PowerShell suite is present but skipped on this host because PowerShell is unavailable |
| Story gate | implemented-unverified | PowerShell suite is present but skipped on this host because PowerShell is unavailable |
| Guard self-test | implemented-unverified | `guard-self-test.ps1` and the typed Node entry point exist; run from the Windows launch preflight |
| Hook `agent_type` on `--agent` | docs-verified, runtime-unverified | Current hooks docs say it is present; confirm with a Windows payload transcript |
| Hook `agent_type` in subagents | docs-verified, runtime-unverified | Current hooks docs say it is present; confirm with a Windows payload transcript |
| PowerShell tool availability | docs-verified, runtime-unverified | Explicitly enabled in `.claude/settings.json`; confirm actual resolved tool on Windows |
| `.ps1` hook execution | docs-verified, runtime-unverified | Hooks use `shell: powershell`; confirm pwsh.exe / powershell.exe selection |
| CLI location | implemented-unverified | Windows search locations must be exercised on a Windows desktop launch |
| Roster JSON | not-verified | Capture `claude agents --json --all` on Windows |
| Job state files | not-verified | Capture location and full state.json on Windows |
| Daemon status | not-verified | Capture running and stopped wording; determine named-pipe form |
| Watcher wake-up | not-verified | Modify the Claude config root and confirm chokidar plus polling behavior |
| Optional node-pty | not-verified | Test both installed and absent for the packaged Electron ABI |
| Electron package / NSIS installer | not-verified | Final appId is configured; a Windows packaging/install run is still required |

## Required Windows release probe

Before calling a build Windows-verified:

1. Run the full test suite with PowerShell available and confirm no suites skip.
2. Perform a clean install or packaged launch.
3. Complete first-run folder selection with a project path containing spaces.
4. Launch from both the desktop and Start-menu shortcuts; verify the second
   launch focuses the first instance.
5. Capture Claude discovery, version, authentication, roster JSON, and daemon
   status on Windows.
6. Launch at least two distinct role profiles.
7. Close and reopen Council and verify exact session reattachment.
8. Exercise Stop, Resume, Start new, Logs, safe Reply, and targeted Wake.
9. Exercise definition add, edit, rename, and removal refresh.
10. Run `guard-self-test.ps1` through application launch preflight.
11. Test both optional `node-pty` present and absent in the packaged Electron ABI.
12. Inspect the UI at 100%, 125%, 150%, and 200% Windows display scaling.
13. Connect to the Windows Codex App Server, confirm provider-owned
    authentication status, then close Council and verify no thread is deleted
    or archived.
14. Start a mixed Claude/Codex Mission with distinct read-only Test and Review
    assignments and at least one writer worktree under a user-data path
    containing spaces.
15. Restart once during writer provisioning and once after a Codex thread is
    saved but before its first turn is acknowledged; confirm Council offers
    only the exact durable retry and creates no duplicate worktree or turn.
16. Record an exact clean-commit handoff, run both detached gates, move the
    target branch after preview, and confirm the old integration fingerprint is
    rejected without mutation.
17. Repeat integration without drift, approve the exact preview, interrupt the
    app after the expected-old ref update, and confirm restart recovery leaves
    the selected branch and checkout at the one reviewed commit.
18. Quit while a Mission operation and gate command are active; verify Council
    stops only its own processes, drains or blocks durable writes, and
    preserves provider conversations and worktrees.

Record the Windows version, architecture, Claude Code version, PowerShell
executable/version, Node version, test date, and evidence for each completed
item here. Leave every unperformed item unverified.
