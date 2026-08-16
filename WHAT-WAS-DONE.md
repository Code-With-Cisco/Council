# What was done

Work completed on 2026-08-15, after the project moved from the original macOS
development machine to Windows. Three commits, all on `main`.

| Commit | Subject |
|---|---|
| `fc894e0` | Add CLI surface verification audit |
| `458eeb8` | Align integration layer with Claude Code 2.1.233 |
| `e337d33` | Close Windows verification gaps and fix two gate defects |

Full detail, including verbatim command output, is in `VERIFICATION.md`. This
file is the summary.

---

## 1. Audited the CLI surface against the installed reality

The integration layer was written in July 2026 against **Claude Code 2.1.220 on
macOS**. The Windows machine was found running **2.1.143** — roughly ninety
releases *behind*, not ahead. Every fixture in the repo carried macOS paths.

The audit established ground truth by probing the installed binary rather than
trusting documentation, and recorded the result in `VERIFICATION.md` as a drift
table with `CONFIRMED` / `DRIFTED` / `UNVERIFIABLE` verdicts, plus a platform
inventory.

Notable finding: on 2.1.143, `claude agents --json` **did not exist at all**.
The roster is the app's only view of live sessions, so the integration layer
could not have functioned on that version.

## 2. Upgraded the CLI and aligned the code to it

`claude install latest` took the host from 2.1.143 to **2.1.233**. That alone
resolved the two hardest blocking issues — the roster interface came back, and
the host cleared the enforced minimum version.

Re-probing 2.1.233 on Windows then found real drift that the upgrade did not fix:

- **Session states.** The CLI carries `["starting","resuming","adopted","crashed"]`
  as its own named array, plus `running`. The code modelled five states and
  dropped everything else to `undefined`, which the binding logic then rendered
  as healthy. **A crashed session looked fine.** The union was widened, the
  transitional states are treated as hosted rather than dormant, and `crashed`
  now shows as a failure in both the card and the pixel scene.
- **`waitingFor` gained a sixth value**, `goal proposal`. The existing
  pass-through design meant it degraded to plain text rather than vanishing;
  it is now a known value.
- `MINIMUM_CLAUDE_VERSION` raised to `2.1.233`.

Version claims in comments were only updated where the behaviour was actually
re-probed. Claims that were not re-checked still say 2.1.220, because that is
when they were last verified.

## 3. Fixed two real Windows product defects

Both were found by tests that had **never executed on any host** — the PowerShell
suites were skipped on macOS for lack of an interpreter, and the Git suites had
never met Windows path semantics.

### The story gate could not fail a story

Two compounding bugs in `scripts/gates/story-gate.ps1`:

1. Frontmatter parsing used `.Trim('"')`, which strips a trailing quote that
   belongs to the value. An acceptance of `node -e "process.exit(0)"` became
   `node -e "process.exit(0)` — an unterminated string.
2. The acceptance command was passed after `-Command`, which strips embedded
   quotes *and* does not propagate a native exit code. `node -e "process.exit(3)"`
   reached the child as `node -e process.exit(3)`; PowerShell parsed `(3)` as a
   subexpression, so node evaluated a bare `process.exit` reference and exited 0.

Net effect: **a failing acceptance command returned success and the gate passed
the story.** Acceptance now runs through `-EncodedCommand` with an explicit exit,
and only a matched pair of wrapping quotes is stripped. Verified against failing
native commands, passing ones, and failing cmdlets.

### Worktree paths never matched on Windows

Git reports worktree paths with forward slashes (`C:/Users/...`) while Node
produces backslashes (`C:\Users\...`). Every comparison against `entry.path`
failed, so worktree reconciliation could not recognise a checkout it had just
created. Normalised at the single choke point, `parseWorktreePorcelain`.

## 4. Brought the test suite to green on Windows

**`npx tsc --noEmit` clean. `npm test`: 43 files, 411 tests, 0 failures.** This is
the first fully passing suite this repo has had on Windows.

Eight tests were failing before this work. A baseline was measured by stashing, to
prove which failures were pre-existing rather than newly introduced. Beyond the
two product defects above, the remaining fixes were test-side:

- `test/board.test.ts` compared POSIX literals against paths that
  `claudeConfigDir` correctly resolves to a drive-qualified form.
- Git fixture repos now pin `core.autocrlf=false`; Git for Windows sets it true
  system-wide, so fixture content round-tripped as CRLF.
- The PowerShell guard timeout was raised — five real PowerShell processes cannot
  finish inside Vitest's 5s default.

## 5. Verified the live surface against a real supervisor

A `--bg --exec` shell job was dispatched, observed, stopped and removed. It spends
no model quota but exercises the same dispatch, roster, logs, stop and rm paths a
real session uses. It confirmed the `state.json` shape, the short-id invariant,
`unknown-session` classification on a bogus id, and the dispatch output format,
and left nothing behind.

A second job was held open to capture the running supervisor:

- **Supervisor version 2.1.233 matches the CLI version** — the mismatch the audit
  was asked to check for does not exist here.
- A background session in state `working` reports **no `pid`**, confirming on
  Windows the exact reasoning `deriveCold` was built on.

Both Windows daemon-status shapes are now committed fixtures with parser tests.
The running form carries a trailing "holding this daemon open" block that the
macOS transcript does not.

## 6. Made supervisor recovery reachable

`daemonStop()` existed but had no caller anywhere in `src/`. It now parses its
result into a typed `DaemonStopOutcome` and is reachable as
`npm run harness daemon-stop`. Both real outcomes were observed and are tested:
`stopped` and `no daemon running`, both exiting 0.

## 7. Housekeeping

- Deleted `README 2.md`, a stale duplicate committed once in `e95104a` that still
  described a macOS/Windows product with a bash forwarder and an unbuilt UI.
- Installed `node_modules` (335 packages). It was absent, so nothing could be
  typechecked or tested. Gitignored, not committed.

---

## Honest limits of this work

Three things could not be verified and were **not** guessed at:

1. **The wedged-supervisor `daemon stop` message.** Both healthy outcomes were
   observed, but a supervisor that stops answering could not be produced on
   demand. The `taskkill` pid extraction is deliberately loose, tested only
   against synthetic input, and labelled as uncaptured in both the code comment
   and `VERIFICATION.md`. Do not treat that pattern as verified.
2. **Team and task file shapes** — no team has ever been created on this host.
3. **Whether cross-session messaging is macOS/Linux only** — no platform gate was
   found for it in the binary, but proving the behaviour needs two concurrent
   sessions.

One product decision was deliberately left open rather than made unilaterally:
reply is still gated on `blocked` + `input needed`. See `WHAT-NEEDS-TO-BE-DONE.md`.
