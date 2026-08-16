# Windows parser evidence

Current as of 2026-08-16 against Claude Code 2.1.233 on Windows.

| Surface | Evidence | Parser behavior |
|---|---|---|
| `agents --json --all` | Live empty-roster probe plus captured Windows background fixtures | Optional fields; background identity uses `id`, then `sessionId`; cwd is never ownership identity |
| Dispatch acknowledgement | Live `backgrounded · <id> · <name>` probe | Anchored one-line parser; malformed output fails |
| Job `state.json` | Captured Windows-shaped fixture | Every undocumented field remains optional |
| Daemon running/resting | Live cold probe and captured running Windows named-pipe fixture | State, version, worker count, reachability, and raw text retained |
| CLI failures | Live bogus-id evidence and regression tests | Only anchored diagnostic envelopes classify; ordinary logs remain success |
| Daemon stop | Both healthy Windows outcomes captured | Unrecognized/wedged prose is retained; a mentioned PID is surfaced defensively |
| Team config | Existing Windows config field names inspected | Members parse `name`, `agentId`, and optional `agentType` |
| Task files | Blocked by expired Claude login | Best-effort parser stays forward-compatible; no shape is claimed |
