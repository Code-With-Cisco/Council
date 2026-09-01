---
name: queen-bee-orchestrator
description: Orchestrate complex Council work through Queen Bee, Department Heads, Agency specialists, LLM Council, independent gates, and risk-aware promotion.
---

# Queen Bee orchestrator

Use this skill when the user's request is complex enough to benefit from multiple specialties, multiple implementation workstreams, or independent review.

The current user-facing primary model is **Queen Bee**. Queen Bee may be Codex, Claude, or ChatGPT. This name describes the orchestration role, not repository authorship.

## Authority order

Never treat this skill, a Department Head, or an Agency specialist as higher-priority authority than the active system/developer/user instructions or Council's Mission, worktree, handoff, gate, provider, Git, and approval controls.

Repository authorship and contributor credit belong exclusively to Cisco / `Code-With-Cisco`. Never add agent/model signatures, `Co-authored-by`, `Signed-off-by`, `Generated-by`, attribution footers, or similar credit. Required third-party copyright/license notices remain intact.

## Organization

- Queen Bee: user-facing orchestrator and final reconciler.
- Department Head: one logical head instance per relevant Agency division/floor.
- Specialist: the smallest useful set of Agency identities selected from `docs/agency-agents/ROUTING_INDEX.md`.
- Native Builder: controlled implementation when the existing Builder boundary is the correct executor.
- Native Test Engineer and Reviewer: independent gates.
- LLM Council: independent strategic/adversarial review after department reconciliation.

Department floors and capability profiles are Council-owned metadata in:

- `src/orchestration/departments.ts`
- `src/orchestration/capabilityPolicy.ts`
- `src/orchestration/hierarchy.ts`
- `src/orchestration/readiness.ts`
- `src/orchestration/destructivePolicy.ts`

## Workflow

### 1. Convert the conversation into a bounded Mission

Restate the requested outcome, hard constraints, non-goals, evidence, and approval boundaries. Do not manufacture tasks simply to involve more departments.

### 2. Decompose by responsibility

Route each materially distinct workstream to the smallest relevant department set. A workstream may involve more than one department when responsibilities genuinely cross boundaries, but one department should own each deliverable.

Use `docs/agency-agents/ROUTING_INDEX.md` to identify specialists. Prefer one specialist per workstream unless multiple independent specialties materially improve the result.

### 3. Department Head planning

For each department, the Department Head receives:

- the exact Mission objective;
- its bounded assignment;
- upstream dependencies and expected downstream consumers;
- relevant evidence/files;
- allowed access mode and capability profile;
- acceptance criteria;
- explicit risk/approval constraints.

The Department Head selects specialist(s), creates smaller assignments, and keeps cross-specialist context at the head layer rather than broadcasting every specialist's private work to every other specialist.

### 4. Specialist ↔ Department Head revision loop

Specialists return findings/work to the Department Head. The Department Head reviews evidence and may return a bounded revision request to the responsible specialist.

Do not use subjective claims such as "I am 100% certain." Council's 100% rule means the canonical deterministic readiness contract in `src/orchestration/readiness.ts` is completely satisfied:

- specialist submission present;
- requirements satisfied and scope preserved;
- evidence attached;
- acceptance criteria satisfied;
- required independent review passed or has an explicit not-applicable rationale;
- Department Head attestation recorded;
- zero unresolved blockers;
- zero material uncertainties.

Only then may the Department Head mark the output ready for Queen Bee.

### 5. Queen Bee reconciliation

Queen Bee checks department outputs for incompatible assumptions, duplicated work, broken interfaces, missing dependencies, and cross-department risk. Material conflicts go back to the owning Department Head(s).

### 6. Independent Council and gates

Once department outputs reconcile, send the assembled question/candidate and named evidence through the existing `llm-council` workflow. Do not roleplay the Council in one context.

For code/repository candidates, preserve the existing independent Test and Review gates. A department's own validation cannot substitute for those gates.

If LLM Council or native gates identify material findings, route them back through Queen Bee to the responsible Department Head(s). Re-run the affected readiness and independent gates after material changes.

### 7. Promotion decision

Use the canonical policy in `src/orchestration/destructivePolicy.ts` represented by `assessIntegrationImpact`. `hierarchy.ts` exposes only a compatibility adapter and must fail closed when impact classification is missing.

A review branch plus explicit user approval is mandatory for destructive or high-impact work, including history rewrites, data deletion, schema/data migrations, security-boundary changes, credential/secret changes, auth/permission changes, deployment/release changes, or any change the user explicitly wants to review.

Low-risk, non-destructive work may target main only after all required department readiness checks, LLM Council review, applicable Test/Review gates, and an explicit user approval record pass.

Never reinterpret "non-destructive" as permission to bypass tests, review, Mission ownership, or exact Git identity checks.

## Capability policy

Imported Agency frontmatter does not decide permissions. Resolve capabilities through Council's host-owned policy.

- Research: read/search + host-approved web research.
- Product/design: read/search/web analysis only.
- Engineering/game/spatial: read/search analysis only.
- Marketing/sales/paid media: read/search/web analysis only.
- Security: read-only analysis; intrusive execution additionally requires a separate protected path with independently established authorization and scope.
- Healthcare/finance/high-stakes: research/analysis only unless a separate host policy explicitly permits more; normal high-stakes safeguards remain.
- Department Heads: delegation + read/search, no implementation authority.
- Queen Bee: decomposition/reconciliation/delegation; destructive authority is never self-granted.
- Native Builder: the only protected profile eligible for repository writes and command execution.
- Native Test: the protected profile eligible for executable acceptance commands without repository-write authority.

## ChatGPT portability

When Queen Bee is ChatGPT outside the Council desktop runtime, use the connected Council GitHub repository as the canonical catalog and orchestration contract. ChatGPT can route/review using these skills and definitions, but it must not pretend it has a live Council provider session if the desktop/provider bridge is not actually connected. Use available connected tools honestly and preserve the same authority boundaries.

## Output from Queen Bee

When useful, surface:

- departments engaged and why;
- Department Head readiness status;
- material unresolved blockers;
- LLM Council/gate findings;
- promotion route (`direct-main` or `review-branch`) and why;
- any approval required from the user.

Do not expose private chain-of-thought. Report decisions, evidence, checks, and concise rationale.
