# Codex implementation brief: Council agent supervisor and pixel office

**Status:** Active implementation brief  
**Target runtime:** 64-bit Windows 10/11  
**Development host:** macOS is supported for unpackaged development and UI work  
**Desktop framework decision:** Keep Electron

## 1. Objective

Build Decagram Council into a private desktop control room that:

1. discovers AI agent definitions visible from the selected project;
2. lets the user explicitly launch and manage those agents;
3. preserves long-running Claude Code sessions across app restarts;
4. exposes truthful status, logs, attention states, and interaction controls; and
5. presents those capabilities as an original top-down pixel-art office.

The pixel office is a control surface, not a game simulation and not the agent
runtime. The privileged process layer remains authoritative. Visual state must
always be derived from supervisor snapshots.

## 2. Decisions Codex must preserve

- Keep Electron. Do not migrate to Tauri, WPF, WinUI, or another shell unless a
  measured startup, memory, or package-size problem is supplied.
- Keep the renderer sandboxed with context isolation enabled and Node integration
  disabled.
- The renderer must never receive a raw executable path or a generic shell API.
- Every CLI launch must use an argument array with `shell: false`.
- Agent output, prompts, project files, and hook payloads are untrusted content.
  Render text with `textContent`, never injected HTML.
- New definitions may appear in the catalog automatically, but must never start
  automatically.
- Writes to Claude settings or project hook configuration require an explicit
  preview-and-approve flow.
- Do not claim Windows support from macOS tests. Record real Windows evidence in
  `docs/windows-verification.md`.
- Preserve existing sessions on app exit. Stopping the UI must not implicitly
  terminate Claude-owned work.

## 3. Architecture

```text
Sandboxed renderer
        |
        | typed, allowlisted IPC
        v
AgentSupervisorPort
  - validates agent/profile/session IDs
  - exposes runtime capabilities
  - routes lifecycle actions
  - publishes authoritative snapshots
        |
        v
ClaudeCodeAgentSupervisor
        |
        +--> DecagramCouncilRuntime
        +--> ClaudeClient
        +--> ClaudePaths / state watchers / hooks
        +--> node-pty reply transport
        |
        v
claude / claude.exe and Claude-owned state
```

`src/ui/main.ts` must depend on `AgentSupervisorPort`, not directly orchestrate
Claude CLI calls. Future local Python, Node, SDK, or model runtimes should be
introduced as additional supervisor/adapter implementations rather than by
adding provider conditionals to the renderer.

## 4. Work completed in the current architecture slice

- Added `src/supervisor/contracts.ts` and a first
  `ClaudeCodeAgentSupervisor`.
- Moved start, stop, wake, logs, reply, and Council Review routing behind the
  supervisor boundary.
- Added explicit runtime capabilities to `UiState`.
- Removed fictional first-run agents named Arden, Bram, Rook, Tess, and Sage.
- Agent definitions visible under project or user `.claude/agents` are merged
  into the in-memory roster as explicit, on-demand launch profiles.
- Preserved saved roster entries as user overrides.
- Prevented one unnamed cwd-matched session from occupying multiple agent cards.
- Changed Wake to respawn only failed configured sessions rather than every
  Claude background job.
- Added reply length and control-character validation.
- Fixed source/compiled resolution of bundled PowerShell guard scripts.
- Allowed unpackaged development launch on macOS. Packaged builds remain
  Windows-only.

Do not undo these changes while implementing later phases.

## 5. Next phase: trustworthy catalog and session ownership

This is the next implementation phase. Complete it before building the final
pixel-art renderer.

### 5.1 Resolved agent catalog

Create a catalog distinct from editable roster preferences.

Each entry needs:

- an opaque stable ID;
- exact frontmatter agent name;
- display label and description;
- project root and launch cwd;
- definition path and scope (`project`, `ancestor`, or `user`);
- model, tools, permission mode, and other useful capability metadata;
- definition fingerprint;
- launchability state;
- shadowed definitions; and
- visible diagnostics for malformed or ambiguous definitions.

Resolution rules:

1. The nearest project definition wins over ancestor and user definitions.
2. Multiple same-name files at the same precedence are ambiguous and cannot
   launch.
3. Lower-precedence files are shown as shadowed, not treated as ambiguity.
4. Sort enumeration deterministically, but never use sorting to choose between
   ambiguous same-precedence definitions.
5. Rediscover the selected entry immediately before launch.
6. Adding, changing, or removing a definition refreshes the catalog but never
   starts or stops a session.
7. Do not classify internal agents from a filename prefix. Use an explicit
   preference such as `mode: "internal"` or `hidden: true`.

### 5.2 Configuration v2

Treat the catalog as inventory and the app configuration as preferences.

Support version 1 without rewriting it merely because the app opened. A future
version 2 should store:

- selected workspace roots;
- whether user-scope definitions are included;
- profile ID, label, order, visibility, and launch mode;
- boot prompt, model, and effort overrides;
- `autoStart`, defaulting to `false`; and
- poll interval.

Malformed external edits must not be overwritten. Keep the last-known-good
runtime configuration and show the parse error.

### 5.3 Persistent session bindings

Stop using display label or cwd as session identity.

Create an app-owned `session-bindings.json` mapping a profile ID to:

- short and full session IDs;
- an app-generated unique launch name;
- agent name;
- canonical cwd; and
- creation timestamp.

Rules:

- one session belongs to at most one profile;
- exact persisted ID wins over all inference;
- unique launch name plus cwd is recovery evidence only;
- never automatically bind by cwd alone;
- a failed profile respawns only its own session;
- stopped/done profiles offer **Resume** and **Start new**;
- an unassigned session may be adopted only through an explicit user action;
- removing a profile must not delete its Claude conversation; and
- clearing a stale binding must not delete a Claude job.

### 5.4 Safe launch transaction

For every Start action:

1. Resolve an opaque profile/catalog ID in the main process.
2. Acquire a per-profile launch lock.
3. Verify cwd exists and is a directory.
4. Rediscover and validate the definition.
5. Block missing, ambiguous, or changed-untrusted definitions.
6. Launch through argv-array execution with `shell: false`.
7. Use an app-owned unique launch name.
8. If Claude substitutes its default agent, stop that new session and report
   failure.
9. Persist the session binding before reporting success.
10. On timeout or malformed acknowledgement, reconcile by unique launch name
    before permitting a retry.

Route Council Review through this same validated launch path.

## 6. Following phase: interaction

After catalog identity and bindings are reliable:

- stream recent output instead of requiring manual refresh;
- expose Resume, Start new, Stop, Remove, and Adopt with confirmations matching
  their consequences;
- add a real interactive terminal drawer with attach/write/resize/detach IPC;
- use a maintained terminal renderer such as xterm.js;
- retain the simple reply action for one-line messages;
- validate message size and control characters at the privileged boundary;
- render unassigned sessions;
- keep Council Review visible after it starts; and
- capture a structured Council result or clearly label unstructured log output.

Do not invent Council pipeline stages from prompts. Only display stages backed by
runtime/team/task evidence.

## 7. Pixel-art UI phase

The reference composition has three useful zones:

- **Left wood-floor office:** persistent/discovered agent stations.
- **Lower-right meeting room:** Council Review.
- **Upper-right utility room:** Diagnostics and runtime health.

The reference contains four desks, but the app must support a dynamic number of
agents. The production design must therefore use data-driven stations, a
scrollable/larger office, pages/rooms, or another explicit overflow treatment.
Do not hard-code five station IDs into the new architecture.

### 7.1 Rendering approach

Start with a hybrid DOM/CSS scene:

- fixed logical-resolution artboard;
- layered room PNGs or a Tiled map;
- nearest-neighbor integer scaling and letterboxing;
- accessible DOM buttons positioned over station/room hotspots;
- agent sprites using CSS `steps()` animations;
- a pixel-framed DOM drawer for logs, forms, and session detail;
- normal readable fonts for long output and diagnostics; and
- reduced-motion states.

Do not introduce a game engine for the first pixel UI. Add PixiJS/canvas only if
free movement, pathfinding, or many animated entities become a demonstrated
requirement.

### 7.2 Authoritative visual mapping

Create a pure `Snapshot -> SceneViewModel` mapper and test it.

| Runtime state | Pixel-office state |
|---|---|
| Missing session | Empty/idle station with Start action |
| Missing or ambiguous definition | Disabled station with visible error |
| Working | Agent typing; monitor active |
| Blocked / waiting for input | Amber attention marker |
| Done | Completion pose; Resume/Start-new choices |
| Failed | Error pose and targeted Wake action |
| Stopped | Dormant station with Resume |
| Cold | Dim workstation/sleep state |
| Pinned | Pin marker |
| Stale roster | Preserve last scene and overlay stale status |
| CLI unavailable | Keep catalog visible; disable runtime actions |

Station clicks select the same supervisor profile/session used by the standard
UI. Sprite animation is decoration and must never optimistically change domain
state.

## 8. Claude Design handoff required

A screenshot is enough to establish direction, but not enough to implement the
final scene faithfully. Request the following from Claude Design:

1. **Shareable source:** public/project share link, exported project ZIP, or the
   generated HTML/CSS/React code.
2. **Original art source:** preferably `.aseprite` and Tiled `.tmj`; layered PSD
   or Figma is an acceptable secondary source.
3. **Provenance and licenses:** confirmation that every character, prop, tile,
   font, and sound is original or licensed for this app. Do not extract or trace
   assets from the reference screenshot.
4. **Scene specification:** native logical resolution, tile size, palette,
   intended integer scale, minimum-window crop/letterbox rules, and safe areas.
5. **Layered map:** `floor`, `walls_back`, `props_back`, `furniture`,
   `foreground_occluders`, and `lighting`, all sharing one origin.
6. **Object layers:** station/room hotspots, collision, waypoints, spawn points,
   feet anchors, and z-order.
7. **Sprite metadata:** atlas JSON with frame rectangles, durations, loop mode,
   pivots, and source size. Useful tags include directional `idle`/`walk`,
   `sit_type`, `blocked`, `done`, `failed`, `cold_sleep`, and `selected`.
8. **Semantic prop states:** workstation off/idle/working/blocked/error; Council
   table idle/convening/working/blocked/complete/error; diagnostic equipment
   connected/stale/unavailable.
9. **Pixel UI kit:** panel, drawer, modal, toast, tooltip, buttons, tabs, inputs,
   scrollbar, badges, focus marker, and 9-slice margins.
10. **Fonts and tokens:** font files, redistribution license, sizes, line heights,
    fallbacks, semantic colors, and contrast guidance.
11. **Reference states:** all idle, several working, multiple blocked, failed
    after restart, stale/disconnected, and Council running.

Ask for a clean uncropped render without the surrounding black screenshot border
or clipped page text. Export native 1x pixels with no antialiasing or resampling.

## 9. macOS development instructions

From the repository:

```bash
npm install
npm run typecheck
npm test
npm start
```

Unpackaged `npm start` may run on macOS for UI and integration development.
Diagnostics must continue to show that macOS is not the supported production
platform. Set `DECAGRAM_COUNCIL_ALLOW_NON_WINDOWS_DEV=0` to exercise the strict
Windows-only launch gate.

Use `DECAGRAM_COUNCIL_PROJECT_DIR` to point discovery at another project.
On macOS the developer build may locate `claude`; the packaged Windows build
must locate `claude.exe`.

Never treat macOS PowerShell skips, filesystem behavior, PTY behavior, or
packaging results as Windows evidence.

## 10. Windows verification gate

Before calling the next phase complete on Windows:

- run typecheck, build, and every test with no unexpected skips;
- confirm project and user agent discovery;
- launch each intended top-level agent;
- verify missing/ambiguous definitions cannot launch;
- verify exact session binding across restart;
- exercise start, logs, reply, stop, resume, start-new, and targeted wake;
- test hook installation through the preview/approve UI;
- test watcher updates after adding/editing/removing a definition;
- test `node-pty` present and absent;
- test 100%, 125%, 150%, and 200% display scaling;
- launch the packaged app, not only `npm start`;
- install/uninstall the NSIS package; and
- replace the placeholder app ID before producing a release artifact.

Record Windows version, architecture, Claude version, PowerShell version, test
date, and captured CLI shapes in `docs/windows-verification.md`.

## 11. Definition of done for the next phase

The next phase is complete when:

- every effective agent definition appears without hard-coded names;
- same-precedence conflicts are visible and nonlaunchable;
- definitions update without restarting the app;
- starts are resolved from opaque main-process IDs;
- one profile cannot accidentally own another profile's session;
- session bindings survive app restart;
- Wake targets only selected/configured failed sessions;
- configured preferences and missing definitions remain recoverable;
- the current card UI still works through the supervisor;
- tests cover catalog precedence, launch locks, bindings, lifecycle, and IPC
  validation; and
- the real Windows verification ledger is updated.

## 12. Prompt to give Codex

> Read `docs/codex-next-phase-brief.md` completely. Continue from the existing
> supervisor and dynamic-discovery slice; do not replace Electron or rewrite the
> integration layer. Implement Section 5 in small tested commits while preserving
> the current IPC channel strings and card UI. Stop before the final pixel-art
> renderer unless the original Claude Design source and licensed asset package
> described in Section 8 are present. Run typecheck, build, and tests after each
> slice, and report macOS evidence separately from required Windows verification.
