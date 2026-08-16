# What needs to be done

Remaining external/manual verification after the 2026-08-16 implementation.
There is no known source-code blocker in this list.

## 1. Refresh the Claude login, then finish live team evidence

The host's Claude Code 2.1.233 installation reports:

```text
Login expired · Please run /login
```

After a human completes `/login`:

- create a disposable experimental agent team and capture a freshly generated
  task file shape;
- run two concurrent sessions and verify whether cross-session `SendMessage`
  works on Windows;
- exercise council-lead live and confirm all five sign-offs plus its one-retry
  failure behavior;
- stop and remove every disposable session/team afterward.

An existing Windows team config was inspected and matches the current parser's
session/member fields, but no fresh task artifact was generated during this run.

## 2. Capture a naturally wedged supervisor response

Healthy `daemon stop` outcomes and safe UI recovery are implemented and tested.
A supervisor that is genuinely unresponsive could not be produced on demand.
When one occurs, capture the exact CLI wording and confirm/tighten the defensive
PID extraction before relying on the displayed `taskkill` fallback.

Do not deliberately corrupt user state merely to manufacture this condition.

## 3. Human Windows installer/UI pass

The combined x64/ARM64 NSIS installer builds, and the unpacked x64 application
has passed an automated launch/responsiveness smoke check. A human should still:

- run the NSIS installer and confirm the per-user directory chooser and desktop
  shortcut;
- inspect layout at 100%, 125%, 150%, and 200% display scaling;
- visually confirm the empty roster, an active background session, a completed
  resumable session, and an explicitly stopped session;
- use the Diagnostics recovery button against a running supervisor and verify
  the displayed result;
- test the ARM64 build on ARM64 Windows hardware.

Signing and distribution credentials were not supplied, so the installer is a
local unsigned review artifact.

## Completed decisions

- Product identity is `com.decagram.council`.
- Reply resumes `done` and `failed`, but not explicitly `stopped`, sessions.
- Decagram Council is Windows-only by default.
- Product-name occurrences use Decagram Council; council feature names and the
  durable `refs/council/...` namespace remain unchanged.
