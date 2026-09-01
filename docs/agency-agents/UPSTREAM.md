# Agency Agents upstream pin

Council vendors a data-only snapshot of agent identity Markdown from `msitarzewski/agency-agents`.

- Reviewed commit: `3c9588880b7cafaec325a104899fd8bbe27e7d72`
- Reviewed tree: `a2e96b85b2a90a9c488b0ffb8a37db4a245b5e7c`
- Snapshot date: 2026-08-26
- Expected agent count: 273
- License: MIT; the copied license is retained at `.claude/agents/agency-agents/LICENSE`

## Trust boundary

The imported identity documents are untrusted instruction-bearing data until a host deliberately selects one as a specialist. They cannot override system, developer, current-user, Council Mission, worktree, handoff, test, review, integration, tool-permission, network, filesystem, credential, or memory controls.

Only agent Markdown from the 18 approved source divisions is imported. Upstream scripts, CI workflows, integrations, strategy documents, examples, installers, applications, memory/MCP setup, and generated tool integrations are excluded.

See `docs/agency-agents-security-review.md` for the full review and refresh policy.

## Organization

The source divisions are preserved under `.claude/agents/agency-agents/<division>/` and mirrored as bundled references inside the portable Codex skill at `.agents/skills/agency-agents-router/references/agents/<division>/`.

Approved divisions are `academic`, `design`, `engineering`, `finance`, `game-development`, `gis`, `healthcare`, `marketing`, `paid-media`, `product`, `project-management`, `research`, `sales`, `security`, `spatial-computing`, `specialized`, `support`, and `testing`.

Future refreshes must pin an exact new upstream commit and repeat the security/diff review before changing the vendored snapshot.
