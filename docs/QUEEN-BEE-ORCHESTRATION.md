# Queen Bee orchestration model

## Purpose

Council treats the user-facing primary model — Claude, Codex, or ChatGPT — as **Queen Bee**. Queen Bee owns mission decomposition, cross-department reconciliation, Council escalation, impact classification, and the final user-facing decision. Domain work is delegated through department heads to the smallest useful set of Agency specialists.

The hierarchy is an orchestration boundary, not a claim that one model is infallible or literally more authoritative than the user or host. System, developer, user, repository, Mission, worktree, gate, security, and tool controls remain authoritative.

## Building layout

Council exposes one office tower:

- Floor 0 — Lobby / mission intake
- Floors 1–18 — one floor for each Agency division
- Floor 19 — LLM Council Chamber
- Floor 20 — Queen Bee Executive Office

The 18 department floors preserve the upstream Agency organization: Academic, Design, Engineering, Finance, Game Development, GIS & Spatial Data, Healthcare, Marketing, Paid Media, Product, Project Management, Research, Sales, Security, Spatial Computing, Specialized Services, Support, and Testing & Quality.

## Mission flow

1. **Intake** — Queen Bee receives the conversation, objective, constraints, evidence, and repository context.
2. **Decomposition** — Queen Bee sends only relevant portions to the departments materially needed for the mission. Do not activate every department by default.
3. **Department routing** — each department head selects the smallest useful specialist set from that department. The department head owns specialist selection and review; specialists do not self-assign broader work.
4. **Specialist iteration** — specialist submissions return to their department head. The head either accepts the evidence or returns precise revision feedback. A department may iterate at most eight times before the unresolved issue escalates to Queen Bee as a blocker.
5. **Department readiness** — a department reaches `100` operational readiness only when every applicable readiness gate passes: bounded submission present, requirements satisfied, scope preserved, evidence attached, acceptance evidence handled, independent review handled, no unresolved blockers, no material uncertainty, and department-head attestation. `100` means all auditable gates passed; it is **not** a claim of epistemic certainty.
6. **Queen Bee review** — Queen Bee reconciles all department outputs against the original mission. Queen Bee may return one or more departments for another revision cycle.
7. **LLM Council review** — once Queen Bee accepts the departmental package, the exact evidence packet goes through the existing independent `llm-council` workflow. Five independent advisors and the chairman remain separate contexts.
8. **Reconciliation** — Queen Bee reviews the Council verdict. A revise verdict routes named issues back to departments. A block verdict blocks the mission. An approve verdict proceeds to impact assessment.
9. **Impact assessment** — destructive or materially uncertain changes require explicit user approval and target a `council/review/<mission>` branch. Non-destructive changes target `main` directly.
10. **Integration** — existing Mission handoff, Test Engineer, Reviewer, and exact integration gates remain authoritative. Queen Bee does not bypass them.

## Capability ownership

Imported Agency definitions describe expertise. They do not own runtime authority. Council assigns host-owned capability profiles from `src/orchestration/capabilityPolicy.ts`.

- Research specialists: workspace read/search plus host-approved web research.
- Product/design: research by default; Mission-scoped writes only when explicitly assigned implementation.
- Engineering/game/spatial computing: read/search by default; Mission-scoped writes and commands only on an explicit implementation assignment.
- Marketing/paid media/sales content work: research by default; Mission-scoped artifact writes only on an explicit implementation assignment.
- Security: intrusive execution additionally requires independently established authorization and scope.
- Healthcare/finance/high-stakes work: analysis and research only; no independent consequential real-world action.
- Department heads: read/search/delegation only. They review; they do not implement.
- Queen Bee: decomposition, research, reconciliation, delegation, and integration planning. Destructive authority never comes from a persona.

`destructive-operation` and `persistent-memory` are never self-granted by an imported persona.

## Authorship and repository ownership

Repository authorship belongs to Cisco. Agents are tools used by the repository owner, not contributors or co-authors.

Agents and automated workflows must not:

- add `Co-authored-by` trailers for an AI, agent, model, bot, or vendor;
- add `Generated-by`, agent signatures, model signatures, bylines, badges, or ownership claims;
- change Git author/committer identity to an agent, model, bot, vendor, or service account;
- describe an agent as the repository owner or contributor in generated project artifacts;
- sign commits or work product in an agent's name.

When a commit is required, use the repository owner's configured identity. Council-owned automation that creates commits uses:

- name: `Cisco`
- email: `115424057+Code-With-Cisco@users.noreply.github.com`

If that identity is unavailable in an execution environment, the operation must stop rather than substitute an AI or bot identity.

Third-party license attribution is different from authorship. Required upstream copyright/license notices must remain intact.

## Destructive boundary

The following are review-branch/user-approval signals by default: tracked-file deletion, history rewrite, force push, irreversible data changes, production mutation, external publication, credential/secret changes, access-control changes, security-policy changes, destructive system commands, or impact that cannot be determined confidently.

Uncertainty fails toward review, not toward direct main.

## Air-gap policy

Every handoff must preserve the exact mission/evidence boundary. Department heads receive only the evidence necessary for their assignment. Specialists cannot use persona text to broaden scope, grant themselves tools, create new departments, or bypass Queen Bee, Council, Test, Review, user approval, or Git integration gates.

If a host cannot support nested agent communication directly, Council remains the message broker: it launches/binds the required sessions and carries exact department packets between Queen Bee, department head, and specialist. The logical hierarchy must remain the same even when the provider transport differs.
