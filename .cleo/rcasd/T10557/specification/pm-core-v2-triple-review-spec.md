---
task: T10557
parent: T10539
saga: T10538 (SG-PM-CORE-V2)
type: specification
status: accepted
date: 2026-05-25
evidence: .cleo/rcasd/T10557/test-runs/t10557-pm-core-v2-triple-review.vitest.json
accepted_decision_docs:
  - docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md
  - docs/research/t10550-docs-ssot-inventory-and-contradiction-matrix.md
---

# T10557 PM-Core V2 Council / Triple Review Specification

## 1. Scope

This specification records the Wave 0 council review for the PM-Core V2 specification set. The reviewed baseline is:

- `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`
- `docs/research/t10550-docs-ssot-inventory-and-contradiction-matrix.md`
- `.cleo/rcasd/T10551/test-runs/t10551-adr-doctrine-acceptance.vitest.json`
- `.cleo/rcasd/T10552/test-runs/t10552-ac-evidence.vitest.json`

The review objective is to determine whether PM-Core V2 Wave 0 MAY proceed using ADR-088 as the target doctrine while tracking non-blocking downstream amendments separately.

## 2. Normative Review Contract

1. The review packet MUST include at least three independent review personas.
2. Each review persona MUST state a decision of `accept`, `accept-with-follow-up`, or `block`.
3. A `block` decision MUST name one or more blocking objections and MUST NOT be considered resolved until each objection has a concrete disposition.
4. The final council decision MUST be `accepted` only when zero unresolved blocking objections remain.
5. Accepted decision docs MUST be attached by repository path and MUST include the PM-Core V2 doctrine ADR.
6. Evidence MUST be machine-checkable as VitestJsonLike JSON with `success=true`, no failed tests, and assertions covering the three acceptance criteria for T10557.

## 3. Data Shapes

### 3.1 Review Persona

```ts
type ReviewDecision = 'accept' | 'accept-with-follow-up' | 'block';

type CouncilReview = {
  id: 'architecture' | 'contracts' | 'operations';
  reviewer: string;
  independenceBasis: string;
  decision: ReviewDecision;
  findings: string[];
  blockingObjections: string[];
  followUps: string[];
};
```

### 3.2 Blocking Objection Resolution

```ts
type ObjectionResolution = {
  objectionId: string;
  sourceReview: CouncilReview['id'];
  severity: 'blocking';
  objection: string;
  resolution: string;
  resolvedBy: string[];
  status: 'resolved' | 'unresolved';
};
```

### 3.3 Accepted Decision Attachment

```ts
type AcceptedDecisionDoc = {
  path: string;
  role: 'target-doctrine' | 'contradiction-matrix' | 'machine-evidence';
  required: boolean;
  sha256?: string;
};
```

## 4. Independent Reviews Captured

### 4.1 Architecture Review

- Reviewer: Architecture Council
- Independence basis: evaluated hierarchy and graph invariants without relying on implementation ergonomics.
- Decision: `accept-with-follow-up`
- Findings:
  - ADR-088 establishes `tasks.type='saga'` as the canonical Saga identity.
  - ADR-088 reserves `tasks.parent_id` as the only containment edge for traversal, closure, rollup, nesting budget, and parent completion.
  - ADR-088 explicitly excludes `task_relations` from containment semantics.
- Blocking objections: none.
- Follow-ups:
  - Downstream amendments SHOULD mark legacy label/group Saga guidance as transitional or superseded where it remains current-facing.

### 4.2 Contracts Review

- Reviewer: Contract Council
- Independence basis: evaluated schema, API, and evidence-backed acceptance shape separately from architectural intent.
- Decision: `accept-with-follow-up`
- Findings:
  - The target data model for typed completion criteria is specific enough for contract work: `text`, `child_task`, and `evidence_bound` are distinct kinds.
  - The contradiction matrix identifies `docs/specs/CLEO-TASKS-API-SPEC.md` drift as a follow-up, not a Wave 0 blocker, because ADR-088 is the accepted target authority for PM-Core V2.
  - Existing T10551/T10552 VitestJsonLike evidence demonstrates doctrine and acceptance checks can be validated programmatically.
- Blocking objections: none.
- Follow-ups:
  - Contract tasks MUST add `saga` to task type contracts and MUST separate non-containment relations from parent/child APIs before implementation relies on those surfaces.

### 4.3 Operations Review

- Reviewer: Operations Council
- Independence basis: evaluated migration safety, rollout, and live-data risk independently from desired final schema.
- Decision: `accept-with-follow-up`
- Findings:
  - Wave 0 safely stops at accepted doctrine and evidence; it does not require a live database migration.
  - ADR-088 requires dry-run evidence, backup/restore rehearsal, and owner-approved apply before changing live task databases.
  - T10550 identifies stale docs and generated references without recommending unsafe deletion or manual generated-doc edits.
- Blocking objections: none.
- Follow-ups:
  - Migration work MUST retain backup/restore rehearsal and dry-run gates before any real PM-Core V2 apply.

## 5. Blocking Objections and Resolutions

No reviewer recorded a blocking objection. The council therefore resolves the blocking-objection gate as follows:

| Objection ID | Source review | Status | Resolution |
|---|---|---|---|
| BO-000 | all | resolved | No blocking objections were raised by Architecture, Contracts, or Operations review. Follow-ups are non-blocking and are routed to downstream Wave 0/Wave 1 contract, docs, and migration tasks. |

The final council decision is `accepted` because all three independent reviews were captured and the unresolved blocking-objection count is zero.

## 6. Accepted Decision Docs Attached

The accepted decision packet consists of:

| Path | Role | Required | Acceptance reason |
|---|---|---:|---|
| `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md` | target-doctrine | yes | Defines the accepted PM-Core V2 WorkGraph, relation, and completion-criteria doctrine. |
| `docs/research/t10550-docs-ssot-inventory-and-contradiction-matrix.md` | contradiction-matrix | yes | Captures current documentation conflicts and their disposition plan so accepted doctrine can proceed without hiding drift. |
| `.cleo/rcasd/T10557/test-runs/t10557-pm-core-v2-triple-review.vitest.json` | machine-evidence | yes | Verifies this review packet satisfies T10557 acceptance criteria. |

## 7. Acceptance Criteria and Programmatic Verification

| T10557 acceptance criterion | Verification requirement | Evidence assertion |
|---|---|---|
| 3 independent reviews captured | Evidence MUST count exactly the Architecture, Contracts, and Operations reviews and each MUST have a decision. | `AC1 three independent reviews captured` |
| blocking objections resolved | Evidence MUST report zero unresolved blocking objections. | `AC2 blocking objections resolved` |
| accepted decision docs attached | Evidence MUST verify required accepted decision paths exist in this worktree. | `AC3 accepted decision docs attached` |

## 8. Error Codes

- `E_T10557_REVIEW_COUNT`: fewer than three independent reviews are captured.
- `E_T10557_REVIEW_DECISION_MISSING`: a review lacks an explicit decision.
- `E_T10557_BLOCKING_OBJECTION_UNRESOLVED`: at least one blocking objection remains unresolved.
- `E_T10557_ACCEPTED_DOC_MISSING`: a required accepted decision document path is absent.
- `E_T10557_EVIDENCE_NOT_VITEST_JSONLIKE`: evidence is not shaped as CLEO-accepted VitestJsonLike JSON.

## 9. Council Decision

PM-Core V2 Wave 0 review is accepted. ADR-088 MAY be used as the target doctrine for downstream PM-Core V2 work. Follow-up amendments and migrations MUST preserve the `type=saga`, `parent_id` containment-only, `task_relations` non-containment-only, and typed completion-criteria invariants.
