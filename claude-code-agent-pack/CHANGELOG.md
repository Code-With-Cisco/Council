# Change Log

## 2026-08-16 — Windows guard hardening

- Made every hook command invoke `powershell.exe -NoProfile -NonInteractive
  -File` explicitly and documented the allow/block exit-code contract.
- Made an unexpected guarded child exit fail closed as exit 2.
- Resolved junction targets during containment checks.
- Blocked inline interpreter and nested-shell escapes in guarded PowerShell.
- Enforced Test Engineer and PRD Lead story-field ownership from Edit/Write
  payloads; the older prompt-only limitation below is historical.
- Added regression coverage for each bypass.

## 2026-07-26 — Windows-only enforcement conversion

- Replaced the Bash write dispatcher and role guards with PowerShell implementations.
- Added a PowerShell shell-operation guard and Windows-only story gate.
- Registered `Edit|Write`, `PowerShell`, `TaskCompleted`, and `TeammateIdle` handlers in
  `.claude/settings.json`.
- Added the Windows guard self-test and verification ledger.
- The earlier macOS-specific choices below are historical and are superseded by this entry.

## 2026-07-25 — Frontmatter, routing, and runtime-gate pass

Verified every field against the current `sub-agents` and `agent-teams`
documentation. Agent prompt bodies were not reworded.

Frontmatter, all four agents:

- Converted `tools` from a YAML block sequence to the documented comma-separated
  string form. (`skills` remains a block sequence — that *is* its documented
  form; the two fields differ.)
- Added `SendMessage`, without which the inter-agent notification protocol the
  bodies describe cannot execute on the plain subagent path.
- Removed `PowerShell` from Builder and Test Engineer; the host is macOS.
- Added `disallowedTools` as defense in depth, and `color` so the four are
  distinguishable in the task panel.
- Deliberately did **not** add `memory` to Reviewer: memory auto-enables Read,
  Write, and Edit, which would silently break its read-only guarantee.
- Left `model`, `permissionMode`, `maxTurns`, `effort`, and `skills` unchanged.

Routing:

- Deleted the `SHOULD route:` / `SHOULD NOT route:` trailer lines from all four
  bodies. Delegation reads `description`, not the body, so those lines affected
  nothing. Each signal was confirmed already covered by the existing
  `description` before removal; none was lost.
- Relocated each `WATCH:` line to sit under the agent's opening role statement,
  reformatted as "Known failure mode: …" with its meaning preserved.

Runtime gates — the part that actually enforces anything:

- Added `scripts/gates/builder-write-guard.sh`,
  `test-engineer-write-guard.sh`, and `prd-lead-write-guard.sh`, plus the shared
  `_guard-lib.sh`. Wired to `PreToolUse` / `Edit|Write` in each agent's
  frontmatter. Reviewer gets no hook: it has no write tools.
- Guards exit 2 to block with a reason on stderr, exit 0 to allow, and fail
  closed on an unparseable payload, a missing `file_path`, or `..` traversal.
- Hook commands use `${CLAUDE_PROJECT_DIR}`, not a relative path, which would
  resolve against the agent's cwd and break inside a worktree.
- **Frontmatter `hooks` do not fire in Claude Code 2.1.220.** Discovered during
  runtime verification: the guards were originally attached per-agent via the
  documented `hooks` frontmatter field, and enforced nothing. Tested three ways —
  an agent run via `--agent` wrote to a blocked path successfully; an
  always-block probe on `Read`, attached to an agent spawned through the Agent
  tool, let the read through; the same guard registered in `settings.json`
  blocked correctly with its own reason text. The documentation states
  frontmatter hooks fire on both paths, so this is a defect, not a
  misconfiguration. Re-test on upgrade.
- Guards are therefore registered once in `.claude/settings.json` pointing at
  `scripts/gates/agent-write-dispatch.sh`, which reads `agent_type` from the
  payload and routes to the matching guard. Confirmed empirically that
  `agent_type` carries the agent's frontmatter `name`.
- The dispatcher **defaults to allow**. A settings-level hook fires for every
  `Edit`/`Write` in the project including a human's, so anything that is not one
  of the three guarded agents passes through untouched. Verified live: a
  main-session write to `test/` is allowed, the same write as `builder` is
  blocked. A guarded agent whose guard script is missing blocks, so a broken
  install cannot silently un-gate a restricted agent.
- Per-agent frontmatter `hooks` blocks were left in place with a comment marking
  them inert, so nobody mistakes them for live enforcement.
- Guards strip a `.claude/worktrees/<name>/` prefix before matching. Without
  that, every pattern stops matching precisely when a background session is
  doing real work.
- Path-level only. The rule that Test Engineer may edit *only* a story's
  `acceptance` field — and that PRD Lead may never touch it — is not enforceable
  at the path level and remains prompt-level. Documented in each script and in
  `scripts/gates/README.md`.

Install location and docs:

- Agents now install to project scope `.claude/agents/`, not `~/.claude/agents/`.
  They encode project-specific conventions and reference project-relative gate
  scripts, so they belong in version control. A restart is required the first
  time, because the file watcher only covers directories that existed at session
  start.
- Recorded a "Known constraints" section covering `AskUserQuestion` being
  unavailable to subagents, `skills`/`mcpServers` being ignored for teammates,
  `permissionMode` being overridden by the parent, and `permissionMode`/`hooks`/
  `mcpServers` being ignored for plugin subagents.
- Deleted `MANIFEST.md`; its hardcoded byte counts were already stale.
- Updated the four per-agent READMEs, which still pointed at `~/.claude/agents/`.

## PRD change-propagation revision

The PRD Lead now:

- owns reverse-reference impact analysis for changed PRD sections;
- updates affected epics and story product definitions;
- preserves IDs when the deliverable remains coherent;
- creates replacement stories or epics when traceability would otherwise be
  misleading;
- blocks impacted stories pending Test Engineer revalidation;
- never edits the executable `acceptance` field;
- invalidates stale acceptance evidence and prior Reviewer verdicts;
- writes a durable PRD change notice;
- sends targeted notifications to Architect, Builder, Test Engineer, Reviewer,
  and Researcher when team messaging is available;
- produces an honest dispatch list when messaging is unavailable;
- refuses to call a PRD change complete until propagation is verified.

Builder, Reviewer, and Test Engineer now reject or revalidate work affected by
active PRD change notices.
