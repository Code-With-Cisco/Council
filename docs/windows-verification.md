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
- `npm test`: passed; 15 PowerShell-dependent tests skipped
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

Record the Windows version, architecture, Claude Code version, PowerShell
executable/version, Node version, test date, and evidence for each completed
item here. Leave every unperformed item unverified.
