#!/usr/bin/env bash
# Test Engineer write guard — PreToolUse hook for Edit|Write.
#
# This is an ALLOWLIST: anything not explicitly permitted is blocked. Test
# Engineer produces the authoritative pass/fail evidence for a story, so it must
# not be able to reach into production code and make a failing test pass by
# changing the implementation.
#
# ALLOWS: test paths, fixtures, scripts/acceptance/**, story files (see below),
#         and its own agent memory.
# BLOCKS: everything else — production source, production config, migrations,
#         deployment paths, PRD documents, epics, gate scripts, agent
#         definitions, and other agents' memory.
#
# ============================== LIMITATIONS ==============================
# Path-level gate only.
#
# Story files are ALLOWED here because authoring a story's executable
# `acceptance` command is this agent's job, and that command lives in the story
# frontmatter. The narrower rule — that Test Engineer may edit ONLY the
# `acceptance` field and nothing else in the story — is NOT enforceable at the
# path level and remains prompt-level. Once a story write is permitted, this
# guard cannot tell an acceptance-field change from a rewritten requirement.
#
# Closing that gap needs a content-level check (for example, a PostToolUse hook
# diffing story frontmatter and rejecting changes outside `acceptance`).
# =========================================================================
#
# Exit 0 = allow, exit 2 = block (stderr becomes the reason shown to the agent).
# Fails closed: an unreadable payload blocks.

set -u

# shellcheck source=_guard-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_guard-lib.sh"

AGENT="test-engineer"
LABEL="Test Engineer"

guard_read_payload
guard_resolve_path "$LABEL"

rel="$GUARD_REL"

# --- explicit denials first, so the reason is specific rather than generic ----

if guard_is_prd "$rel"; then
  guard_block "Test Engineer must not edit PRD documents (${rel}). Product intent belongs to PRD Lead. If a requirement is untestable, report that instead of changing it."
fi

if guard_is_epic "$rel"; then
  guard_block "Test Engineer must not edit epic files (${rel}). Epics are owned by PRD Lead."
fi

if guard_is_gate_script "$rel"; then
  guard_block "Test Engineer must not modify the gate scripts (${rel}). These enforce the boundaries you operate under."
fi

if guard_is_agent_definition "$rel"; then
  guard_block "Test Engineer must not modify agent definitions (${rel})."
fi

if guard_is_foreign_agent_memory "$rel" "$AGENT"; then
  guard_block "Test Engineer may only write to its own memory directory (.claude/agent-memory/${AGENT}/), not ${rel}."
fi

# --- the allowlist -----------------------------------------------------------

if guard_is_test "$rel"; then
  guard_allow
fi

if guard_is_own_agent_memory "$rel" "$AGENT"; then
  guard_allow
fi

# Permitted so the `acceptance` command can be authored. The field-level
# restriction is prompt-level; see the LIMITATIONS block above.
if guard_is_story "$rel"; then
  guard_allow
fi

# --- default deny ------------------------------------------------------------

if guard_is_production "$rel"; then
  guard_block "Test Engineer must not write production source or config (${rel}). Making a failing test pass by changing the implementation is Builder's work, and doing it here would destroy the independence of your acceptance evidence. Report the failure instead."
fi

guard_block "Test Engineer may only write to test paths, fixtures, scripts/acceptance/, story acceptance commands, and its own agent memory. ${rel} is outside all of those, so it is blocked by default. If this path should be test-owned, say so rather than working around the guard."
