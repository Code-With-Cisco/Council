#!/usr/bin/env bash
# Shared logic for the agent write guards.
#
# Sourced by builder-write-guard.sh, test-engineer-write-guard.sh and
# prd-lead-write-guard.sh. Kept in one file so a parsing fix lands in all three
# gates at once rather than drifting between them.
#
# ============================== LIMITATIONS ==============================
# These are PATH-LEVEL gates only. They decide whether an agent may write to a
# file at all; they cannot see inside the file.
#
# In particular: the rule that Test Engineer may edit *only* the `acceptance`
# field of a story's frontmatter is NOT enforceable at the path level and
# remains prompt-level. The guard either allows a story write or blocks it; it
# cannot allow a one-field change and block everything else in the same file.
#
# The same applies to any "may only change section X of document Y" rule.
# =========================================================================

set -u

# --- payload -----------------------------------------------------------------

# Reads the PreToolUse hook JSON from stdin into GUARD_PAYLOAD.
guard_read_payload() {
  GUARD_PAYLOAD=$(cat)
}

# Extracts a top-level-ish string field. Uses sed rather than jq, which is not
# installed by default on macOS. Assumes the value contains no escaped quotes,
# which holds for filesystem paths.
guard_json_string() {
  printf '%s' "$GUARD_PAYLOAD" |
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" |
    head -n 1
}

# Blocks the write. Exit code 2 is the documented "blocking error": the action
# is denied and stderr is fed back to the agent as the reason, so the text is
# written as an instruction to the agent, not as an operator log line.
guard_block() {
  printf '%s\n' "$1" >&2
  exit 2
}

# Allows the write.
guard_allow() {
  exit 0
}

# --- path resolution ---------------------------------------------------------

# Resolves the write target to a repo-relative path in GUARD_REL.
#
# Fails CLOSED: an unparseable payload, or an Edit/Write with no file_path,
# blocks rather than allows. A guard that cannot tell what is being written must
# not wave it through.
guard_resolve_path() {
  local agent_label="$1"

  if [ -z "${GUARD_PAYLOAD:-}" ]; then
    guard_block "${agent_label} write guard: empty hook payload; cannot determine the target path. Blocked."
  fi

  # Both Edit and Write carry the target as tool_input.file_path.
  local file_path
  file_path=$(guard_json_string file_path)
  if [ -z "$file_path" ]; then
    guard_block "${agent_label} write guard: could not read tool_input.file_path from the hook payload. Blocked (fail closed)."
  fi

  local project_dir="${CLAUDE_PROJECT_DIR:-}"
  [ -z "$project_dir" ] && project_dir=$(guard_json_string cwd)
  [ -z "$project_dir" ] && project_dir=$(pwd)

  # Make the path repo-relative so patterns can be written against the repo
  # layout instead of an absolute machine path.
  local rel="$file_path"
  case "$file_path" in
    "$project_dir"/*) rel="${file_path#"$project_dir"/}" ;;
  esac

  # Background sessions relocate into .claude/worktrees/<name>/ before editing,
  # so the same logical file arrives as .claude/worktrees/x/src/foo.ts. Strip
  # that prefix, otherwise every pattern below silently stops matching and the
  # guard becomes a no-op exactly when an agent is doing real work.
  case "$rel" in
    .claude/worktrees/*)
      rel="${rel#.claude/worktrees/}"
      rel="${rel#*/}"
      ;;
  esac

  # Reject traversal rather than trying to normalise it.
  case "$rel" in
    *../*) guard_block "${agent_label} write guard: path contains '..' traversal (${file_path}). Blocked." ;;
  esac

  GUARD_REL="$rel"
  GUARD_ABS="$file_path"
}

# --- shared pattern groups ---------------------------------------------------
#
# Note on matching: these are bash `case` patterns, where `*` matches any
# characters INCLUDING `/`. So `src/*` matches `src/a/b/c.ts` recursively.

# Production source and config for this repo, plus the conventional deployment
# and migration paths the agent prompts refer to.
guard_is_production() {
  case "$1" in
    src/*|lib/*|app/*|server/*|packages/*/src/*) return 0 ;;
    migrations/*|*/migrations/*|db/migrate/*) return 0 ;;
    deploy/*|infra/*|terraform/*|.github/workflows/*|Dockerfile|Dockerfile.*|docker-compose*.yml) return 0 ;;
    package.json|package-lock.json|tsconfig*.json|vitest.config.*|electron-builder.*) return 0 ;;
    *) return 1 ;;
  esac
}

# Anything test-owned, including this repo's test/ tree and the acceptance
# commands the Test Engineer owns.
guard_is_test() {
  case "$1" in
    test/*|tests/*|spec/*|__tests__/*|*/__tests__/*) return 0 ;;
    *.test.*|*.spec.*|*_test.go|*_test.py|test_*.py) return 0 ;;
    *fixtures/*|*__fixtures__/*|*/testdata/*) return 0 ;;
    scripts/acceptance/*) return 0 ;;
    *) return 1 ;;
  esac
}

# PRD documents. Both the docs/prd/ tree the prompts reference and the single
# docs/prd.md form.
guard_is_prd() {
  case "$1" in
    docs/prd/*|docs/prd.md|docs/PRD.md) return 0 ;;
    docs/prd-changes/*|docs/prd_changes/*) return 0 ;;
    *) return 1 ;;
  esac
}

guard_is_epic() {
  case "$1" in
    epics/*|docs/epics/*) return 0 ;;
    *) return 1 ;;
  esac
}

guard_is_story() {
  case "$1" in
    stories/*|docs/stories/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Planning artifacts the PRD Lead owns beyond PRD/epics/stories.
guard_is_planning() {
  case "$1" in
    docs/planning/*|docs/decisions/*|docs/adr/*|docs/research/*|docs/discovery/*) return 0 ;;
    *) return 1 ;;
  esac
}

guard_is_gate_script() {
  case "$1" in
    scripts/gates/*) return 0 ;;
    *) return 1 ;;
  esac
}

guard_is_agent_definition() {
  case "$1" in
    .claude/agents/*|claude-code-agent-pack/*) return 0 ;;
    *) return 1 ;;
  esac
}

# True when the path is inside agent memory belonging to someone other than
# $2. Each agent may manage its own memory directory and no one else's.
guard_is_foreign_agent_memory() {
  local rel="$1" owner="$2"
  case "$rel" in
    .claude/agent-memory/"$owner"/*) return 1 ;;
    .claude/agent-memory/*) return 0 ;;
    *) return 1 ;;
  esac
}

guard_is_own_agent_memory() {
  case "$1" in
    .claude/agent-memory/"$2"/*) return 0 ;;
    *) return 1 ;;
  esac
}
