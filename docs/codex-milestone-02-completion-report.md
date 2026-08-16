# Milestone 2 completion report: provider-neutral missions

> Historical snapshot from 2026-07-26. Its macOS host, pending-Windows, and
> renderer-path statements describe that milestone only. Current Windows
> evidence and the intentionally exposed Git Bash diagnostic path are recorded
> in the root status documents and `README.md`.

**Brief:** [`codex-milestone-02-provider-neutral-missions.md`](codex-milestone-02-provider-neutral-missions.md)
**Report date:** 2026-07-26
**Development host:** macOS (Darwin 25.5.0), Node 20.11+, no PowerShell interpreter
**Packaged target:** 64-bit Windows 10/11 — **not verified on a Windows host**

## 1. Definition-of-done status

| # | Requirement | Status |
|---|---|---|
| 1 | Provider-neutral contracts; Claude behavior preserved behind an adapter | Implemented |
| 2 | One long-lived Codex App Server stdio client, initialized once | Implemented |
| 3 | Truthful Codex auth/protocol state; no stored credentials | Implemented |
| 4 | Persistent Codex role threads by exact ID with typed events | Implemented |
| 5 | Strict, versioned, atomic, last-known-good stores | Implemented |
| 6 | Unique Council-owned writer worktrees; detached gate checkouts | Implemented |
| 7 | Start Squad privileged preview with stale-fingerprint rejection | Implemented |
| 8 | Handoffs from a clean owned lease naming an exact descended commit | Implemented |
| 9 | Independent Test and Review gates bound to one exact commit/policy | Implemented |
| 10 | Read-only integration preview, exact approval, fast-forward-only mutation | Implemented |
| 11 | Typed mission IPC in the Missions UI and shared projections | Implemented |
| 12 | Adversarial unit/integration coverage | Implemented |
| 13 | `npm run typecheck`, `npm run build`, `npm test` pass | Passing |
| 14 | README and verification docs separate implementation from evidence | Complete |
| 15 | This completion report | Complete |

Every status above is **implementation** status. No item is Windows-verified.

## 2. Commands and results

Run on the macOS development host on 2026-07-26:

| Command | Result |
|---|---|
| `npm run typecheck` | passed, no diagnostics |
| `npm run build` | passed |
| `npm test` | 43 files, 390 passed, 15 skipped, 0 failed |
| `npm audit --omit=dev` | 0 vulnerabilities in the packaged runtime set |
| `npm audit` | 16 high-severity advisories, all in electron-builder's build-time glob/minimatch/brace-expansion chain |
| `npm run verify:codex-live` | previously passed against the real bundled Codex executable on macOS: stdio connect, initialize, non-secret authenticated state, close with no thread deletion |

The 15 skipped tests are the PowerShell suites (`gates`, `shell-guards`,
`write-guards`, `hookScript`). They skip because no PowerShell interpreter
exists on this host, not because they passed.

## 3. Work completed in this session

The three preceding milestone commits (`fa638de`, `a3965fe`, `340b474`) landed
the subsystem but left the tree failing its own gate. This session closed that
gap and the two defects it exposed.

### 3.1 Repaired the failing gate

- `src/ui/missionController.ts` called `GateRunner.run` without the required
  `idempotencyKey`, so `npm run typecheck` failed.
- `test/missionCoordinator.test.ts` imported `MissionDomainError` unused.
- `test/missionProviderRouter.test.ts` used `profile-000001`, which is not a
  routable profile ID (`/^profile-[A-Za-z0-9_-]{8,}$/`), so both Claude
  ownership-preview tests threw out of the durable store instead of exercising
  the preview.

### 3.2 Gate idempotency key (decision)

The renderer must not be able to fabricate or replay an idempotency key, and the
ledger records gate attempts append-only. The privileged controller now derives
the key deterministically as `gate:<sha256>` over the exact workspace, mission,
candidate, kind, commit, tree, policy fingerprint, command IDs, executor
execution, executor profile, **and the number of gate attempts already durable
in the ledger for that candidate and kind**.

The attempt count is what makes both required behaviors hold at once:

- A resubmit whose outcome was never recorded produces the same key, so
  `GateRunner` replays the durable terminal result instead of creating a second
  checkout and command run.
- An explicit re-run after a recorded attempt produces a different key, so a
  genuine second attempt is not silently answered with the first attempt's
  verdict.

Covered by `test/missionController.test.ts` — "replays an unrecorded gate
attempt and separates an explicit re-run".

### 3.3 Worktree root path confusion (defect found and fixed)

`WorktreeLeaseManager.provisionWriter` built the writer checkout path by
lexically joining the resolved worktree root with two generated segments
(`<workspaceToken>/<leaseToken>/checkout`). `path.join` does not resolve
symlinks, and `workspaceToken` is a deterministic SHA-256 prefix of the
workspace ID that persists across leases — so a symlink or Windows junction
planted at that predictable segment would have redirected a Council-owned
worktree outside the Council root before any journal or Git mutation. The
existing `pathExists` guard did not catch it, because it only tested the leaf.

`GateRunner` already asserted its single-level checkout stayed inside its owned
root; the lease manager did not. It now creates the owned parent, resolves it
with `realpath`, and rejects provisioning with "Generated Council checkout
escaped its owned worktree root" if the resolved parent is not exactly the
expected path.

Covered by `test/worktreeLeaseManager.test.ts` — "refuses a worktree root
segment redirected by a symlink". The test was confirmed to fail against the
unfixed manager (the worktree was created through the symlink, `createCalls`
reached 1), so it is not vacuous.

This closes the "symlink/path confusion" clause of definition-of-done item 12,
which had no mission-side coverage.

### 3.4 Files changed in this session

| File | Change |
|---|---|
| `src/ui/missionController.ts` | derive the privileged gate idempotency key; `gateAttempts` helper |
| `src/orchestration/worktrees/leaseManager.ts` | `ensureOwnedCheckoutParent` containment proof before Git mutation |
| `test/missionController.test.ts` | assert the derived key; new replay/re-run test |
| `test/worktreeLeaseManager.test.ts` | new symlink path-confusion test |
| `test/missionCoordinator.test.ts` | drop the unused import |
| `test/missionProviderRouter.test.ts` | use routable profile IDs |

## 4. Milestone 2 changed files

77 files against the Milestone 1 tip (`34370b4`): 24,665 insertions, 103
deletions. Source and renderer account for 47 files (18,130 insertions); tests
account for 25 files (6,408 insertions).

### Added — provider seam

`src/providers/contracts.ts`, `src/providers/missionContracts.ts`,
`src/providers/index.ts`, `src/providers/codex/adapter.ts`,
`src/providers/codex/appServerClient.ts`, `src/providers/codex/protocol.ts`,
`src/providers/codex/threadBindings.ts`, `src/providers/codex/locate.ts`,
`src/providers/codex/index.ts`, `src/integration/claudeProviderAdapter.ts`

### Added — mission authority

`src/missions/coordinator.ts`, `src/missions/ledger.ts`,
`src/missions/types.ts`, `src/missions/projection.ts`,
`src/missions/gitAdapter.ts`, `src/missions/worktreeAdapter.ts`,
`src/missions/gateRunner.ts`, `src/missions/providerRouter.ts`

### Added — Git and worktree leases

`src/git/client.ts`, `src/git/contracts.ts`, `src/git/parse.ts`,
`src/git/process.ts`, `src/git/index.ts`,
`src/orchestration/worktrees/leaseManager.ts`,
`src/orchestration/worktrees/leaseStore.ts`,
`src/orchestration/worktrees/types.ts`,
`src/orchestration/worktrees/index.ts`

### Added — UI

`src/ui/missionController.ts`, `src/ui/missionUi.ts`,
`src/ui/renderer/mission-view-model.js`

### Modified

`src/ui/main.ts`, `src/ui/ipc.ts`, `src/ui/ipcHandlers.ts`,
`src/ui/ipcValidation.ts`, `src/ui/preload.cjs`,
`src/ui/renderer/{index.html,renderer.js,styles.css,pixel-office.js,scene-view-model.js}`,
`src/supervisor/{agentSupervisor,launchCoordinator,sessionBindings,index}.ts`,
`src/integration/{index,runtime,types}.ts`, `README.md`,
the historical Windows verification ledger (removed after closure),
`package.json`, `.gitignore`

### Added — tests

`test/{claudeProviderAdapter,codexAppServerClient,codexLocate,codexProviderAdapter,codexThreadBindings}.test.ts`,
`test/{gitClient,gitProcess}.test.ts`,
`test/{missionController,missionCoordinator,missionGateRunner,missionGitAdapter,missionLedger,missionProviderRouter,missionViewModel}.test.ts`,
`test/{worktreeLeaseManager,worktreeLeaseStore}.test.ts`

### Added — tooling

`scripts/verify-codex-app-server.mjs` (`npm run verify:codex-live`)

## 5. Standing decisions

1. **Claude monitoring was not made generic.** `ClaudeCodeAgentSupervisor` keeps
   its daemon, roster, jobs, teams, hooks, and PTY behavior. The mission
   coordinator composes a narrow adapter instead of renaming Claude-specific
   concepts into false provider-neutral ones (brief §3).
2. **Claude sessions are readable but not claimable by a mission.** A Milestone 1
   binding without an exact mission execution and access mode previews as
   unlaunchable rather than being adopted.
3. **Council never force-removes a worktree.** Cleanup delegates to
   `git worktree remove` after verifying registration, ownership, cleanliness,
   and exact head. Physical removal stays outside the shutdown path.
4. **Gate results are bound to one exact commit, tree, and policy fingerprint**
   and cannot be produced by the assignment that produced the handoff.
5. **Integration is fast-forward only**, two-step, single-use, and revalidated
   against target drift immediately before mutation.
6. **Provider approvals fail closed.** Only allowlisted exact request kinds can
   receive a typed decision; no "always approve" path exists.
7. **The renderer receives no executable path, raw environment, or filesystem
   write primitive**, and no provider text is rendered as HTML.

## 6. Remaining platform evidence

Windows evidence is **entirely outstanding**. The authoritative ledger is
the former Windows verification ledger; its 18-item release probe
is the gate for calling any build Windows-verified. The mission-specific items
still unperformed:

1. Full test suite with PowerShell available, with no suite skipped.
2. Packaged NSIS install and launch; UI at 100/125/150/200% scaling.
3. Windows Codex App Server connect, provider-owned auth, and close with no
   thread deleted or archived.
4. A mixed Claude/Codex mission with distinct read-only Test and Review
   assignments and a writer worktree under a user-data path containing spaces.
5. Restart during writer provisioning, and after a Codex thread is saved but
   before its first turn is acknowledged — confirming only the exact durable
   retry is offered and no duplicate worktree or turn is created.
6. Exact clean-commit handoff, both detached gates, target branch moved after
   preview, old fingerprint rejected without mutation.
7. Integration approved without drift, app interrupted after the expected-old
   ref update, restart recovery leaving the branch at the one reviewed commit.
8. Quit with a mission operation and gate command active; only Council-owned
   processes stop, provider conversations and worktrees survive.
9. Git for Windows and NTFS behavior for generated refs, junctions, and paths
   containing spaces.

The real-Git tests in this suite run against genuine local repositories on
macOS. The Codex App Server handshake was exercised against the real bundled
executable on macOS. Neither is Windows evidence.

## 7. External blockers

No external blocker prevented any definition-of-done item.

One accepted condition, unchanged from the Milestone 1 audit: `npm audit`
reports 16 high-severity advisories in electron-builder's build-time
glob/minimatch/brace-expansion chain. The packaged runtime dependency set is
clean (`npm audit --omit=dev`: 0), and npm's offered forced fix is a breaking
electron-builder downgrade, so it was not applied.

The Milestone 1 Claude CLI surface mismatches (no `claude reply`, exit-zero
failures, prose daemon status, `--agent` fallback) remain handled as documented
in the README; they did not block Milestone 2.
