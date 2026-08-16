# What was done

Completion record for the Windows-only closure and the A, B, and C briefs on
2026-08-16. The work is present only in the working tree: no commit was created
and nothing was pushed.

## What-needs-to-be-done closure

- Chose the conservative resume policy: Reply is available for `blocked` /
  `input needed`, `done`, and `failed`, but never for explicitly `stopped`.
  Terminal states are labelled "Send a reply and resume" in the UI.
- Retained the already concrete application identity
  `com.decagram.council`; the Windows AUMID uses the same value.
- Upgraded the host Claude Code CLI to 2.1.233 and added
  `C:\Users\User\.local\bin` to the persistent user PATH.
- Verified the Codex App Server live on Windows: authenticated, Windows
  platform metadata, version `0.148.0-alpha.9`, and a clean close.
- Replaced the archived macOS CLI transcript and parser audit with Windows
  2.1.233 evidence. Removed the obsolete Windows parity ledger.
- Removed macOS Codex discovery branches, macOS daemon fixtures, POSIX fixture
  paths, macOS provider test data, and the unpackaged non-Windows default. The
  explicit development escape hatch remains
  `DECAGRAM_COUNCIL_ALLOW_NON_WINDOWS_DEV=1`.
- Clarified naming: Decagram Council is the product/runtime name; "council" is
  retained for the actual council feature and its durable Git namespace.
- Tightened CLI error recognition to full diagnostic lines so ordinary logs
  containing words such as "not found" are not misclassified.
- Made PTY Reply wait for real terminal output plus a quiet interval. A silent
  attach times out without sending user text.

## A — guards and correctness

- Kept one Windows PowerShell hook dialect and made every hook invocation
  explicit: `powershell.exe -NoProfile -NonInteractive -File ...`.
- Documented and enforced the hook contract: exit 0 allows; exit 2 blocks with
  the reason on stderr. Unexpected guarded-child exits now fail closed as 2.
- Preserved unconditional gate generation and the existing no-Keychain Windows
  configuration.
- Closed the five enforcement gaps:
  1. guarded child failures cannot silently allow;
  2. direct shell hooks receive explicit Builder/Test Engineer identity;
  3. Test Engineer can edit only an existing one-line story `acceptance:` field,
     while PRD Lead cannot edit it or replace a story wholesale;
  4. containment follows Windows junction/reparse targets segment by segment;
  5. inline interpreters and nested command shells cannot bypass the shell
     construct guard.
- Added regression coverage for every bypass, including a real junction test.
- Kept exact durable session identity as the binding key. CWD and PID are never
  used to choose a primary session, and process liveness remains separate from
  session state.

## B — council wiring

- Audited all six council member definitions and the council-lead definition.
- Kept tools in documented string form and kept each member's permissions within
  its declared allowlist. Removed Chairman's unnecessary `permissionMode` so its
  read-only behavior depends on its tools, not inherited mode behavior.
- Removed stale `SHOULD route`, `SHOULD NOT route`, and `WATCH` body trailers;
  routing signals live in distinct descriptions.
- Required the exact final line `COUNCIL MEMBER SIGN-OFF` from every advisor.
- Made council-lead's scope explicit: it coordinates only agents it spawns in
  its own session, retries a failed/missing/sign-off response once, and then
  blocks instead of silently substituting an answer.
- Expanded council definition tests to cover descriptions, tools, trailers,
  sign-off, and lead failure behavior.

## C — Electron UI and packaging

- Added a flat background-session roster showing name, session state, CWD, age,
  and a distinct process-liveness column. Missing PID is displayed as unknown,
  never inferred as dead; terminal resumability and explicit stop are distinct.
- Added cold-start and roster-failure empty states.
- Expanded preflight to report PowerShell, Git Bash path, Git, Node, guard
  self-test, PTY capability, supervisor reachability/version/workers/mismatch,
  and raw diagnostics.
- Added a safe supervisor-recovery IPC/action using
  `daemon stop --any --keep-workers`. Manual PID termination is shown only when
  the parser actually returns a PID.
- Generated a genuine multi-resolution Windows icon and added the reproducible
  `npm run build:icon` pipeline plus ICO structure tests.
- Configured electron-builder for NSIS x64 and ARM64 in one per-user installer,
  with an install-directory chooser and desktop shortcut.
- Built both unpacked architectures and
  `release/Decagram Council Setup 0.1.0.exe` plus its blockmap.
- Final installer SHA-256:
  `D644CFF1ACE7A3918D5E12B51FEDB0238BE1BE46C141A8E6E149B35062EFE5E5`.
- Smoke-launched the packaged x64 app on Windows. With the host-only
  `ELECTRON_RUN_AS_NODE` override removed, four package processes remained alive
  and the window was responsive after 12 seconds; only those processes were
  then stopped.

## Verification

- `npx tsc --noEmit`: passed.
- `npm test`: 45 files, 421 tests, 0 failures.
- `npm run build:icon`: passed.
- `npm run verify:codex-live`: passed against the real Windows Codex binary.
- `npm run dist:win`: passed for x64 and ARM64 and produced the combined NSIS
  installer.
- Live Claude roster and daemon probes ran against 2.1.233. A disposable team
  attempt reached the supervisor but model execution stopped at
  `Login expired · Please run /login`; the disposable session was stopped and
  removed, leaving an empty roster.

## Deliberately not claimed

The remaining checks in `WHAT-NEEDS-TO-BE-DONE.md` require a refreshed Claude
login, a naturally wedged supervisor, or human visual/installer interaction.
They are not represented as verified.
