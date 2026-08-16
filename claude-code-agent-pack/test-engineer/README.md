# test-engineer

Installed at `.claude/agents/test-engineer.md` (project scope).

Write boundary enforced by `scripts/gates/test-engineer-write-guard.ps1` via the
`PreToolUse` hook in this agent's frontmatter and the settings-level dispatcher.
That guard is an allowlist. For story files it additionally inspects the Edit
payload: Test Engineer may change only an existing one-line `acceptance:` field
and cannot replace a whole story with `Write`.
