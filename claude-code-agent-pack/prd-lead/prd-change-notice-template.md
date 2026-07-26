---
id: "PRD-CHANGE-YYYY-MM-DD-short-id"
prd: "docs/prd/product-name.md"
status: active
classification: modifying
approved_by: ""
approved_at: ""
sections_changed: []
epics_affected: []
stories_affected: []
---

# PRD Change Notice: <short title>

## 1. Change summary

- **Change ID:** `PRD-CHANGE-YYYY-MM-DD-short-id`
- **PRD:** `docs/prd/product-name.md`
- **Approval provenance:** `<user or named authority>`
- **Classification:** `CLARIFICATION | ADDITIVE | MODIFYING | REMOVING |
  RENUMBERING | SUPERSEDING | ARCHITECTURE-IMPACTING`
- **Blocking:** `yes | no`

## 2. Before and after

### Previous behavior

<Concise statement of the superseded requirement.>

### Current behavior

<Concise statement of the approved requirement.>

### Reason

<Why the requirement changed.>

## 3. PRD sections changed

- `PRD §<number>` — `<summary>`
- Replacement or supersession mapping: `<old> -> <new or none>`

## 4. Impact map

### Epics

| Epic | Impact | Required update | State |
|---|---|---|---|
| `<EP-ID>` | `<scope/dependency/outcome>` | `<action>` | `<pending/done>` |

### Stories

| Story | Impact | Required update | Build state |
|---|---|---|---|
| `<ST-ID>` | `<scope/ref/dependency>` | `<action>` | `<blocked/ready/replaced>` |

### Prior artifacts made stale

- Acceptance commands:
- Test evidence:
- Reviewer verdicts:
- Builder plans or active work:
- Architecture decisions:
- Research findings:

### Unaffected references checked

- `<reference>` — `<why unaffected>`

## 5. Files updated

- PRD:
- Decision register:
- Epics:
- Stories:
- Other planning documents:

## 6. Agent dispatch

### Architect

- **Stop current work:** `yes | no`
- **Action required:**
- **Evidence that closes action:**
- **Notification status:** `sent | pending | not applicable`

### Builder

- **Stop current work:** `yes | no`
- **Affected stories:**
- **Action required:**
- **Resume condition:**
- **Notification status:** `sent | pending | not applicable`

### Test Engineer

- **Affected stories:**
- **Action required:**
- **Acceptance evidence invalidated:**
- **Evidence that closes action:**
- **Notification status:** `sent | pending | not applicable`

### Reviewer

- **Prior verdicts invalidated:**
- **Fresh review required for:**
- **Evidence that closes action:**
- **Notification status:** `sent | pending | not applicable`

### Researcher

- **Research assumptions affected:**
- **Action required:**
- **Evidence that closes action:**
- **Notification status:** `sent | pending | not applicable`

## 7. Migration and rollout impact

- Data migration:
- Compatibility:
- Rollout:
- Backfill:
- User communication:
- Reversal or recovery:

## 8. Unresolved questions

- `<owner>` — `<question>` — `<blocking yes/no>`

## 9. Completion checklist

- [ ] Change is explicitly approved.
- [ ] Decision register is updated.
- [ ] All affected PRD sections are updated.
- [ ] Every affected epic is updated or confirmed unaffected.
- [ ] Every affected story is updated, replaced, or confirmed unaffected.
- [ ] Impacted stories are blocked pending required revalidation.
- [ ] Executable acceptance fields were not edited by PRD Lead.
- [ ] Test Engineer was notified where acceptance may be stale.
- [ ] Builder was told whether to stop or resume.
- [ ] Reviewer was told which verdicts are stale.
- [ ] Architect impact was resolved or dispatched.
- [ ] Research impact was resolved or dispatched.
- [ ] References resolve and no duplicate section numbers exist.
- [ ] Direct notifications were sent, or the lead received an honest dispatch
      list.
- [ ] All required downstream actions are complete or explicitly waived.

## 10. Closure

- **Status:** `active | completed | waived`
- **Closed by:**
- **Closed at:**
- **Waivers and authority:**
