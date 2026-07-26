#!/usr/bin/env bash
# Agent write-guard dispatcher — PreToolUse hook for Edit|Write.
#
# WHY THIS EXISTS: the guards were originally attached via each agent's
# `hooks` frontmatter, which is the documented mechanism. Verified against
# Claude Code 2.1.220, frontmatter hooks DO NOT FIRE — neither when the agent
# runs as the main session via `--agent`, nor when spawned through the Agent
# tool. A settings-level hook fires correctly. So the guards are registered once
# here, in .claude/settings.json, and this script routes to the right one.
#
# Registered as:
#   PreToolUse -> matcher "Edit|Write" -> this script
#
# ============================== DEFAULT ALLOW ==============================
# A settings-level hook fires for EVERY Edit and Write in the project, including
# the ones a human makes in an ordinary session. So an unrecognised or absent
# `agent_type` MUST be allowed through. Default-deny here would gate the user's
# own work, which is not what any of these guards are for.
#
# The narrower fail-closed rule still applies inside each guard: once a
# restricted agent is identified, an unparseable payload blocks.
# ===========================================================================
#
# Exit 0 = allow, exit 2 = block (stderr becomes the reason shown to the agent).

set -u

GATES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The payload arrives on stdin and has to be forwarded to the chosen guard, so
# read it once and re-emit it rather than letting the child inherit a drained pipe.
PAYLOAD=$(cat)

# `agent_type` carries the agent's frontmatter `name` — confirmed present in the
# PreToolUse payload for both the `--agent` and subagent paths.
AGENT_TYPE=$(
  printf '%s' "$PAYLOAD" |
    sed -n 's/.*"agent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
)

case "$AGENT_TYPE" in
  builder)       GUARD="$GATES_DIR/builder-write-guard.sh" ;;
  test-engineer) GUARD="$GATES_DIR/test-engineer-write-guard.sh" ;;
  prd-lead)      GUARD="$GATES_DIR/prd-lead-write-guard.sh" ;;
  *)
    # Not a guarded agent — a human session, reviewer, a council advisor, or any
    # other agent. Not this dispatcher's business.
    exit 0
    ;;
esac

if [ ! -x "$GUARD" ]; then
  # A guarded agent whose guard is missing must NOT be silently un-gated: that
  # would turn a broken install into an invisible loss of enforcement.
  printf '%s write guard is missing or not executable (%s). Blocking to fail closed — repair the gate scripts before continuing.\n' \
    "$AGENT_TYPE" "$GUARD" >&2
  exit 2
fi

# Forward the original payload and let the guard's exit code and stderr through
# untouched, so the agent sees the specific reason rather than a generic one.
printf '%s' "$PAYLOAD" | "$GUARD"
exit $?
