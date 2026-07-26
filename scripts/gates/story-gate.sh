#!/usr/bin/env bash
# Muster story gate — bash dialect (macOS, Linux).
#
# Installed per-project by Muster into <project>/.claude/hooks/ and wired to the
# TaskCompleted and TeammateIdle hook events.
#
# It blocks completion when a story is not actually done:
#   * the story's frontmatter has no `prd_ref` (no traceability to the PRD), or
#   * the story's `acceptance` command exits nonzero.
#
# Exit code contract (from the hooks reference):
#   0  no opinion, carry on
#   2  BLOCK; stderr is fed back to Claude as the reason
# Any other code is a non-blocking error notice, which is why every internal
# failure below deliberately exits 0: a broken gate must not wedge the squad.
#
# Usage: story-gate.sh <TaskCompleted|TeammateIdle>   (payload on stdin)

set -u

EVENT="${1:-}"
[ -z "$EVENT" ] && exit 0

PAYLOAD=$(cat)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi
[ -z "$PROJECT_DIR" ] && PROJECT_DIR=$(pwd)

STORIES_DIR="$PROJECT_DIR/stories"
[ -d "$STORIES_DIR" ] || exit 0   # Not a pipeline project; nothing to gate.

# --- payload fields -----------------------------------------------------------
# Extracted with sed rather than jq, which is not installed by default on macOS.
# Assumes these values contain no escaped quotes, which holds for task names and
# teammate names in practice.
json_string() {
  printf '%s' "$PAYLOAD" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

TASK_NAME=$(json_string task_name)
TASK_ID=$(json_string task_id)
TEAMMATE=$(json_string teammate_name)

# --- frontmatter reader -------------------------------------------------------
# Prints the value of a key from the leading `---` fenced YAML block.
frontmatter_value() {
  awk -v key="$2" '
    NR == 1 && $0 !~ /^---[[:space:]]*$/ { exit }
    NR == 1 { next }
    /^---[[:space:]]*$/ { exit }
    {
      line = $0
      idx = index(line, ":")
      if (idx == 0) next
      k = substr(line, 1, idx - 1)
      v = substr(line, idx + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^"|"$/, "", v)
      gsub(/^'"'"'|'"'"'$/, "", v)
      if (k == key) { print v; exit }
    }
  ' "$1"
}

# --- story selection ----------------------------------------------------------
# A story matches when its `id` or its filename stem appears in the task name or
# task id. Tasks that map to no story are not gated: not every task is a story.
matching_stories() {
  local found=0
  for story in "$STORIES_DIR"/*.md; do
    [ -e "$story" ] || continue
    local stem id
    stem=$(basename "$story" .md)
    id=$(frontmatter_value "$story" id)
    [ -z "$id" ] && id="$stem"

    case "$TASK_NAME$TASK_ID" in
      *"$id"*|*"$stem"*)
        printf '%s\n' "$story"
        found=1
        ;;
    esac
  done
  return $((1 - found))
}

# On TeammateIdle there is no task to key off, so every story the squad has
# marked finished is re-checked. That is the point of the event: it fires as a
# teammate is about to go idle, which is the last moment to catch a story that
# was marked done without passing its own acceptance check.
finished_stories() {
  for story in "$STORIES_DIR"/*.md; do
    [ -e "$story" ] || continue
    local status
    status=$(frontmatter_value "$story" status)
    case "$status" in
      done|Done|DONE|complete|completed|review|Review) printf '%s\n' "$story" ;;
    esac
  done
}

# --- the gate itself ----------------------------------------------------------
FAILURES=""

check_story() {
  local story="$1"
  local name prd_ref acceptance output code
  name=$(basename "$story")

  prd_ref=$(frontmatter_value "$story" prd_ref)
  if [ -z "$prd_ref" ]; then
    FAILURES="${FAILURES}
  - ${name}: missing 'prd_ref' in frontmatter. Every story must trace to a section of docs/prd.md."
    return
  fi

  acceptance=$(frontmatter_value "$story" acceptance)
  if [ -z "$acceptance" ]; then
    FAILURES="${FAILURES}
  - ${name}: missing 'acceptance' in frontmatter. Add a command that exits 0 when the story is genuinely done."
    return
  fi

  # Run from the project root so acceptance commands can use relative paths.
  output=$(cd "$PROJECT_DIR" && sh -c "$acceptance" 2>&1)
  code=$?
  if [ $code -ne 0 ]; then
    FAILURES="${FAILURES}
  - ${name}: acceptance command failed (exit ${code})
      \$ ${acceptance}
$(printf '%s' "$output" | tail -n 20 | sed 's/^/      /')"
  fi
}

case "$EVENT" in
  TaskCompleted)
    STORIES=$(matching_stories) || exit 0
    ;;
  TeammateIdle)
    STORIES=$(finished_stories)
    ;;
  *)
    exit 0
    ;;
esac

[ -z "$STORIES" ] && exit 0

while IFS= read -r story; do
  [ -n "$story" ] && check_story "$story"
done <<EOF
$STORIES
EOF

if [ -n "$FAILURES" ]; then
  # stderr on exit 2 becomes the reason Claude sees, so it is written as
  # instructions to the agent rather than as an operator log line.
  {
    if [ "$EVENT" = "TeammateIdle" ]; then
      printf 'Not finished yet%s. Stories marked complete are still failing their gates:\n' \
        "${TEAMMATE:+ ($TEAMMATE)}"
    else
      printf 'Cannot mark "%s" complete. Its story does not pass the gate:\n' "${TASK_NAME:-this task}"
    fi
    printf '%s\n\n' "$FAILURES"
    printf 'Fix the underlying problem and re-check. Do not edit the acceptance command to make it pass.\n'
  } >&2
  exit 2
fi

exit 0
