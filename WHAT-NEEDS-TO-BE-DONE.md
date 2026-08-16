# What needs to be done

Action plan updated 2026-08-16 from testing the installed Windows application.
Work in this document is ordered by user impact and dependency. Do not begin
multi-window or distribution work until the existing session, Mission, and
diagnostic paths are observable and reliable.

## Implementation status after the repair pass

Implemented in the uncommitted working tree on 2026-08-16:

- structured Mission failures, correlation IDs, redacted bounded journal, and
  visible Refresh changed/unchanged status;
- typed actionable Attention items and interactive Diagnostics cards;
- safe bounded recent-output rendering with reload and copy;
- automatic Council progress/result projection with explicit result markers
  and compatibility for the already-completed live transcript;
- direct Start with message and exact idle-session messaging;
- conflict-safe Repository Agent Pack preview/install with a versioned manifest;
- saved single-runtime Office switching by workspace ID; and
- packaged Codex discovery in current VS Code and VS Code Insiders extension
  layouts for x64 and ARM64; and
- manual in-app Windows update check, download progress, confirmed install, and
  orderly relaunch, plus a tag-only draft GitHub Release workflow; and
- packaged guard scripts outside `app.asar`, packaged-resource resolution, and
  Windows PowerShell 5.1-compatible guard self-test canary handling.

Automated verification is green (`npx tsc --noEmit`, 49 test files / 437 tests,
build, x64 NSIS packaging, and a clean production dependency audit). The
following work remains and must not be
treated as verified or complete:

- run the installed-app matrix in Phase 4, especially live output, direct chat,
  the current completed Council transcript, a minimal Claude Mission, Codex
  authentication/App Server initialization, and three saved repositories;
- confirm Diagnostics reports **Guard self-test: Passed** in a newly installed
  build. The rebuilt unpacked x64 package and its exact external script pass,
  but an installer/UI interaction is not claimed yet;
- add Agent Pack update/uninstall with backup restoration. The current installer
  is idempotent and conflict-safe but intentionally has no destructive uninstall;
- add the user-selected Codex executable override/picker and attempted-location
  history. Automatic discovery for the observed VS Code path is implemented;
- add Mission abandoned-draft reset and validate live retry behavior;
- add per-workspace UI preference restoration and inactive-office activity
  summaries; and
- configure consistent Authenticode signing, publish two incrementing test
  versions, and perform an installed-app update/download/install/relaunch test;
  and
- install the local 0.2.1 bugfix over the currently installed build and confirm
  the Diagnostics card passes, or publish a reviewed `v0.2.1` release so an
  installed 0.2.0 can exercise the in-app update path; and
- keep concurrent windows blocked until every IPC request carries and validates
  an exact workspace ID and runtime-registry isolation tests pass.

## Confirmed working

- The local NSIS installer completes and the installed application launches.
- Individual agents can start, stop, and resume.
- Claude authentication has been refreshed sufficiently to run agents.
- A live Council Review launched all five advisors and the Chairman.
- `claude logs 9cb64425` returns the complete live Council transcript from the
  CLI, including the finished Chairman verdict.

The last two observations are important: Council did not lose the Chairman's
answer and Claude logs are not globally broken. The installed UI failed to
surface data that exists in the provider session.

## Phase 0 — make failures diagnosable

### 0.1 Replace generic Mission failures with safe structured problems

Current behavior: every unexpected privileged Mission exception is discarded
by `runMissionAction()` and replaced with:

```text
Mission action could not be completed. Refresh Mission state for current blockers.
```

Refreshing can show the same state because the underlying exception never
becomes part of the state projection.

Plan:

- Define stable Mission failure codes such as `ledger-blocked`,
  `provider-unavailable`, `stale-revision`, `invalid-assignment`,
  `worktree-failure`, and `unexpected`.
- Return a bounded, renderer-safe explanation and recommended next action for
  expected failures.
- Record technical details in a bounded local diagnostic log with a correlation
  ID. Do not expose secrets, raw provider payloads, or unrestricted paths to the
  renderer.
- Show the correlation ID and a Copy diagnostics action for unexpected errors.
- Make Refresh visibly report its timestamp, old/new revision, and whether
  anything changed.

Acceptance:

- Every failed Mission action identifies the failed operation and a useful
  blocker or correlation ID.
- Refresh never appears to succeed silently; it says changed, unchanged, or
  failed.
- Tests cover each expected failure code and verify redaction of unsafe detail.

### 0.2 Create one typed issue/action model

Roster attention, catalog problems, provider failures, Mission blockers,
binding errors, and preflight diagnostics currently use unrelated text shapes.

Plan:

- Introduce a renderer-safe issue model containing ID, severity, source,
  affected workspace/profile/Mission, summary, safe detail, destination, and
  allowed remediation actions.
- Derive the Attention channel and Diagnostics cards from this model.
- Keep provider state authoritative; UI navigation must never mutate or infer a
  fix by itself.

Acceptance:

- The same issue has the same ID and wording in Attention and Diagnostics.
- Every actionable issue has a destination and at least one valid next step.
- Informational conditions such as a resting supervisor remain non-errors.

## Phase 1 — repair broken installed-app workflows

### 1.1 Fix Load recent output for every exact binding

Evidence: the CLI successfully returned the transcript for session `9cb64425`,
while the installed app did not display it. The CLI transcript also contains
ANSI/TUI control sequences that should not be rendered directly.

Plan:

- Trace the exact renderer → IPC → supervisor → provider result for active,
  blocked, failed, done, and stopped bindings.
- Preserve the safe failure kind and explanation instead of showing only a
  generic feedback message.
- Strip ANSI and terminal control sequences, normalize line endings, and retain
  a bounded tail before rendering.
- Display loading, empty, unavailable/cold-supervisor, and loaded states inside
  the output panel.
- Add Copy output and Reload actions. Consider bounded polling while a selected
  session is working so Council progress does not look frozen.

Acceptance:

- Load recent output displays readable text for the live Council session and
  ordinary agents.
- A cold supervisor produces an actionable explanation instead of a blank box.
- No escape sequences, terminal cursor commands, or unbounded output reach the
  DOM.
- IPC, renderer, active-session, terminal-session, and failure-path tests pass.

### 1.2 Complete the Council result lifecycle

Evidence: the live transcript shows all five advisors completed, the Chairman
finished, and a final verdict was produced. Council still showed `working` and
the stale text "chairman recommends" because the parent background session
remained open and the UI does not recognize a finished Council artifact.

Plan:

- Add an exact machine-readable completion marker and bounded final-result
  envelope to the council-lead protocol.
- Validate five advisor sign-offs, the anonymized A–E mapping, Chairman output,
  and retry history before accepting completion.
- Project Council state separately from the raw Claude session state:
  `collecting`, `peer-review`, `chairman`, `complete`, or `blocked`.
- Automatically surface the final verdict in the Council view and offer Copy,
  View transcript, Start new Council, and Stop retained session actions.
- Decide whether the lead should stop its background session after recording a
  valid result or remain resumable; whichever policy is chosen must not leave
  the UI displaying an endless deliberation.
- Preserve the existing retry-once-then-block rule and expose the failed advisor
  when it triggers.

Acceptance:

- The observed live transcript resolves to `complete` and displays the Chairman
  verdict without requiring Load recent output.
- Missing sign-off, missing Chairman output, and second advisor failure resolve
  to explicit blocked states.
- Restarting Council restores the last completed result without relaunching the
  panel.

### 1.3 Make Mission creation/start produce a resolvable state

Plan:

- Reproduce the installed failure with the exact selected profiles, providers,
  access modes, ledger revision, and repository state.
- Verify each step independently: create draft, preview squad, confirm preview,
  create worktree leases, start provider assignments, and persist execution
  state.
- Surface preconditions before enabling Start: clean repository requirements,
  provider readiness/authentication, launchable definition fingerprint,
  distinct Test/Review roles, gate policy, and current ledger revision.
- Keep the failed step and inputs available for retry rather than clearing the
  form or returning a generic failure.
- Add an explicit Reset abandoned draft action with confirmation.

Acceptance:

- A minimal Claude-only Mission starts in a disposable repository.
- The UI identifies exactly which phase blocked and presents Retry, Edit draft,
  or Reset as appropriate.
- Refresh reconstructs the same durable state after application restart.
- Stale revisions and provider/worktree failures have dedicated regression
  tests.

### 1.4 Make Attention navigable and resolvable

Current behavior: the amber Attention channel is a static section showing only
the first item and count; it has no click or keyboard interaction.

Plan:

- Render each attention item as a button/list entry with accessible keyboard
  behavior.
- On activation, navigate to the affected Agent, Mission, Council result, or
  Diagnostic card; select it, scroll it into view, and focus the appropriate
  control.
- Show all queued items rather than only "showing first".
- Provide only actions valid for that issue, such as Reply, Resume, Retry exact
  assignment, Clear stale binding, Re-run discovery, or Open Diagnostics.

Acceptance:

- Every attention item navigates to the correct exact object.
- Resolving the condition removes the item after the authoritative refresh.
- Multiple simultaneous items are individually accessible by mouse and
  keyboard.

### 1.5 Make Diagnostics cards interactive

Current behavior: `diagnosticCard()` creates a static `<article>` with summary
text. A problem cannot be expanded, copied, retried, or used to navigate.

Plan:

- Add collapsed summary and expandable safe detail to every card.
- Give failing cards contextual actions: retry probe, refresh provider status,
  open the relevant in-app issue, copy diagnostic, choose executable, or show
  installation instructions.
- Include checked time, discovery method, resolved executable where safe,
  version, protocol/authentication state, and the last bounded failure.
- Preserve a noninteractive presentation for healthy informational cards.

Acceptance:

- Every warning/error card opens details and provides a useful next action.
- Actions update only the affected diagnostic and visibly report success or
  failure.
- Full keyboard navigation and focus-return tests pass.

## Phase 2 — add missing core interactions

### 2.1 Allow direct individual-agent conversations

Current behavior: a user can start an agent, but cannot supply an initial
message or chat with an active idle agent unless the session is already in the
narrow Reply state or belongs to a Mission/story flow.

Plan:

- Add Start with message beside Start agent, with a bounded multiline initial
  prompt passed through the existing argv-safe launch path.
- Add Message agent for an exact active/idle binding using the PTY attach path;
  never select a session by name or CWD.
- Present a simple transcript/composer view per agent with explicit connection,
  sending, acknowledged, failed, and resumable states.
- Keep Reply restrictions for provider states where unsolicited input would be
  unsafe. Define and test which `working`/idle states accept a new message.
- Allow Start new conversation without requiring a Mission, while clearly
  preserving the previous provider conversation.

Acceptance:

- A user can select Reviewer, start it with "Review this repository", read the
  response, send a follow-up, close the app, and resume the same exact session.
- No story or Mission artifact is created for an ordinary direct conversation.
- Explicitly stopped sessions are never silently restarted.

### 2.2 Install or supply agent definitions per repository

Definitions currently come from `<repo>/.claude/agents`, ancestor directories,
or `%USERPROFILE%\.claude\agents`. The guarded specialist definitions in this
repository are project-specific and should not simply be copied to user scope
without their guards and conventions.

Plan:

- Add an Install Agent Pack action for a trusted repository with a complete
  preview and explicit approval.
- Install selected definitions, required PowerShell guard scripts, and an
  idempotent merge into project `.claude/settings.json`.
- Add a versioned manifest, conflict handling, update preview, and safe
  uninstall/restore path. Never overwrite user files silently.
- Create a real app-supplied scope for generic/internal Council definitions so
  Council Review remains available across repositories. Ensure Claude itself
  can resolve those definitions when launched in the selected repository.
- Keep project overrides explicit and show each definition's effective scope
  and shadowing chain.

Acceptance:

- A new disposable repository can install the pack, launch each chosen agent,
  pass the guard self-test, update idempotently, and uninstall without losing
  pre-existing settings.
- Switching repositories never moves or rebinds an existing session.
- A same-named project definition cannot silently replace an app-internal
  Council definition.

## Phase 3 — multi-repository offices and Codex

### 3.1 Add saved Offices before concurrent windows

The configuration already stores multiple trusted workspaces, but the UI only
offers a folder picker and one active runtime. Removing the single-instance lock
would create cross-workspace watcher, binding, provider, and IPC risks.

Plan:

1. Add an Office/workspace switcher listing saved repositories, recent status,
   active agents, attention count, and last-opened time.
2. Switch by saved workspace ID without reopening the folder picker; retain an
   Add repository action for new workspaces.
3. Restore per-workspace selected agent, Office page, Mission view, and filters.
4. Keep only one active runtime initially and show when inactive offices still
   have provider sessions running.
5. After isolation tests pass, introduce a workspace runtime registry and then
   consider multiple concurrent windows. Each window must carry an exact
   workspace ID on every IPC request.

Acceptance:

- Switching among at least three saved repositories is one click and does not
  rediscover them through a folder dialog.
- Catalogs, bindings, Missions, worktrees, attention, and UI preferences remain
  isolated by workspace ID.
- Concurrent-window work is blocked until IPC and runtime isolation tests prove
  no cross-repository action is possible.

### 3.2 Repair packaged Codex App Server discovery

Evidence: Codex exists at:

```text
C:\Users\User\.vscode\extensions\openai.chatgpt-26.810.52044-win32-x64\bin\windows-x86_64\codex.exe
```

The packaged locator checks PATH, selected ChatGPT locations, `.local`, npm
packages, and its resources directory, but does not scan the VS Code extension
layout. A packaged process may also inherit a different PATH from the terminal.

Plan:

- Add bounded Windows discovery for installed OpenAI VS Code extension versions
  and the matching x64/ARM64 binary.
- Add a user-approved executable picker/override stored in app configuration.
- Show every attempted discovery class and the selected executable in expanded
  Diagnostics, without dumping the full environment.
- Probe `codex --version`, start App Server, initialize, report auth/protocol
  state, and close cleanly before declaring Mission readiness.
- Re-probe after changing the override without restarting the application.

Acceptance:

- The installed app finds the current VS Code-bundled Codex executable on this
  machine and reports its version and authenticated App Server state.
- Invalid/stale overrides fall back safely and remain actionable.
- Discovery tests cover PATH differences, multiple extension versions, x64,
  ARM64, missing binaries, timeouts, and spaces in paths.

## Phase 4 — release verification

Run this matrix after Phases 0–3 are green:

- Full unit/integration suite and TypeScript build.
- Installed-app test of direct chat, logs, Council completion, and a minimal
  Claude-only Mission in a disposable repository.
- Codex Mission start, follow-up turn, approval request, and exact-thread resume.
- Restart recovery with active, blocked, completed, failed, and explicitly
  stopped sessions.
- Three-repository Office switching and, only if implemented, concurrent-window
  isolation.
- Guard-pack install/update/uninstall and live Builder/Test Engineer/PRD Lead
  enforcement.
- Layout at 100%, 125%, 150%, and 200% display scaling.
- Keyboard-only and screen-reader pass for Attention, Diagnostics, output, and
  chat controls.
- ARM64 package test on ARM64 Windows hardware.
- Signed-installer verification when signing credentials are available.

## External evidence still outstanding

- Capture the exact recovery text from a naturally wedged supervisor and then
  tighten the defensive PID extraction. Do not corrupt user state to force it.
- Verify cross-session `SendMessage` behavior on Windows with two independent
  sessions.
- Capture fresh experimental team/task file shapes if those parsers remain part
  of the supported product surface.
