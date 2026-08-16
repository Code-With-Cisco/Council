# Windows agent guards

Decagram Council is a Windows-only application. Every enforcement hook in this
directory is PowerShell; there is no Bash dialect or macOS registration path.

`.claude/settings.json` enables the PowerShell tool, sets PowerShell as the
default shell, and registers four synchronous handlers:

| Event / matcher | Handler | Purpose |
|---|---|---|
| `PreToolUse` / `Edit|Write` | `agent-write-dispatch.ps1` | Route guarded agents to their path policy |
| `PreToolUse` / `PowerShell` | `agent-shell-dispatch.ps1` | Stop guarded agents from using the shell as an editor |
| `TaskCompleted` | `story-gate.ps1` | Verify traceability, acceptance, and git-visible path ownership |
| `TeammateIdle` | `story-gate.ps1` | Re-check completed stories before a teammate parks |

Current Claude Code documentation says agent frontmatter hooks run for both
`--agent` and subagent sessions. A live probe against 2.1.220 previously found
that they did not fire. The settings-level dispatchers remain the primary
enforcement path; the direct agent hooks are retained as a second path.

## Write policies

`_guard-lib.ps1` parses payloads, normalizes Windows paths, resolves existing
targets, compares project membership case-insensitively, removes worktree
prefixes, defines shared path groups, writes the audit log, and collects changed
paths from git.

The settings-level dispatcher deliberately allows an absent or unknown
`agent_type`, because a human session uses the same project settings. After a
guarded agent is identified, malformed payloads, missing targets, outside paths,
and missing guard scripts fail closed.

| Agent | Policy |
|---|---|
| `builder` | May change production files; cannot change PRDs, epics, stories, tests, Claude configuration, guards, agent definitions, or another agent's memory |
| `test-engineer` | Allowlist: tests, fixtures, acceptance artifacts, stories, and its own memory |
| `prd-lead` | Allowlist: PRDs, epics, stories, planning artifacts, and its own memory |
| Other agent / human | Not governed by these role-specific dispatchers |

Protected Claude configuration includes `.claude/settings*.json`,
`.claude/hooks/**`, `.mcp.json`, `CLAUDE.md`, and `CLAUDE.local.md`.

## PowerShell construct guard

Builder and Test Engineer keep PowerShell because they must run existing build,
test, and acceptance programs. They may not use PowerShell itself as an editor.

The shell dispatcher blocks redirection, content-writing cmdlets, file mutation
cmdlets, `Tee-Object`, direct .NET file writes, dynamic evaluation, encoded
commands, dynamic script blocks, nested process launch, here-strings, a
variable call operator, and inline interpreter escapes such as `node -e`,
`python -c`, `cmd /c`, and nested PowerShell command strings. Commands such as
`npm run build`, `npm test`, and `tsc` remain allowed.

This is a construct-level check, not a security boundary. The completion gate
also checks git-visible changed paths against the agent's ownership policy.

## Story acceptance

The story `acceptance` field is a Windows PowerShell command. The gate rejects
obvious POSIX-only syntax (`bash`, `sh`, `./script`, `/bin/...`) and status
masking. It then executes the command in a fresh non-interactive PowerShell
process from the project root.

Write-hook payload inspection also enforces story-field ownership. Test Engineer
may use `Edit` only for an existing one-line `acceptance:` field; it cannot use
`Write` to replace a story. PRD Lead may edit story product content but cannot
change `acceptance:` or replace an entire story with `Write`.

Example:

```yaml
---
id: MER-101
prd_ref: "docs/prd.md#1.2"
acceptance: npm test -- upload
status: done
---
```

## Audit and self-test

Every guarded decision appends one tab-separated line to
`.claude/gate-audit.log` containing timestamp, event, `agent_type`, target, and
decision. The file is ignored by git.

`guard-self-test.ps1` sends two known-must-block payloads through the real write
and shell dispatchers. The launch preflight runs it and surfaces pass, fail, or
PowerShell-unavailable in diagnostics.

Run manually on Windows:

```powershell
pwsh -NoProfile -File .\scripts\gates\guard-self-test.ps1 -ProjectDir $PWD
```

The PowerShell test suites are skipped with an explicit reason when neither
`pwsh` nor `powershell` exists. A skipped suite is not a passing Windows claim.
