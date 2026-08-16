# Verification

> Historical record: this report covers the 2026-08-15 migration pass. Current
> completion evidence and remaining external blockers are recorded in
> `WHAT-WAS-DONE.md` and `WHAT-NEEDS-TO-BE-DONE.md`. The former Windows parity
> ledger was removed after the Windows-only closure work on 2026-08-16.

Audit of this repository's assumptions about the Claude Code CLI surface against
the installed reality on the current Windows host.

Audit date: 2026-08-15

---

## 1. Ground truth

All six commands were run. `claude` is not on `PATH` in this environment:

```
claude : The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program.
```

The binary exists at `C:\Users\User\.local\bin\claude.exe` (228,902,560 bytes,
dated May 17 21:09). All `claude` invocations below used that absolute path.

### `claude --version`

```
2.1.143 (Claude Code)
```

### `claude doctor`

Produced no output at all. It is an interactive TUI with no non-interactive mode
(`claude doctor --help` lists only `-h, --help`). Under PowerShell it did not
return within 180s and was moved to the background. Re-run under bash with stdin
from `/dev/null` and a 45s timeout it emitted zero bytes and exited only on the
timeout:

```
=== exit: 124 ===
```

### `claude daemon status`

Exit code 1:

```
not running

bg sessions:
  sock dir:     \\.\pipe\cc-daemon-*
  control.sock: unreachable (connect ENOENT \\.\pipe\cc-daemon-00ecaa24a3b121ef-control)
  bg workers:   0 in roster.json (control unreachable)
  roster.json:  absent
  daemon.log:   absent
```

### `claude agents --json`

Exit code 1:

```
error: unknown option '--json'
```

### `git --version`

```
git version 2.54.0.windows.1
```

### `node --version`

```
v24.15.0
```

### Findings

**Claude Code version.** `2.1.143`.

**Supervisor.** Not reachable, and not merely idle — it is not running. No PID,
no version, no uptime are obtainable. Socket directory is the named-pipe
namespace `\\.\pipe\cc-daemon-*`; the specific control endpoint
`\\.\pipe\cc-daemon-00ecaa24a3b121ef-control` returns `ENOENT`. Live worker count
is 0. `roster.json` and `daemon.log` are both absent; the only item under
`~/.claude/daemon\` is a 16-byte `pipe.key`. Enumerating the named-pipe namespace
for `*cc-daemon*` returns nothing, independently confirming no supervisor pipe
exists.

`claude daemon --help` states: "Service install is disabled in this version — the
daemon runs on demand and exits when the last client disconnects." On this build
the supervisor is a transient, on-demand process, so "not running" is the
expected steady state rather than a fault. The `stop` subcommand documents
`--any` and `--keep-workers`.

**Supervisor vs CLI version match.** Cannot be determined. A stopped supervisor
emits no version string, so there is nothing to compare against `2.1.143`. This
is neither a match nor a mismatch — it is unmeasurable until a daemon is started,
which is a side effect and was out of scope for this audit.

**Git for Windows.** Present. Registry `HKLM:\SOFTWARE\GitForWindows` reports
`InstallPath: C:\Program Files\Git`, `CurrentVersion: 2.54.0`. `bash.exe` exists
at both:

- `C:\Program Files\Git\bin\bash.exe`
- `C:\Program Files\Git\usr\bin\bash.exe`

`git.exe` resolves on PATH to `C:\Program Files\Git\cmd\git.exe`. `bash.exe`
itself is not on `PATH` — only the `Git\cmd` directory is on PATH, not `Git\bin`.
The Bash tool nevertheless resolves the interpreter itself and reports:

```
GNU bash, version 5.3.9(1)-release (x86_64-pc-cygwin)
```

The Bash tool prerequisite for Builder's preflight duty is satisfied; Claude Code
does not fall back to the PowerShell tool.

**The JSON shape from `claude agents --json`.** Cannot be reported. The flag does
not exist on this version. The error text is recorded above rather than the shape
being inferred from the repository's code.

On 2.1.143, `claude agents` is an interactive background-agent view, not a query
command. Its full option list is:

```
--add-dir, --allow-dangerously-skip-permissions, --cwd, --dangerously-skip-permissions,
--effort, -h/--help, --mcp-config, --model, --permission-mode, --plugin-dir,
--setting-sources, --settings, --strict-mcp-config
```

Every one is a configuration option for sessions dispatched from the agent view.
There is no `--json`, no `--format`, and no other machine-readable output flag.
No supported non-interactive way to read the roster was found on this build.

Two further observations recorded during V1: the top-level `claude --help`
documents `--tmux` as "Uses iTerm2 native panes when available", and no top-level
`ListAgents`/`SendMessage` surface is visible at the CLI level.

---

## 2. Drift table

Context for every row below: `docs/cli-surface.md:9` records that the entire
verified CLI surface was probed **2026-07-25 against Claude Code 2.1.220 on macOS
(darwin-x64)**. The installed reality is **2.1.143 on Windows**. The code targets
a CLI newer than the one installed, captured on a different operating system.
Every fixture in `test/fixtures/roster-mixed.json` carries macOS paths.

`~/.claude` on this machine has no `jobs/`, no `teams/`, and no `tasks/`
directory, and no supervisor has ever run here. Every file-shape assumption is
therefore unverifiable without dispatching a session.

| File | Assumption made | Verified against | Verdict |
|---|---|---|---|
| **1. Roster source** ||||
| `src/integration/client.ts:164` | `claude agents --json` is the roster interface | `claude agents --json` → `error: unknown option '--json'`; `claude agents --help` lists 13 options, none for output | `DRIFTED` |
| `src/integration/client.ts:165` | `--all` includes completed sessions | Not in `claude agents --help` on 2.1.143 | `DRIFTED` |
| `src/integration/paths.ts:96` | `daemon/roster.json` path is needed | `daemonRosterFile()` is defined but called nowhere in `src/` — no direct roster parsing exists | `CONFIRMED` |
| `src/integration/fs/jobs.ts:71`, `:93` | `jobs/<id>/state.json` is parsed directly as an internal file | Code read confirms direct parsing (flagged); documented as deliberate at `fs/jobs.ts:1-11` | `CONFIRMED` (flagged) |
| `src/integration/fs/jobs.ts:93` | `state.json` field shape (`detail`, `intent`, `daemonShort`) | No `jobs/` directory exists on this machine | `UNVERIFIABLE` |
| **2. The `pid` field** ||||
| `src/integration/parse/roster.ts:46-67` | `pid` is not a reliable liveness signal; `state` is the real signal | Binary's supervisor `adopt()` verifies liveness via `process.kill(pid,0)` plus a `procStart` match — `pid` is a live-process attribute, consistent with the code's caution | `CONFIRMED` |
| `src/ui/renderer/scene-view-model.js:45-50` | A session can only be replied to when `state==='blocked' && waitingFor==='input needed'` | `claude attach --help`: "Open the background session… the session keeps running"; `claude stop --help`: "conversation is kept; resume it later with `claude attach <id>`" — an exited session is attachable and repliable | `DRIFTED` |
| `src/integration/roster/unified.ts:126-130` | `done`/`stopped` ⇒ `terminal`, offering only Resume/Start-new | As above — terminal state does not mean the session is unreachable | `DRIFTED` |
| **3. The `state` field** ||||
| `src/integration/types.ts:20-28` | Exactly five states: `working, blocked, done, failed, stopped` | Binary emits at least `starting`, `resuming`, `adopted`, `crashed`, `running` in the same session record | `DRIFTED` |
| `src/integration/parse/roster.ts:22-26` | Unrecognised states are safely dropped to `undefined` | Consequence traced: `undefined` state → `unified.ts:126-130` yields `bindingState: 'active'`, so a `crashed` session renders as active | `DRIFTED` |
| `src/integration/types.ts:83` | `tempo` is `'idle' \| 'active'` | Binary validator accepts `"active"`, `"idle"`, `"blocked"` | `DRIFTED` |
| — | `needs` field | Binary's session record carries `needs`; no repository file reads it | `DRIFTED` (unread field) |
| **4. The `waitingFor` field** ||||
| `src/integration/types.ts:35-50` | Five values: `permission prompt, input needed, sandbox request, worker request, dialog open` | Binary, verbatim: `?"permission prompt":e?"worker request":HH?"sandbox request":B7?"dialog open":"input needed"` — exact match, exact set | `CONFIRMED` |
| `src/integration/types.ts:42` | Unknown values pass through as text rather than being dropped | Code read; forward-compatible by design | `CONFIRMED` |
| `src/integration/parse/roster.ts:82`, `roster/unified.ts:179`, `runtime.ts:309` | Field is read; any non-undefined value routes to the attention channel | Code read | `CONFIRMED` |
| `src/ui/renderer/scene-view-model.js:50` | Only `'input needed'` enables reply; the other four are display-only | Code read — `permission prompt`/`dialog open` deferred to the attach drawer | `CONFIRMED` |
| **5. Teammate and team state** ||||
| `src/integration/paths.ts:105`, `fs/teams.ts:146` | Teams are named `session-` + first 8 chars of session id | Regex `/^session-([0-9a-f]{8})$/i` already implements this layout | `CONFIRMED` |
| `src/integration/fs/teams.ts:8` | Feature gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | String present in binary's env-var table (7 occurrences, including `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) | `CONFIRMED` |
| `src/integration/fs/teams.ts:1-19` | Teams are ephemeral, read-only, one per session; the squad is not a team | Code read; matches the stated model | `CONFIRMED` |
| — | `TeamCreate` / `TeamDelete` no longer exist | Both strings present in the installed 2.1.143 binary (8 and 9 occurrences). No repository file references either, so no dependency is carried | `CONFIRMED` (no repository dependency); premise not true of 2.1.143 |
| `src/integration/fs/teams.ts:120` | `config.json` and task-file field shapes | No `teams/` or `tasks/` directory on this machine | `UNVERIFIABLE` |
| **6. `daemonStop`** ||||
| `src/integration/client.ts:330-335` | Recovery is `claude daemon stop --any --keep-workers` | `claude daemon --help`: `stop … --any also stop a transient (non-service) daemon … --keep-workers leave detached sessions running` — exact match | `CONFIRMED` |
| `src/integration/client.ts:329` | Transient is the only daemon kind this version produces | `claude daemon --help`: "Service install is disabled in this version" | `CONFIRMED` |
| — | Windows case: supervisor unresponsive, command prints a PID for `taskkill` | `taskkill` appears nowhere in the repository; no branch parses a PID from stop output | `DRIFTED` (handling absent) |
| — | Exact text of that Windows fallback message | Would require wedging a live supervisor and calling stop against it | `UNVERIFIABLE` |
| — | `daemonStop()` is reachable | Defined at `client.ts:330`; no caller anywhere in `src/` — the recovery path is unreachable | `DRIFTED` |
| **7. Cross-session messaging** ||||
| — | Any code path assuming independent sessions message each other | Repository-wide grep: `SendMessage` appears only in subagent frontmatter tool allowlists (e.g. `.claude/agents/builder.md:12`); `ListAgents` appears nowhere | `CONFIRMED` (no such dependency) |
| — | `ListAgents` / `SendMessage` exist in the installed version | Binary contains both; `ListPeers:"ListAgents"` is an internal rename map. `SendMessage` was live in the audit session on Windows; `ListAgents` was not exposed | `CONFIRMED` (both present) |
| — | The capability is macOS and Linux only | No platform-gating string found for messaging; the binary does carry `Error: --tmux is not supported on Windows`, so such gates are stated explicitly when they exist. Settling this needs two concurrent sessions attempting a message | `UNVERIFIABLE` |
| **Cross-cutting** ||||
| `src/integration/cli/locate.ts:22` | `MINIMUM_CLAUDE_VERSION = '2.1.220'` | Installed is `2.1.143` → `compareVersions` < 0 → `meetsMinimum: false` | `DRIFTED` |
| `src/ui/main.ts:966`, `src/ui/renderer/renderer.js:184` | Runtime starts only when `meetsMinimum` | Consequence: on this machine the app does not start the runtime | `DRIFTED` |
| `src/integration/parse/daemon.ts:45-82` | Prose parser handles the not-running shape | Hand-traced against the real Windows output in section 1: `recognized:true`, `running:false`, `socketDir:"\\\\.\\pipe\\cc-daemon-*"`, `workerCount:0`, `rosterPresent:false`. The `^`-anchored `roster.json` field correctly ignores the substring inside the `bg workers` line | `CONFIRMED` |
| `src/integration/parse/daemon.ts:8-20` | Running-daemon shape (pid/version/uptime/origin) | No supervisor running; would require starting one | `UNVERIFIABLE` |
| `src/integration/pty/attach.ts:9` | No `claude reply` exists; subcommands are attach/logs/stop/kill/respawn/rm/daemon | Probed all: `attach`, `logs`, `stop`, `kill`, `respawn`, `rm`, `daemon` each return their own help; `reply` falls through to root help | `CONFIRMED` |
| `src/integration/client.ts:78`, `:224` | `--bg` and `--exec` dispatch flags exist | Binary: `vxA=["--bg","--background"]` and a fast-path branch on `logs/attach/stop/kill/respawn/rm/--bg` | `CONFIRMED` |
| `src/integration/client.ts:262-265` | Error strings `No job matching` / `Couldn't read logs for <id>` | Would require a live or bogus-id call that may spawn the supervisor | `UNVERIFIABLE` |
| `src/integration/parse/roster.ts:134` | Dispatch prints `backgrounded · <id> · <name>` | String `backgrounded` present in binary (38 occurrences); exact layout needs a real dispatch | `UNVERIFIABLE` |
| `src/integration/preflight.ts:121` | `supportedPlatform = process.platform === 'win32'` | Matches the installed platform | `CONFIRMED` |

### Evidence for the `state` finding

From the installed binary's session-lifecycle code:

```js
if($.state!=="starting"&&$.state!=="resuming"&&$.state!=="adopted"&&$.state!=="crashed")return;
...await B5(H,{...$,state:"running",tempo:"idle",updatedAt:new Date().toISOString()})
```

and from the attach path:

```js
let e=X.record.state,HH=e==="starting"||e==="resuming"||e==="adopted"||e==="crashed"
  ?"Session is starting — it will appear once ready. Ctrl+Z to detach":"Waiting for session to redraw…"
```

The same record carries the field set `{sock, cwd, startedAt, procStart, name,
kind, sessionId, jobId, bridgeSessionId, logPath, status, waitingFor, updatedAt,
entrypoint, agent, state, detail, tempo, needs}`, where `src/integration/types.ts:58-69`
expects `id` and `startedAt`. This reader parses `<config>/sessions/<n>.json`,
which is the messaging registry, not the job state file; it is recorded as a
shape difference, not asserted to be the `agents --json` payload.

---

## 3. Platform inventory

No `.sh` files, no shebang lines, no Keychain references, no `tmux` and no
`iTerm` references exist in any tracked file.

### Platform branching in source

| File | Construct | Classification |
|---|---|---|
| `src/ui/main.ts:1704` | `process.platform !== 'win32'` → Windows-only error dialog and quit | `KEEP` |
| `src/ui/main.ts:1700-1701` | `DECAGRAM_COUNCIL_ALLOW_NON_WINDOWS_DEV !== '0'` — non-Windows dev escape hatch, on by default in unpackaged builds | `REPLACE` |
| `src/ui/main.ts:146`, `:156` | Win32 case-folding for canonical path comparison | `KEEP` |
| `src/supervisor/catalog.ts:295` | Same case-folding for agent-dir identity | `KEEP` |
| `src/ui/main.ts:772`, `src/git/client.ts:142` | `git.exe` vs `git` | `KEEP` |
| `src/integration/cli/locate.ts:24` | `claude.exe` vs `claude` | `KEEP` |
| `src/integration/preflight.ts:120-121` | `supportedPlatform = platform === 'win32'` | `KEEP` |
| `src/config/appConfig.ts:432`, `src/missions/gateRunner.ts:603`, `src/missions/gitAdapter.ts:146`, `src/missions/worktreeAdapter.ts:83`, `src/supervisor/launchCoordinator.ts:208`, `src/orchestration/worktrees/leaseManager.ts:110`, `src/orchestration/worktrees/leaseStore.ts:736`, `:875` | `options.platform ?? process.platform` — injectable platform for tests | `KEEP` |
| `src/providers/codex/locate.ts:109-111` | `darwin` → `@openai/codex-darwin-arm64/x64`; `linux` → linux packages | `DELETE` (tests inject `platform`, so removal touches them) |
| `src/providers/codex/locate.ts:120`, `:191` | `codex.exe` vs `codex`, plus a `darwin` branch | `DELETE` (darwin branch) / `KEEP` (exe naming) |
| `src/ui/renderer/index.html:327` | UI text: "macOS development · Windows production" | `DELETE` |

### macOS-era evidence: docs

| File | Construct | Classification |
|---|---|---|
| `docs/cli-surface.md:9` | "2026-07-25 against Claude Code 2.1.220 (macOS, darwin-x64)" — the source-of-truth probe | `REPLACE` |
| `docs/cli-surface.md:3` | Already self-labelled "Archived platform evidence" | `KEEP` as archive |
| `docs/cli-surface.md:24` | `~/.vscode/extensions/anthropic.claude-code-2.1.220-darwin-x64/...` | `REPLACE` |
| `docs/cli-surface.md:89`, `:122`, `:161`, `:182-199`, `:217` | POSIX paths: `/Users/cisco/...`, `/private/tmp/scratch`, `/tmp/cc-daemon-501/...`, `control.sock` | `REPLACE` |
| `docs/cli-surface.md:71` | `uninstall  Remove the background service (launchctl/systemd)` | `KEEP` — verbatim CLI help, still printed on Windows |
| `docs/windows-parser-audit.md:5-15` | States fixtures are macOS-shaped and the product is now Windows-only | `KEEP` |
| `docs/codex-milestone-02-completion-report.md:5`, `:32`, `:222-223` | "Development host: macOS (Darwin 25.5.0)… no PowerShell interpreter"; explicitly says it is not Windows evidence | `KEEP` |
| `docs/upstream/frontmatter-hooks.md:8` | `Platform: macOS, darwin-x64` | `KEEP` as archive / `REPLACE` if re-probed |
| `README.md:183`, `:186`, `:203`, `:261` | "also run on macOS so the UI and supervisor integration can be developed on the", "Run these commands from PowerShell or a macOS terminal" | `REPLACE` |
| `README.md:22` | "live macOS handshake completed; Windows verification pending" | `REPLACE` |
| `README 2.md` (tracked in git) | Duplicate macOS-era README: `:3` "(macOS + Windows, Electron)", `:213` "Verified output on this machine (Claude Code 2.1.220, macOS)", `:239` `/Users/me/work/meridian` | `DELETE` |
| `claude-code-agent-pack/CHANGELOG.md:24` | "Removed `PowerShell` from Builder and Test Engineer; the host is macOS." — superseded per `:10` | `KEEP` |

### macOS-era evidence: fixtures and tests

| File | Construct | Classification |
|---|---|---|
| `test/fixtures/roster-mixed.json:4`, `:12`, `:20` | `/Users/cisco/Documents/GitHub/Council`, `/private/tmp/scratch` | `REPLACE` |
| `test/fixtures/job-state-exec-done.json:17` | `/private/tmp/scratch` | `REPLACE` |
| `test/fixtures/daemon-status-running.txt`, `daemon-status-stopped.txt` | POSIX `sock dir` / `control.sock` prose | `REPLACE` |
| `test/codexAppServerClient.test.ts:84`, `test/codexProviderAdapter.test.ts:43` | `platformOs: 'macos'` in the Codex handshake fixture | `REPLACE` |
| `test/codexAppServerClient.test.ts:82` | `codexHome: '/tmp/codex-home'` | `REPLACE` |
| ~20 sites in `test/` | `mkdtemp(path.join(tmpdir(), …))` | `KEEP` |
| `test/ipcHandlers.test.ts:452`, `:512`, `test/ipcValidation.test.ts:51`, `:175`, `:200`, `test/missionProviderRouter.test.ts:238-239` | POSIX literals (`/tmp/untrusted`, `/tmp/escape`) as containment-rejection inputs | `KEEP` (flagged) |
| `test/missionController.test.ts:113`, `:194`, `:386-412`, `:450`, `:574` | `/private/tmp/…` as secrets that must not leak into serialized state | `KEEP` |
| `test/appConfig.test.ts:211` | `symlink(…, win32 ? 'junction' : 'dir')` | `KEEP` |
| `test/ui.test.ts:36` | Asserts `main.ts` contains `"process.platform !== 'win32'"` | `KEEP` |

### Parity ledger

`docs/windows-verification.md` is the capability matrix: 23 rows, every one marked
`implemented-unverified`, last updated 2026-07-26. Its header states: "A passing
macOS typecheck or a PowerShell suite skipped because no interpreter exists is not
Windows verification."

Classification: `KEEP` the ledger, `REPLACE` its contents. Its "Current
non-Windows evidence" block (`:15-19`) records `npm test` at 43 files, 390
passed, 15 skipped, with the skips being "PowerShell execution suites; no
PowerShell interpreter is available on this host." This host has PowerShell 5.1
and Git for Windows 2.54.0. Two ledger rows exist solely because of that
limitation: Write guards (`:44`) and Shell construct guard (`:45`).

### Other

`scripts/gates/README.md:4` states "directory is PowerShell; there is no Bash
dialect or macOS registration path". The gate scripts are already Windows-native
(9 `.ps1` files). `KEEP`.

`package-lock.json` carries approximately 40 `darwin` and `linux` optional
dependency entries (esbuild, rolldown, lightningcss, `@electron/osx-sign`).
`KEEP` — npm platform metadata, not project code.

---

## 4. Blocking issues

1. **`claude agents --json` does not exist on the installed CLI.** `src/integration/client.ts:164-174`
   is the only roster read path, and it is routed through `runClaudeJson`. On
   2.1.143 the command exits 1 with `error: unknown option '--json'`, which
   `classifyOutput` will treat as a failure. The unified roster, the squad
   screen, boot, and every reconciliation poll depend on this call.

2. **The installed CLI is below the enforced minimum.** `MINIMUM_CLAUDE_VERSION`
   is `'2.1.220'` at `src/integration/cli/locate.ts:22`; installed is `2.1.143`.
   `locateClaude` therefore returns `meetsMinimum: false`, `src/ui/main.ts:966`
   does not start the runtime, and `src/ui/renderer/renderer.js:184` reports the
   runtime as unavailable. `verifyLaunchCapability()` additionally returns a
   `cli-error` before any launch.

3. **Session states emitted by the installed CLI are not in the handled set.**
   `starting`, `resuming`, `adopted`, `crashed` and `running` are dropped to
   `undefined` by `src/integration/parse/roster.ts:22-26`, and
   `src/integration/roster/unified.ts:126-130` maps `undefined` to
   `bindingState: 'active'`. A crashed session is presented as active.

4. **No Windows `taskkill` recovery path exists.** `taskkill` appears nowhere in
   the repository, and no code parses a PID from `daemon stop` output.

5. **`daemonStop()` has no caller.** Defined at `src/integration/client.ts:330`
   and unreferenced in `src/`, so the supervisor recovery action is not reachable
   from the application.

6. **Reply is gated on state in a way the CLI contract does not require.**
   `src/ui/renderer/scene-view-model.js:45-50` permits reply only for
   `state==='blocked' && waitingFor==='input needed'`, while `claude attach` and
   `claude stop` document that an exited session retains its conversation and is
   resumable by attaching.

7. **All roster, job, team and task file shapes are unverified on this host.**
   `~/.claude` contains no `jobs/`, `teams/`, or `tasks/` directory and no
   supervisor has run here.

8. **`README 2.md` is committed to the repository.** It is a duplicate,
   macOS-era README carrying contradictory platform claims.

---

## 5. Open questions for the human

Each item below was marked `UNVERIFIABLE` during the audit. The action required
to resolve it is stated; none were performed, because each has side effects.

1. **`jobs/<id>/state.json` field shape.** Requires dispatching one background
   session so a job directory exists.

2. **`teams/<team>/config.json` and task-file shapes.** Requires running a
   session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and forming a team.

3. **Windows `daemon stop` fallback text and the PID it prints for `taskkill`.**
   Requires a live supervisor that has stopped responding to its control pipe.

4. **Running-daemon `claude daemon status` output shape on Windows.** Requires
   starting a supervisor. Only the not-running shape was observable.

5. **`claude logs` error strings (`No job matching`, `Couldn't read logs for <id>`).**
   Requires a call against a real or bogus session id, which may spawn the
   supervisor.

6. **Dispatch output layout `backgrounded · <id> · <name>`.** Requires a real
   `--bg` dispatch.

7. **Whether cross-session messaging is macOS and Linux only.** `ListAgents` and
   `SendMessage` both exist in the installed binary and no platform gate was
   found for them. Requires two concurrent sessions attempting a message to
   settle.

8. **Whether the supervisor version matches the CLI version.** No supervisor is
   running, so no version is emitted for comparison.

---

## 6. Post-audit update — CLI upgraded to 2.1.233

Sections 1 to 5 are the audit as taken against 2.1.143 and are left unchanged.
This section records what happened next.

The installed CLI was upgraded with `claude install latest`, taking the host from
2.1.143 to **2.1.233**. Registry state at the time: `stable` 2.1.224, `latest`
2.1.233. The installer reported one setup note, which is still outstanding:

```
Native installation exists but C:\Users\User\.local\bin is not in your PATH.
```

`src/integration/cli/locate.ts` probes `~/.local/bin` as a well-known directory,
so discovery does not depend on that PATH entry being fixed.

### Re-probed on 2.1.233 (Windows)

- `claude agents --json` **exists and works**, exit 0. `--all` is documented as
  "With --json: also include completed background sessions". `--json` is
  documented as "does not require a TTY".
- Live output confirms the interactive row shape assumed by `types.ts`:
  `{pid, cwd, kind, startedAt, sessionId, name}` — no `id`, no `state`.
- Subcommand set unchanged: `attach`, `logs`, `stop`, `kill`, `respawn`, `rm`
  each print their own usage; `reply` still does not exist and falls through to
  root help.
- `claude daemon --help` unchanged, including `stop --any --keep-workers` and
  "Service install is disabled in this version".
- `claude daemon status` still reports not running, with the named-pipe form now
  generalised to `\\.\pipe\cc-daemon-*-control`.
- Session states still exceed the five originally modelled. 2.1.233 carries
  `["starting","resuming","adopted","crashed"]` as its own named array, plus
  `running`.
- `waitingFor` gained a sixth value, `goal proposal`, and can also forward an
  arbitrary `topDialogWaitingFor` verbatim.
- `TeamCreate`, `TeamDelete`, `ListAgents`, `SendMessage` and
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` are all still present.

### Blocking issues resolved

- **#1 (`agents --json` missing)** — resolved by the upgrade. No code change was
  needed; the command exists again.
- **#2 (below enforced minimum)** — resolved. `MINIMUM_CLAUDE_VERSION` is now
  `2.1.233` and the installed CLI matches, so `meetsMinimum` passes and the
  runtime starts.
- **#3 (unhandled states)** — resolved in code. `SessionState` now carries the
  five additional states, `deriveCold` treats the transitional ones as hosted
  rather than dormant, and the UI renders `crashed` as a failure instead of
  silently as healthy.

### Blocking issues still open

- **#6** reply remains gated on `blocked` + `input needed`. Unchanged
  deliberately: widening it is a product decision, not a version alignment.

---

## 7. Closure pass

Everything below was done after section 6, on 2.1.233.

### Live verification against a real supervisor

A `--bg --exec` shell job was dispatched, observed, stopped and removed. It spends
no model quota and exercises the same dispatch, roster, logs, stop and rm paths a
real session uses. Results:

- Dispatch printed `backgrounded · 6f0168c1 · <name>` and parsed correctly.
- `<config>/jobs/<id>/state.json` appeared with `state` and `detail`, and
  `daemonShort` matched the roster `id`.
- The short id is the first 8 characters of the session UUID, as assumed.
- A bogus id was classified `unknown-session` despite exit code 0.
- The round-trip left no sessions behind.

A second job was held open to capture the running supervisor:

- **Supervisor version 2.1.233 matches the CLI version 2.1.233.**
- A background session in state `working` reports **no `pid`**, confirming on
  Windows the reasoning `deriveCold` was built on.
- The Windows running-status output carries a trailing "holding this daemon
  open" block absent from the macOS transcript.

Both Windows daemon-status shapes are now fixtures
(`daemon-status-running-windows.txt`, `daemon-status-stopped-windows.txt`) and
are covered by parser tests.

### Blocking issues closed here

- **#4 / #5** `daemonStop()` now parses its outcome into `DaemonStopOutcome` and
  has a caller: `npm run harness daemon-stop`. Two outcomes were observed
  directly and are tested — `stopped` and `no daemon running`, both exit 0. The
  wedged-supervisor case still could not be produced on demand, so its pid
  extraction is defensive and its exact wording remains uncaptured.
- **#7** closed by the live round-trip above.
- **#8** `README 2.md` deleted. It was a stale duplicate committed once in
  `e95104a`, still describing a macOS/Windows product with a bash forwarder and
  an unbuilt UI.

### Open questions closed

- **1** job `state.json` shape — observed.
- **4** running-daemon status shape on Windows — captured as a fixture.
- **5** `claude logs` error classification — confirmed via the bogus-id check.
- **6** dispatch output layout — confirmed.
- **8** supervisor vs CLI version — they match at 2.1.233.

Questions 2 (team/task file shapes), 3 (wedged-supervisor stop text) and 7
(cross-session messaging platform support) remain open.

### Test suite

`npx tsc --noEmit` passes. `npm test` is **43 files, 407 tests, 0 failures** —
the first fully green suite on Windows. The eight pre-existing failures were
resolved as follows, and two were real product defects rather than test noise:

1. `test/board.test.ts` (2) — expectations compared against POSIX literals where
   `claudeConfigDir` correctly resolves to a drive-qualified path. Test-side.
2. `test/gitClient.test.ts` (2) — **product defect.** Git reports worktree paths
   with forward slashes (`C:/Users/...`) while Node produces `C:\Users\...`, so
   every path comparison failed and worktree reconciliation could not match a
   checkout it had just created. Normalised in `parseWorktreePorcelain`.
3. `test/gitClient.test.ts` (1) and `test/missionGitAdapter.test.ts` (1) — Git for
   Windows sets `core.autocrlf=true` system-wide, so fixture content round-tripped
   as CRLF. Fixture repos now pin `core.autocrlf=false`.
4. `test/shell-guards.test.ts` (1) — five real PowerShell processes cannot finish
   inside Vitest's 5s default. Timeout raised.
5. `test/gates.test.ts` (1) — **product defect, two compounding bugs.** The
   frontmatter reader used `Trim('"')`, which strips a quote belonging to the
   value: an acceptance of `node -e "process.exit(0)"` became
   `node -e "process.exit(0)`. Separately, the acceptance command was passed after
   `-Command`, which strips embedded quotes and does not propagate a native exit
   code, so `node -e "process.exit(3)"` reached the child as
   `node -e process.exit(3)`, was read as a subexpression, and exited 0. **The
   story gate could not fail a story.** Both fixed; the gate now runs acceptance
   through `-EncodedCommand` with an explicit exit.

Item 5 is the reason the ledger rows for the PowerShell guards mattered: those
suites had never executed on any host, and running them found a gate that always
passed.

### Test suite state on Windows

`npx tsc --noEmit` passes. `npm test` reports **8 failed / 399 passed**. The same
eight tests fail at `HEAD` without any of these changes (**8 failed / 397
passed**, measured by stashing), so all eight are pre-existing Windows breakages
rather than regressions. They fall into three groups:

1. `test/board.test.ts` (2) — POSIX expectations. Asserts `claudeConfigDir` yields
   `/custom/claude`; on Windows `path.resolve` correctly yields
   `C:\custom\claude`. Test-side, not product-side.
2. `test/gitClient.test.ts` (3) and `test/missionGitAdapter.test.ts` (1) — Windows
   Git behaviour, including CRLF (`'candidate\r\n'` where `'candidate\n'` is
   expected).
3. `test/gates.test.ts` (1) and `test/shell-guards.test.ts` (1) — PowerShell
   suites that were skipped on the macOS host and now execute here, exceeding the
   5s default timeout.

Group 3 means two rows of `docs/windows-verification.md` (Write guards, Shell
construct guard) can no longer be described as unrunnable on this host.
