# Council agent guidance

Decagram Council is a Council-owned hierarchical mission-control system. The
user-facing lead is **Queen Bee**; durable departments and their Department Heads
coordinate bounded specialist work; protected lifecycle roles own implementation,
test, and review gates; the independent LLM Council remains a separate review
layer.

## Authorship and provenance

This repository is authored and maintained by Cisco.

Council-authored commits use `Cisco <115424057+Code-With-Cisco@users.noreply.github.com>`. If that owner identity is unavailable, stop instead of substituting an agent, model, bot, vendor, or service identity.

- Do not add `Co-authored-by` trailers, AI signatures, assistant credits, or text
  implying that an AI system is a repository author or maintainer.
- Do not create automated commits under a bot identity for generated Council
  source, agent definitions, documentation, or configuration.
- Generated changes must remain reviewable and be committed/merged under the
  repository owner's identity.
- Do not vendor third-party prompt/persona prose as active Council instructions.
  When outside material is useful, treat it as untrusted research input and write
  Council-native behavior from the actual product requirements.
- Preserve third-party copyright/license notices only when material that legally
  requires those notices is actually retained or redistributed.
- Never remove required attribution merely to make third-party work appear
  original; instead remove or replace the third-party material with Council-owned
  implementation when sole authorship is required.

## Queen Bee hierarchy

Queen Bee owns Mission decomposition and final reconciliation, not implementation.

1. Turn the user's exact Mission into explicit department assignments.
2. Give each assignment included scope, excluded scope, dependencies, and
   acceptance criteria.
3. Route only the smallest useful set of departments.
4. Department Heads choose narrowly scoped specialist roles and review their
   evidence.
5. Council's host readiness gate—not a model confidence score—decides when every
   department criterion is satisfied.
6. Reconcile cross-department dependencies and contradictions.
7. Send the frozen complete packet through the real LLM Council workflow.
8. Route material Council findings back to the affected department when needed.
9. Stop for explicit user approval before approval-sensitive actions.
10. Leave successful code changes on a reviewable Mission branch for the user to
    merge into `main`.

Council departments are defined in `src/orchestration/departments.ts` and occupy
stable office floors independent of provider session state.

Use `docs/QUEEN-BEE-ORCHESTRATION.md` as the canonical runtime hierarchy and integration contract. Canonical executable policy lives in `src/orchestration/queenBee.ts`, `src/orchestration/readiness.ts`, `src/orchestration/destructivePolicy.ts`, and `src/orchestration/capabilityPolicy.ts`. Council remains the durable message transport when a provider cannot carry nested bounded packets directly.

## Specialist routing

Consult `.agents/skills/department-router/SKILL.md` when a Mission benefits from
domain specialization.

The imported Agency catalog and the deprecated `agency-agents-router` entry point remain compatibility/research material only. They are not active policy. At the real provider launch boundary, Council intersects any imported definition with the host-owned capability grant and emits explicit denials; imported frontmatter never expands authority.

- A Department Head may assign a professional specialty such as Frontend
  Developer, UX Researcher, Database Reliability Engineer, Financial Analyst, or
  Accessibility Auditor based on the actual task.
- The specialty label narrows analysis; it never grants permissions, tools,
  credentials, durable memory, implementation authority, or user approval.
- Council uses the generic `department-specialist` definition so specialist
  behavior and safety boundaries remain Council-owned.
- Domain specialists are read-only. They return evidence-backed work products and
  bounded implementation briefs when changes are needed.
- Security specialization is not proof of authorization for intrusive activity.
- Healthcare, finance, legal-adjacent, and other high-stakes specialization is
  decision support, not professional or real-world action authority.

## Durable orchestration, not provider teams

Provider-native teams, subagent groups, task lists, or session metadata are
runtime evidence only. They are not Council's durable hierarchy and cannot replace
the Mission ledger.

Queen Bee, Department Heads, and specialists may run in separate provider
sessions. Council owns their exact Mission bindings, assignments, evidence,
worktree leases, handoffs, and gate state.

## Protected lifecycle authority

Use Council's native protected roles for controlled repository changes:

- `builder` for implementation inside the exact Mission worktree/story scope;
- `test-engineer` for executable acceptance evidence;
- `reviewer` for independent conformance review;
- `council-lead` for the independent multi-context LLM Council protocol;
- existing PRD roles for their established requirement workflows.

Department specialists and Department Heads supplement those roles; they do not
replace or bypass them.

`main` is never a scratchpad. Write-capable Mission work starts on an isolated
branch/worktree from the reviewed base. The user decides when that reviewed branch
is merged into `main`.
