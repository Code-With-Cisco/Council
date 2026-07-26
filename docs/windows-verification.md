# Windows verification ledger

Decagram Council supports Windows only. This ledger separates implementation
from evidence gathered on a real Windows host. A passing macOS typecheck or a
PowerShell suite skipped because no interpreter exists is not Windows
verification.

Last updated: 2026-07-26

## Current non-Windows evidence

This is implementation evidence only:

- `npm run typecheck`: passed
- `npm run build`: passed
- `npm test`: 94 passed, 15 skipped
- skipped tests: PowerShell execution suites; no PowerShell interpreter is available on this host
- `npm audit --omit=dev`: 0 vulnerabilities in the packaged runtime dependency set
- full `npm audit`: 16 high-severity advisories in electron-builder's build-time
  glob/minimatch/brace-expansion chain; npm's offered forced fix is a breaking downgrade and
  was not applied

| Surface | Status | Evidence / next check |
|---|---|---|
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
| Electron package / NSIS installer | not-verified | Requires final appId and a Windows packaging run |

## Required Windows release probe

Before calling a build Windows-verified:

1. Run the full test suite with PowerShell available and confirm no suites skip.
2. Run `guard-self-test.ps1` through the application launch preflight.
3. Capture the Windows CLI transcript described in the Windows probe prompt.
4. Replace macOS-shaped parser fixtures with Windows fixtures or retain an
   explicit `unknown` state for any unverified shape.
5. Exercise the watcher, PTY-present, PTY-absent, packaged launch, and installer.
6. Record the Windows version, architecture, Claude Code version, PowerShell
   executable/version, Node version, and test date in this file.
