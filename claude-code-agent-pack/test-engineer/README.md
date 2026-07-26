# test-engineer

Installed at `.claude/agents/test-engineer.md` (project scope).

Write boundary enforced by `scripts/gates/test-engineer-write-guard.ps1` via the
`PreToolUse` hook in this agent's frontmatter. That guard is an allowlist. The
rule that only a story's `acceptance` field may be edited is prompt-level and
not enforceable at the path level.
