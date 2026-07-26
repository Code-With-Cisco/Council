# Claude Code Agent Definition Pack

This package contains four ready-to-install Claude Code agent definitions:

- `builder/builder.md`
- `reviewer/reviewer.md`
- `test-engineer/test-engineer.md`
- `prd-lead/prd-lead.md`

## Installation

Copy the four Markdown files into the **project** agents directory:

```text
.claude/agents/
```

Final paths:

```text
.claude/agents/builder.md
.claude/agents/reviewer.md
.claude/agents/test-engineer.md
.claude/agents/prd-lead.md
```

Project scope, not `~/.claude/agents/`, is deliberate: these definitions encode
project-specific conventions — PRD paths, story ID formats, `scripts/acceptance/`,
and `PreToolUse` hooks pointing at `scripts/gates/` — so they belong in version
control alongside the repo they describe.

**Restart Claude Code the first time.** The agent-file watcher only covers
directories that already existed when the session started, so a newly created
`.claude/agents/` is not picked up until the next launch. Subsequent edits to
the files are detected within a few seconds without a restart.

The write guards these agents reference live in `scripts/gates/`; see
`scripts/gates/README.md` for what each one blocks and how to test it.

## Known constraints

Documented Claude Code behaviors that shape what this pack can and cannot
enforce. Recorded here so they are not rediscovered or re-litigated later.

- **`AskUserQuestion` is unavailable to every subagent.** It is stripped by the
  subagent tool filter even when listed in `tools`. PRD Lead's interactive
  discovery stages therefore only work when it runs as the **main session** —
  `claude --agent prd-lead`, or the `agent` setting — not when it is delegated
  to as a subagent. Delegated, it cannot ask the user anything.
- **`skills` and `mcpServers` frontmatter are ignored for agent-team teammates.**
  A teammate loads skills and MCP servers from project and user settings like a
  normal session, so PRD Lead's `skills: create-prd` does not apply on that path.
- **`permissionMode` is not a guarantee.** If the parent session runs
  `bypassPermissions` or `acceptEdits`, that takes precedence and cannot be
  overridden; under auto mode the subagent inherits auto mode and its
  `permissionMode` is ignored entirely. Agent-team teammates inherit the lead's
  permission mode at spawn. **The `tools` allowlist is the only restriction
  honored on both paths** — which is why Reviewer's read-only guarantee rests on
  `tools`, not on `permissionMode: plan`.
- **`permissionMode`, `hooks`, and `mcpServers` are ignored for plugin
  subagents.** This pack's write guards are `hooks`, so it must stay in
  `.claude/agents/` and must not be repackaged as a plugin — the gates would
  silently stop firing.
- **`memory` auto-enables Read, Write, and Edit** so the agent can manage its own
  memory files. That is why Reviewer has no `memory` field: adding it would
  silently break its read-only guarantee. It also means `disallowedTools` cannot
  remove Edit or Write from the three memory-enabled agents, so the
  `PreToolUse` guards are their only real write restraint.

## Important runtime enforcement

These prompts define behavior, but write-capable agents still require hard
runtime gates or `PreToolUse` hooks.

Implemented in `scripts/gates/` and registered in `.claude/settings.json`, which
routes on the hook payload's `agent_type` to the right guard.

**Not** wired via each agent's `hooks` frontmatter: that field is documented and
accepted, but verified against Claude Code 2.1.220 it **does not fire** — on
either the `--agent` path or the Agent-tool path. The frontmatter blocks are kept
in the definitions, marked inert, for when the defect is fixed. See
`scripts/gates/README.md` for the evidence.

Boundaries enforced:

- Builder: block writes to PRDs, epics, stories, tests, agent definitions, and
  other agents' memory.
- Reviewer: keep the tool allowlist to `Read`, `Grep`, `Glob`, and `SendMessage`
  — no write or execute tools, so it needs no hook.
- Test Engineer: allow writes only to test-owned paths and the story
  `acceptance` field.
- PRD Lead: allow writes only to planning documents, PRD change notices, epics,
  stories, and its own memory; block production and test paths.
- PRD section references: index every `prd_ref`; reject orphaned, duplicate,
  renumbered, or stale references.
- PRD changes: require an impact map, updated epics and stories, stale acceptance
  invalidation, stale review invalidation, and targeted agent notifications.

## PRD change propagation

The revised PRD Lead owns the complete downstream update:

1. Classify the PRD change.
2. Find all impacted epics, stories, tests, reviews, architecture decisions, and
   implementation work.
3. Update affected epic and story documents.
4. Never edit the executable acceptance command.
5. Block impacted stories until Test Engineer revalidates acceptance.
6. Mark prior review and acceptance evidence stale.
7. Write a durable PRD change notice.
8. Notify Architect, Builder, Test Engineer, Reviewer, and Researcher as
   applicable.
9. Report honestly when direct notification is unavailable.
10. Do not declare the change complete until downstream propagation is verified.

## Included revisions to other agents

Builder, Reviewer, and Test Engineer now explicitly check active PRD change
notices and reject stale stories, tests, acceptance evidence, or review bases.
