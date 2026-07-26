# Agent write guards

`PreToolUse` hooks that enforce the write boundaries the agent definitions
describe. Without these, every boundary in those prompts is advisory — a prompt
asks an agent not to edit the tests; a guard stops it.

Wired from each agent's frontmatter in `.claude/agents/`:

| Agent | Guard | Model |
|---|---|---|
| `builder` | `builder-write-guard.sh` | blocklist — deny listed paths, allow the rest |
| `test-engineer` | `test-engineer-write-guard.sh` | **allowlist** — deny by default |
| `prd-lead` | `prd-lead-write-guard.sh` | **allowlist** — deny by default |
| `reviewer` | *none* | has no write tools; `tools` is `Read, Grep, Glob, SendMessage` |

`_guard-lib.sh` holds the shared payload parsing, path resolution and pattern
groups, so a fix lands in all three gates instead of drifting between them.

## Contract

Each guard reads the `PreToolUse` hook JSON on stdin and extracts
`tool_input.file_path` (the field both `Edit` and `Write` use).

| Exit | Meaning |
|---|---|
| `0` | allow the write |
| `2` | **block**; stderr is fed back to the agent as the reason |

Anything else would be a non-blocking error notice, so these only ever exit 0
or 2.

**They fail closed.** An empty payload, unparseable JSON, a missing
`file_path`, or a path containing `..` all block. A guard that cannot tell what
is being written must not wave it through.

**They see through worktrees.** Background sessions relocate into
`.claude/worktrees/<name>/` before editing, so the same logical file arrives as
`.claude/worktrees/x/src/foo.ts`. That prefix is stripped before matching —
otherwise every pattern silently stops matching at exactly the moment an agent
is doing real work.

## What each guard blocks

### `builder-write-guard.sh`

Builder implements production code for an approved story. It must not be able to
move the goalposts.

Blocked: PRD documents (`docs/prd/**`, `docs/prd.md`), epics (`epics/**`,
`docs/epics/**`), stories (`stories/**`, `docs/stories/**`), any test path
(`test/**`, `*.test.*`, `*fixtures/*`, `scripts/acceptance/**`),
`scripts/gates/**`, agent definitions (`.claude/agents/**`,
`claude-code-agent-pack/**`), and any `.claude/agent-memory/` directory that is
not `builder`'s own.

Allowed: everything else, including `src/**` and production config.

### `test-engineer-write-guard.sh`

Allowlist. Test Engineer produces the authoritative pass/fail evidence, so it
must not be able to make a failing test pass by editing the implementation.

Allowed: test paths, fixtures, `scripts/acceptance/**`, story files (so the
`acceptance` command can be authored), and `.claude/agent-memory/test-engineer/**`.

Blocked: everything else — `src/**`, production config, `migrations/**`,
`deploy/**`, `.github/workflows/**`, PRD documents, epics, gate scripts, agent
definitions, other agents' memory.

### `prd-lead-write-guard.sh`

Allowlist. PRD Lead owns product intent and nothing else.

Allowed: PRD documents, PRD change notices (`docs/prd-changes/**`), epics,
stories, other planning documents (`docs/planning/**`, `docs/decisions/**`,
`docs/adr/**`, `docs/research/**`, `docs/discovery/**`), and
`.claude/agent-memory/prd-lead/**`.

Blocked: everything else — all production source and config, all test paths,
acceptance commands, gate scripts, agent definitions, other agents' memory.

## Limitation: these are path-level gates only

They decide *whether* an agent may write to a file. They cannot see inside it.

Two rules in the agent prompts are therefore **not enforced here and remain
prompt-level**:

- Test Engineer may edit **only** the `acceptance` field of a story's
  frontmatter. The guard allows story writes because authoring that command is
  the agent's job; once allowed, it cannot distinguish an acceptance-field
  change from a rewritten requirement.
- PRD Lead must **never** edit the `acceptance` field. Same shape of gap, in
  the other direction.

Closing both needs a content-level check — for example a `PostToolUse` hook that
diffs story frontmatter and rejects changes outside the field that agent owns.

## Testing a guard manually

Pipe a hook payload in and read the exit code. `$?` is the whole answer.

```bash
export CLAUDE_PROJECT_DIR="$(git rev-parse --show-toplevel)"

# Should ALLOW (exit 0) — production source is Builder's job
printf '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"%s/src/integration/client.ts"}}' "$CLAUDE_PROJECT_DIR" \
  | ./scripts/gates/builder-write-guard.sh; echo "exit=$?"

# Should BLOCK (exit 2) — tests belong to Test Engineer
printf '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"%s/test/parse.test.ts"}}' "$CLAUDE_PROJECT_DIR" \
  | ./scripts/gates/builder-write-guard.sh; echo "exit=$?"

# Should BLOCK (exit 2) — fail closed on an unreadable payload
echo 'not json' | ./scripts/gates/builder-write-guard.sh; echo "exit=$?"

# Should BLOCK (exit 2) — worktree prefix must not launder the path
printf '{"tool_input":{"file_path":"%s/.claude/worktrees/ST-142/test/x.test.ts"}}' "$CLAUDE_PROJECT_DIR" \
  | ./scripts/gates/builder-write-guard.sh; echo "exit=$?"
```

The blocking cases print their reason on stderr; that text is what the agent
receives, so it is written as an instruction to the agent rather than as an
operator log line.

## Notes

- Hook commands use `${CLAUDE_PROJECT_DIR}` rather than a relative path. A
  relative path resolves against the agent's cwd, which is wrong inside a
  worktree.
- These use shell form (`command`, no `args`). If your project path ever
  contains **spaces**, switch each hook entry to exec form — set
  `args: []` alongside `command` — so no shell splits the path.
- `story-gate.sh` / `story-gate.ps1` in this directory are unrelated: they are
  Muster's `TaskCompleted` / `TeammateIdle` acceptance gates, installed
  per-project by the app. Builder is blocked from editing all of it.
- Windows: these are bash. A Windows host needs PowerShell equivalents plus
  `shell: powershell` on each hook entry.
