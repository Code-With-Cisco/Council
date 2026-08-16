# What needs to be done

Outstanding work as of 2026-08-15, after the Windows migration and the
verification pass described in `WHAT-WAS-DONE.md`.

Ordered roughly by how much it blocks. Nothing here is in progress.

---

## 1. Decisions only a human can make

### 1.1 Should reply be allowed on a session whose process has exited?

`src/ui/renderer/scene-view-model.js` permits reply only when
`state === 'blocked'` **and** `waitingFor === 'input needed'`.

The CLI is more permissive than that. `claude stop --help` states the
conversation is kept and the session is resumable with `claude attach <id>`, and
attaching a stopped session restarts it from its saved transcript. So a `done`,
`stopped` or `failed` session *can* be replied to — the app simply refuses.

This is a product decision, not a bug: a deliberately narrow reply path is
defensible. It was left untouched because widening it changes what the app offers
users, which is not a call to make while aligning versions.

**Needed:** decide whether reply should wake a terminal session, and if so
whether the UI should say that is what it is doing.

### 1.2 `appId` is currently `com.decagram.council`

`package.json` line 41. The rename brief said to leave it as
`com.PLACEHOLDER.decagram-council` pending a domain decision, but a concrete
value is already committed. Either the domain is settled and this is correct, or
it needs changing before anything is signed or distributed.

**Needed:** confirm the domain, or revert to a placeholder.

---

## 2. Verification that requires running something

Each of these was marked `UNVERIFIABLE` during the audit. The action needed is
listed; none are difficult, they simply have side effects.

| Item | What would settle it |
|---|---|
| Team and task file shapes (`<config>/teams/`, `<config>/tasks/`) | Run a session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and form a team, then read the files. `src/integration/fs/teams.ts` already assumes the current `session-<8 chars>` layout |
| Wedged-supervisor `daemon stop` output | Wedge a supervisor so it stops answering its control pipe, then run `claude daemon stop --any --keep-workers` and capture the pid it prints. Then tighten the pattern in `parseDaemonStop` against the real wording |
| Cross-session messaging on Windows | Two concurrent sessions attempting `SendMessage`. `ListAgents` and `SendMessage` both exist in the 2.1.233 binary and no platform gate was found, but that is absence of evidence |
| Codex App Server on Windows | `README.md:22` and `:261` record a live macOS handshake only. `npm run verify:codex-live` against the Windows Codex executable |

---

## 3. The parity ledger is now materially wrong

`docs/windows-verification.md` still reads as it did on 2026-07-26:

- **All 23 rows are marked `implemented-unverified`.** Several are now partly or
  wholly verified — the integration module, the story gate, the write and shell
  guards, and the Git worktree paths all have real Windows evidence.
- Its "Current non-Windows evidence" block reports `npm test` as **43 files, 390
  passed, 15 skipped**, with the skips explained as "no PowerShell interpreter is
  available on this host". That is no longer true: this host has PowerShell 5.1,
  the suites run, and the current figure is **43 files, 411 passed, 0 skipped,
  0 failed**.
- Two rows exist *only* because those suites could not run — "Write guards" and
  "Shell construct guard". Both now execute, and running them is what exposed the
  story-gate defect.

**Needed:** rewrite the ledger against current evidence. Until then it understates
what is proven and overstates what is unknown, which is the opposite of its
purpose.

---

## 4. Documentation still describes the macOS machine

| File | Lines | Problem |
|---|---|---|
| `README.md` | 183, 186, 203, 261 | "also run on macOS so the UI and supervisor integration can be developed on the…", "Run these commands from PowerShell or a macOS terminal" |
| `README.md` | 22 | Codex row still says "Windows verification pending" |
| `docs/cli-surface.md` | 9, 24, 89, 122, 161, 182–199, 217 | The source-of-truth probe transcript, captured on macOS against 2.1.220, with POSIX paths and unix-socket transport throughout. Already self-labelled "Archived platform evidence" |
| `src/ui/renderer/index.html` | 327 | UI still displays "macOS development · Windows production" |

`docs/cli-surface.md` is the significant one: it is cited as the source of truth
by `src/integration/types.ts`, but the machine it describes no longer exists. A
Windows recapture against 2.1.233 would make the header comments in the
integration layer true again. Several fragments for it already exist as fixtures.

---

## 5. Remaining macOS-era code and fixtures

None of these break anything today. They are dead weight on a Windows-only
product.

- `src/providers/codex/locate.ts:109-110, 191` — `darwin` package candidates and a
  darwin branch. Dead on the packaged target. Tests inject `platform`, so removal
  touches them.
- `test/fixtures/roster-mixed.json`, `test/fixtures/job-state-exec-done.json`,
  `test/fixtures/daemon-status-running.txt` — still carry `/Users/cisco/...` and
  `/private/tmp/...`. The Windows daemon fixtures now sit alongside them; the
  roster and job-state ones have no Windows equivalent yet, and the live
  round-trip has already produced real Windows data that could seed them.
- `test/codexAppServerClient.test.ts:82, 84` and
  `test/codexProviderAdapter.test.ts:43` — `platformOs: 'macos'`,
  `codexHome: '/tmp/codex-home'`.
- `src/ui/main.ts:1700-1701` — `DECAGRAM_COUNCIL_ALLOW_NON_WINDOWS_DEV` defaults
  to **enabled** in unpackaged builds, allowing the app to start on non-Windows.
  It existed for the macOS dev host. That host is gone, so the default is now
  backwards.

---

## 6. Project naming was never reconciled

A rename to **Decagram Council** was started but not finished, and the two names
now coexist with no rule about which is which:

- `package.json` `name` is already `decagram-council`, and `paths.ts` writes to
  `<config>/decagram-council`.
- The runtime class is `DecagramCouncilRuntime`; the env var is
  `DECAGRAM_COUNCIL_*`.
- But the repo directory is `Council`, the renderer globals are
  `CouncilSceneViewModel` and `CouncilMissionViewModel`, Git refs are created
  under `refs/council/...`, and test temp dirs use a `council-` prefix.
- Meanwhile **`council` is also a real feature name** — `council-lead`,
  `test/council.test.ts`, the Council Review UI. Those must keep the name.

**Needed:** decide which occurrences are the *project* name (rename) and which are
the *council feature* name (leave). Note that `refs/council/...` appears in Git
refs and worktree branch names, so renaming those is a data-migration question,
not a find-and-replace.

---

## 7. Machine setup, not repo work

`C:\Users\User\.local\bin` is not on `PATH`, so bare `claude` does not resolve in
a fresh terminal. The app itself is unaffected — `src/integration/cli/locate.ts`
probes that directory directly — but any shell use of the CLI needs it.

Fix via System Properties → Environment Variables → edit user `PATH`.

---

## Not a problem, recorded so it is not re-investigated

- **The supervisor is usually "not running", and that is correct.** Service
  install is disabled in this version; the daemon starts on demand and exits when
  the last client disconnects. It must never be surfaced as a fault.
- **A background session in `working` reports no `pid`.** The supervisor hosts
  the process, so there is no CLI pid. `pid` is not a liveness signal; `state` is.
- **Supervisor and CLI versions match** at 2.1.233.
