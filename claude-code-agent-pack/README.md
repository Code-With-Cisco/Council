# Claude Code Agent Definition Pack

This package contains four ready-to-install Claude Code agent definitions:

- `builder/builder.md`
- `reviewer/reviewer.md`
- `test-engineer/test-engineer.md`
- `prd-lead/prd-lead.md`

## Installation

Copy the four Markdown files into:

```text
~/.claude/agents/
```

Recommended final paths:

```text
~/.claude/agents/builder.md
~/.claude/agents/reviewer.md
~/.claude/agents/test-engineer.md
~/.claude/agents/prd-lead.md
```

## Important runtime enforcement

These prompts define behavior, but write-capable agents still require hard
runtime gates or `PreToolUse` hooks.

At minimum:

- Builder: block writes to PRDs, epics, stories, tests, agent definitions, and
  other agents' memory.
- Reviewer: keep the tool allowlist exactly `Read`, `Grep`, and `Glob`.
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
