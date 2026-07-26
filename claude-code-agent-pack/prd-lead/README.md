# prd-lead

Installed at `.claude/agents/prd-lead.md` (project scope). This revision
includes PRD change propagation and agent notifications.

Write boundary enforced by `scripts/gates/prd-lead-write-guard.ps1` via the
`PreToolUse` hook in this agent's frontmatter.

Its interactive discovery stages require running as the main session
(`claude --agent prd-lead`): `AskUserQuestion` is unavailable to subagents, so a
delegated PRD Lead cannot ask the user anything.
