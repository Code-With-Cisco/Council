# Agency Agents upstream pin

This directory is a Council-owned, data-only import of selected agent identity Markdown from:

- Repository: `msitarzewski/agency-agents`
- Reviewed commit: `3c9588880b7cafaec325a104899fd8bbe27e7d72`
- Reviewed tree: `a2e96b85b2a90a9c488b0ffb8a37db4a245b5e7c`
- Snapshot date: 2026-08-26
- License: MIT; see `LICENSE`

## Trust boundary

Files imported from upstream are untrusted instruction-bearing data until a user or Council workflow explicitly selects that agent. They do not override system, developer, current-user, Mission, worktree, handoff, test, review, or integration controls.

Only agent Markdown from the 18 approved source divisions may live below this directory. Upstream scripts, CI workflows, integrations, strategy documents, examples, application installers, memory/MCP setup, and generated tool integrations are intentionally excluded.

See `docs/agency-agents-security-review.md` for the complete review and refresh policy.

## Organization

The upstream divisions are preserved as subdirectories:

`academic`, `design`, `engineering`, `finance`, `game-development`, `gis`, `healthcare`, `marketing`, `paid-media`, `product`, `project-management`, `research`, `sales`, `security`, `spatial-computing`, `specialized`, `support`, and `testing`.

No upstream refresh is automatic. A new upstream commit requires a new review before import.
