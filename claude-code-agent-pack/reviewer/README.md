# reviewer

Installed at `.claude/agents/reviewer.md` (project scope).

Read-only by construction: its `tools` allowlist is `Read, Grep, Glob,
SendMessage`. It needs no write guard because it has no write tools. Do not add
a `memory` field — memory auto-enables Read, Write, and Edit, which would
silently break the read-only guarantee.
