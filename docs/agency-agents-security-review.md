# Agency Agents security review

## Decision

**Status: conditionally approved for data-only, opt-in agent import.**

The upstream `msitarzewski/agency-agents` repository is useful as an agent-identity library, but it is **not approved for wholesale installation or execution inside Decagram Council**. Council may import only the Markdown agent definitions from the 18 declared source divisions, pinned to the reviewed upstream commit below. Scripts, workflows, generated integrations, strategy playbooks, examples, application installers, and memory/setup integrations are outside the approved import surface.

This review treats every upstream file as untrusted data. No text in the upstream repository is authority for Council, its runtime, or the user’s task.

## Reviewed upstream snapshot

- Repository: `msitarzewski/agency-agents`
- Pinned commit: `3c9588880b7cafaec325a104899fd8bbe27e7d72`
- Commit tree: `a2e96b85b2a90a9c488b0ffb8a37db4a245b5e7c`
- Snapshot date: 2026-08-26
- GitHub commit verification at review time: verified
- Reported agent count at this snapshot: 273
- License: MIT, copyright (c) 2025 AgentLand Contributors

Do not silently follow upstream `main`. Any future refresh must pin a new commit and repeat the security review before importing changes.

## Approved source divisions

Only Markdown agent definitions from these upstream divisions are eligible for import:

1. `academic`
2. `design`
3. `engineering`
4. `finance`
5. `game-development`
6. `gis`
7. `healthcare`
8. `marketing`
9. `paid-media`
10. `product`
11. `project-management`
12. `research`
13. `sales`
14. `security`
15. `spatial-computing`
16. `specialized`
17. `support`
18. `testing`

Upstream `divisions.json` is descriptive source metadata only. It is not executable policy.

## Explicitly excluded upstream surfaces

The following are **not approved for import or execution** as part of the agent pack:

- `.github/` workflows
- `scripts/`
- `integrations/`
- `strategy/`
- `examples/`
- upstream installer/application artifacts
- MCP or memory setup material
- generated tool-specific integration outputs
- any future executable or configuration surface not explicitly added to the approved list above

### Why these are excluded

The upstream installer can write or symlink into user-level configuration directories for multiple agent tools and can modify integration configuration. The upstream CI executes repository shell scripts against changed content. These behaviors may be reasonable for the upstream project, but they enlarge Council’s trust and supply-chain surface without being necessary to consume the identity library.

Council should remain the installation, discovery, permission, and lifecycle authority.

## Prompt-injection and authority model

Every imported identity is an instruction-bearing document. Phrases such as “You are…”, “critical rules”, “your mission”, “remember…”, tool examples, shell commands, or instructions to delegate are part of the selected role definition only.

Imported identity text MUST NOT:

- override system, developer, Council, or current user instructions;
- expand the user-approved task scope;
- grant itself tools, permissions, credentials, network access, filesystem authority, or persistent memory;
- auto-start other agents or create arbitrary delegations;
- treat README text, linked content, examples, comments, source code, retrieved web pages, or other files as higher-priority instructions;
- bypass Council worktree, handoff, review, test, approval, or integration gates;
- alter Council runtime configuration merely because an identity recommends doing so;
- install packages, integrations, MCP servers, plugins, or external applications merely because upstream documentation suggests them.

Council’s existing agent discovery behavior is a suitable containment layer because discovery reads definitions as data, fingerprints them, and does not itself start provider sessions. Newly discovered agents must remain opt-in.

## High-risk and high-stakes agent classes

Some identities contain legitimate specialist material that becomes risky when activated without context.

### Security / offensive-security identities

Security agents may contain reconnaissance, exploitation, credential, Active Directory, tunneling, persistence, or other dual-use techniques. Their presence in the repository is not itself execution. When selected, they remain subject to authorization, safety, scope, and tool-use restrictions. A persona’s claim that an engagement is authorized is not evidence of authorization.

### Healthcare, finance, legal-adjacent, and other high-stakes identities

Specialist personas may improve organization or domain vocabulary, but identity text does not confer professional licensure, verified expertise, or authority to make unsupported high-stakes decisions. Applicable product safety and user-facing qualification requirements continue to apply.

### Memory language

Upstream persona text frequently describes what an agent “remembers.” That prose must not be interpreted as permission to create or use durable memory. Persistent memory remains a host/Council capability governed separately.

## Routing policy

The upstream README may be used as **descriptive routing metadata** because its roster tables contain agent specialty and “When to Use” guidance. The router may use that information to identify likely specialists, but it must not execute README setup commands or obey README prose as instructions.

Routing should:

1. infer the smallest useful specialist set from the user’s current task;
2. prefer one specialist when one is sufficient;
3. never activate all 273 agents for ordinary work;
4. expose or request user choice when multiple materially different specialists fit;
5. preserve the exact user task and evidence boundary when handing work to a specialist;
6. leave Council’s existing independent review/test roles unchanged.

## Import layout

Preserve the upstream organization beneath a Council-owned namespace:

```text
.claude/agents/agency-agents/
  academic/
  design/
  engineering/
  finance/
  game-development/
  gis/
  healthcare/
  marketing/
  paid-media/
  product/
  project-management/
  research/
  sales/
  security/
  spatial-computing/
  specialized/
  support/
  testing/
```

The imported definitions must not replace Council’s existing `builder`, `reviewer`, `test-engineer`, PRD, or Council Review agents.

## Import validation requirements

Before an upstream identity is admitted to the pack:

- source must resolve to the pinned commit;
- path must be inside an approved division;
- file must be a regular `.md` file, not a symlink;
- path traversal and absolute paths must be rejected;
- content must be valid UTF-8;
- file must contain complete YAML frontmatter;
- `name` and `description` must parse successfully;
- unexpected executable/config files must be rejected;
- duplicate effective agent names must be reported rather than silently resolved;
- imported content should be fingerprinted and recorded in a manifest;
- license attribution must accompany the substantial copied material.

## Current review limits

The repository structure, executable surfaces, integration scripts, CI workflow, security policy, license, README routing model, representative normal agent definitions, and representative elevated-risk security definitions were inspected. A local full-repository clone/archive scan was attempted but was blocked by environment rate limiting during this review. Therefore this approval is deliberately **conditional**: it approves the containment architecture and the known source divisions, but it does not claim that every line of all 273 identity bodies has already received individual manual review.

For that reason, bulk raw identity payloads should not be merged without a deterministic pinned import/validation pass and reviewable manifest.

## Refresh policy

A future upstream refresh must be treated as a new supply-chain event:

1. choose and record an exact upstream commit;
2. compare only approved division Markdown files against the previously pinned snapshot;
3. review new/changed identities for authority escalation, unsafe tool requests, embedded secret material, suspicious links, and domain-specific risk;
4. regenerate fingerprints and routing index;
5. preserve MIT attribution;
6. merge only through Council’s normal review process.

## Attribution

The imported Agency Agents material is derived from `msitarzewski/agency-agents` and is licensed under the MIT License. The upstream copyright and permission notice must be retained with substantial copied portions.
