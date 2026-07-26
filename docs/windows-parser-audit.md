# Windows parser and path audit

Date: 2026-07-26

The repository's original fixtures came from Claude Code 2.1.220 on macOS.
Decagram Council is now Windows-only, so macOS prose is retained only as a
regression fixture. It is not evidence of the Windows shape.

| Surface | Assessment | Windows handling |
|---|---|---|
| `agents --json --all` roster fields | likely platform-neutral, unverified | Optional-field parser; interactive rows remain non-actionable |
| `backgrounded · <id> · <name>` acknowledgement | likely platform-neutral, unverified | Line-oriented parser; malformed output becomes `CliFailure` |
| job `state.json` | location/content unverified | All fields optional; read best-effort |
| daemon status header (`pid`, `version`, `uptime`) | likely neutral, unverified | Parsed only when recognized |
| daemon transport details | macOS-shaped | `sock dir` and `control.sock` are optional; an unknown Windows form sets `recognized: false` |
| `logs` unknown-session envelope | wording unverified | Only anchored `No job matching` is classified |
| `logs` daemon envelope | wording unverified | Only anchored `Couldn't read logs for <id>` is classified; agent terminal text is otherwise success |
| config/job/team paths | platform-neutral implementation | Every path is built with `node:path`; no hardcoded separator |
| hook `file_path` | Windows-specific | PowerShell guard normalizes slash direction, repeated separators, casing, worktree prefixes, and project membership |
| CLI discovery | Windows-specific | Probes `claude.exe`, `%USERPROFILE%` extension roots, `%LOCALAPPDATA%`, and known install directories |

Until the Windows probe supplies exact fixtures, unrecognized daemon prose is
rendered as **Unknown** with the raw text available in diagnostics. No parser
guesses a named-pipe string.
