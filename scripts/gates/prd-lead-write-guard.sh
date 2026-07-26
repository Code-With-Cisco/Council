#!/usr/bin/env bash
# PRD Lead write guard — PreToolUse hook for Edit|Write.
#
# This is an ALLOWLIST: anything not explicitly permitted is blocked. PRD Lead
# owns product intent and its propagation, and nothing else. It must not be able
# to implement the thing it specified, or to adjust the tests that decide
# whether the specification was met.
#
# ALLOWS: PRD documents, PRD change notices, epics, stories, other planning
#         documents, and its own agent memory.
# BLOCKS: everything else — all production source and config, all test paths,
#         acceptance commands, gate scripts, agent definitions, and other
#         agents' memory.
#
# ============================== LIMITATIONS ==============================
# Path-level gate only.
#
# Story files are allowed here because PRD Lead owns story product definitions.
# The narrower rule — that PRD Lead must NEVER edit the executable `acceptance`
# field, which belongs to Test Engineer — is NOT enforceable at the path level
# and remains prompt-level. Once a story write is permitted, this guard cannot
# tell a requirement update from an acceptance-command rewrite.
#
# Closing that gap needs a content-level check (for example, a PostToolUse hook
# diffing story frontmatter and rejecting any change to `acceptance`).
# =========================================================================
#
# Exit 0 = allow, exit 2 = block (stderr becomes the reason shown to the agent).
# Fails closed: an unreadable payload blocks.

set -u

# shellcheck source=_guard-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_guard-lib.sh"

AGENT="prd-lead"
LABEL="PRD Lead"

guard_read_payload
guard_resolve_path "$LABEL"

rel="$GUARD_REL"

# --- explicit denials first, so the reason is specific rather than generic ----

if guard_is_test "$rel"; then
  guard_block "PRD Lead must not write tests or acceptance commands (${rel}). Tests and the executable acceptance command are owned by Test Engineer. When a PRD change invalidates a test, block the story and request revalidation instead of editing the test."
fi

if guard_is_gate_script "$rel"; then
  guard_block "PRD Lead must not modify the gate scripts (${rel}). These enforce the boundaries you operate under."
fi

if guard_is_agent_definition "$rel"; then
  guard_block "PRD Lead must not modify agent definitions (${rel})."
fi

if guard_is_foreign_agent_memory "$rel" "$AGENT"; then
  guard_block "PRD Lead may only write to its own memory directory (.claude/agent-memory/${AGENT}/), not ${rel}."
fi

# --- the allowlist -----------------------------------------------------------

if guard_is_prd "$rel"; then
  guard_allow
fi

if guard_is_epic "$rel"; then
  guard_allow
fi

# Permitted for story product definitions. The acceptance-field prohibition is
# prompt-level; see the LIMITATIONS block above.
if guard_is_story "$rel"; then
  guard_allow
fi

if guard_is_planning "$rel"; then
  guard_allow
fi

if guard_is_own_agent_memory "$rel" "$AGENT"; then
  guard_allow
fi

# --- default deny ------------------------------------------------------------

if guard_is_production "$rel"; then
  guard_block "PRD Lead must not write production source or config (${rel}). Implementation belongs to Builder. Specify the requirement and hand it off."
fi

guard_block "PRD Lead may only write to PRD documents, change notices, epics, stories, planning documents, and its own agent memory. ${rel} is outside all of those, so it is blocked by default."
