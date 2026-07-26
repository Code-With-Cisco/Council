# Draft upstream report: agent frontmatter hooks did not fire in 2.1.220

Do not file without reproducing on the current Windows build.

## Environment from the original probe

- Claude Code: 2.1.220
- Platform: macOS, darwin-x64
- Date: 2026-07-25

## Expected

The hooks documentation says hooks declared in agent frontmatter fire when the
agent runs as the main session through `--agent` and when it runs as a
subagent.

## Observed

An always-block `PreToolUse` hook on `Read` did not fire on either attachment
path. The read completed. A settings-level hook with the same matcher and
handler fired and blocked correctly.

## Minimal reproduction

1. Create a throwaway agent definition with a `PreToolUse` matcher of `Read`.
2. Point it at a handler that writes a fixed diagnostic to stderr and exits 2.
3. Run the agent as `claude --agent <name>` and ask it to read a known file.
4. Spawn the same definition through the Agent tool and repeat.
5. Move the identical hook to `.claude/settings.json` and repeat as a control.

## Evidence still needed before filing

- Exact Windows and PowerShell versions.
- Current Claude Code version and whether the defect still reproduces.
- Debug log excerpts showing hook discovery and matcher evaluation.
- The complete throwaway agent and handler files.
