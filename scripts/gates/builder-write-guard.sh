#!/usr/bin/env bash
# Builder write guard — PreToolUse hook for Edit|Write.
#
# Builder implements production code for an approved story. It must not be able
# to move the goalposts: rewriting the PRD, the epic, the story, the tests, the
# acceptance command, the gates, or another agent's memory would let it make its
# own work pass.
#
# BLOCKS: PRD documents, epics, stories, any test path, scripts/gates/**,
#         agent definitions, and any agent memory that is not builder's own.
# ALLOWS: everything else, including production source and config.
#
# ============================== LIMITATIONS ==============================
# Path-level gate only. It cannot see inside a file, so any rule of the form
# "may change only field X of document Y" is unenforceable here and remains
# prompt-level. See _guard-lib.sh for the full note.
# =========================================================================
#
# Exit 0 = allow, exit 2 = block (stderr becomes the reason shown to the agent).
# Fails closed: an unreadable payload blocks.

set -u

# shellcheck source=_guard-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_guard-lib.sh"

AGENT="builder"
LABEL="Builder"

guard_read_payload
guard_resolve_path "$LABEL"

rel="$GUARD_REL"

if guard_is_prd "$rel"; then
  guard_block "Builder must not edit PRD documents (${rel}). Product intent belongs to PRD Lead. If the PRD is wrong, stop and report it instead of changing it."
fi

if guard_is_epic "$rel"; then
  guard_block "Builder must not edit epic files (${rel}). Epics are owned by PRD Lead."
fi

if guard_is_story "$rel"; then
  guard_block "Builder must not edit story files (${rel}). Stories are owned by PRD Lead, and the acceptance command is owned by Test Engineer. Implement what the story already says, or report that it is wrong."
fi

if guard_is_test "$rel"; then
  guard_block "Builder must not write tests or acceptance commands (${rel}). Tests and acceptance evidence are owned by Test Engineer. Editing them would let the implementation define its own pass condition."
fi

if guard_is_gate_script "$rel"; then
  guard_block "Builder must not modify the gate scripts (${rel}). These enforce the boundaries you operate under."
fi

if guard_is_agent_definition "$rel"; then
  guard_block "Builder must not modify agent definitions (${rel})."
fi

if guard_is_foreign_agent_memory "$rel" "$AGENT"; then
  guard_block "Builder may only write to its own memory directory (.claude/agent-memory/${AGENT}/), not ${rel}."
fi

guard_allow
