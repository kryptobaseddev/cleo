# Completion Criteria RFC 2119 Specification

> Spec ID: T10554-completion-criteria
> Task: T10554
> Parent: T10539
> Saga: T10538 PM-Core V2
> Status: Specification
> Date: 2026-05-25
> Normative language: RFC 2119 / RFC 8174. The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119 when, and only when, they appear in uppercase.

## 1. Scope

This document defines the PM-Core V2 completion-criteria contract for task acceptance criteria (AC) rows and their relationship to child states, completed parent tasks, waivers, and replacement ACs. It is implementation-neutral but programmatically verifiable.

The specification covers:

- AC kind row-shape rules.
- Cancelled child policy.
- Done parent reopen policy.
- Waiver and replacement semantics.
- Error codes and validation hooks for each acceptance criterion of T10554.

## 2. Terms

- Parent task: A task with one or more direct children.
- Child task: A task whose `parentId` points to another task.
- AC row: A durable acceptance-criteria record attached to a task.
- Active AC: An AC row whose `state` is `active` and that has not been replaced or waived.
- Waived AC: An AC row whose `state` is `waived` and whose `waiver` object is valid.
- Replaced AC: An AC row whose `state` is `replaced` and whose `replacement` object is valid.
- Effective AC set: All active AC rows for a task plus waived/replaced rows retained for audit history.
- Completion evaluator: Any command, service, worker, or UI path that decides whether a task can transition to `done`.

## 3. Canonical data shapes

### 3.1 AcceptanceCriteriaRow

An AC row MUST conform to the following logical contract:

```ts
type AcceptanceCriterionKind =
  | 'behavior'
  | 'test'
  | 'doc'
  | 'migration'
  | 'qa'
  | 'research'
  | 'release'
  | 'generic';

type AcceptanceCriterionState =
  | 'active'
  | 'waived'
  | 'replaced'
  | 'cancelled';

interface AcceptanceCriteriaRow {
  id: string;                  // REQUIRED stable UUID or task-local durable id
  taskId: string;              // REQUIRED task id, e.g. T10554
  alias: string;               // REQUIRED task-local display key, e.g. AC1
  ordinal: number;             // REQUIRED positive integer ordering key
  kind: AcceptanceCriterionKind;
  state: AcceptanceCriterionState;
  text: string;                // REQUIRED human-readable criterion
  subject?: string;            // REQUIRED for behavior/migration/release where applicable
  evidenceRef?: string;        // REQUIRED for test/doc/qa/research when state=active and completion is asserted
  verificationHook?: VerificationHook;
  waiver?: AcWaiver;
  replacement?: AcReplacement;
  createdAt: string;           // REQUIRED ISO 8601 timestamp
  updatedAt: string;           // REQUIRED ISO 8601 timestamp
}

interface VerificationHook {
  kind: 'test-run' | 'tool' | 'files' | 'commit' | 'query' | 'manual-review';
  command?: string;            // REQUIRED for kind=test-run/tool/query unless hook is external
  expectedExitCode?: number;   // REQUIRED for kind=test-run/tool/query
  outputPath?: string;         // REQUIRED when hook produces file evidence
  bindsAcAliases: string[];    // REQUIRED non-empty list of AC aliases
}
```

All completion evaluators MUST reject an AC row with missing `id`, `taskId`, `alias`, `ordinal`, `kind`, `state`, `text`, `createdAt`, or `updatedAt`.

### 3.2 Waiver and replacement shapes

```ts
interface AcWaiver {
  waiverId: string;            // REQUIRED stable id
  actor: string;               // REQUIRED authenticated principal
  reason: string;              // REQUIRED non-empty rationale
  approvedBy: string;          // REQUIRED owner/maintainer principal
  approvedAt: string;          // REQUIRED ISO 8601 timestamp
  scope: 'single-ac' | 'task' | 'epic-child-rollup';
  expiresAt?: string;          // REQUIRED when waiver is temporary
  replacementAcId?: string;    // OPTIONAL; if present, target row MUST exist
}

interface AcReplacement {
  replacementId: string;       // REQUIRED stable id
  actor: string;               // REQUIRED authenticated principal
  reason: string;              // REQUIRED non-empty rationale
  replacedByAcId: string;      // REQUIRED id of the active replacement row
  replacedAt: string;          // REQUIRED ISO 8601 timestamp
}
```

Waiver and replacement records MUST be immutable audit facts. Corrections MUST be appended as new records or rows; they MUST NOT mutate historical approvals.

## 4. AC kind row-shape rules (AC1)

Every AC row MUST declare exactly one `kind`. Implementations MUST validate kind-specific shape before evaluating completion.

| kind | Required row shape | Completion evidence rule | Invalid when |
| --- | --- | --- | --- |
| `behavior` | `subject` MUST identify the behavior, command, API, or workflow under acceptance. | MUST bind to at least one `test-run`, `tool`, `files`, or `manual-review` hook. | `subject` is empty or no hook/evidence is bound when completion is asserted. |
| `test` | `verificationHook.kind` MUST be `test-run` or `tool`; `command` and `expectedExitCode` MUST be present. | MUST include passing structured test output or tool exit code 0. | Evidence has failures or no reproducible command. |
| `doc` | `evidenceRef` MUST point to a repository-relative documentation/spec path. | MUST include a `files` or `commit` atom and SHOULD include a documentation check hook. | File is missing, uncommitted, or outside the repository. |
| `migration` | `subject` MUST name the schema/data/API surface; `verificationHook` MUST define dry-run or reversible validation. | MUST include test/tool evidence for idempotency or rollback safety. | No validation command or destructive-only validation. |
| `qa` | `verificationHook` MUST specify an automated or manual-review procedure. | MUST include pass/fail result with reviewer/tool identity. | Result is ambiguous or not attributable. |
| `research` | `evidenceRef` MUST point to a research/spec artifact and `text` MUST state the decision or finding to be produced. | MUST include a file/commit atom; SHOULD include citations or source references. | Artifact lacks explicit conclusion or decision. |
| `release` | `subject` MUST identify release artifact, tag, PR, or deployment target. | MUST include PR, tool, URL, or release-verification evidence. | Target cannot be resolved or evidence predates the release candidate. |
| `generic` | `text` MUST be precise enough to validate; `verificationHook` SHOULD be present. | MUST include at least one evidence atom unless explicitly waived. | Text is purely aspirational or unverifiable. |

Error codes:

- `E_AC_KIND_MISSING`: `kind` is absent.
- `E_AC_KIND_UNKNOWN`: `kind` is not one of the allowed values.
- `E_AC_SHAPE_REQUIRED_FIELD`: a kind-required field is absent or empty.
- `E_AC_EVIDENCE_MISSING`: completion is asserted without required evidence.
- `E_AC_EVIDENCE_KIND_INVALID`: evidence kind is incompatible with the AC kind.

Programmatic verification hook for AC1:

- Hook id: `completionCriteria.validateAcRowShape`
- Inputs: `AcceptanceCriteriaRow[]`
- Expected: returns no diagnostics with codes `E_AC_KIND_*`, `E_AC_SHAPE_REQUIRED_FIELD`, `E_AC_EVIDENCE_*` for rows under completion.
- T10554 doc evidence: `scripts/verify-t10554-completion-criteria-spec.mjs` MUST find section `## 4. AC kind row-shape rules (AC1)`, every allowed kind, and all five AC1 error codes.

## 5. Cancelled child policy (AC2)

A child task with status `cancelled` MUST NOT count as `done` for parent completion rollups. A cancelled child MAY be excluded from the required-child denominator only when the cancellation is explicitly justified by one of these audit mechanisms:

1. A valid waived AC on the parent that names the cancelled child or affected deliverable.
2. A valid replacement child linked to the same parent with a relation equivalent to `replaces` or `supersedes`.
3. A parent-level decision record stating that the child scope is no longer required.

If none of the audit mechanisms exists, the parent completion evaluator MUST block the parent from transitioning to `done` and MUST return `E_PARENT_CANCELLED_CHILD_UNRESOLVED`.

If a child is cancelled after the parent is already `done`, the completion evaluator MUST apply the done parent reopen policy in Section 6.

A cancelled child MUST remain visible in parent rollups as `cancelled` or `excluded_cancelled`; implementations MUST NOT silently delete or hide the child row to achieve completion.

Error codes:

- `E_PARENT_CANCELLED_CHILD_UNRESOLVED`: cancelled child has no waiver, replacement, or decision.
- `E_PARENT_CANCELLED_CHILD_HIDDEN`: cancelled child was omitted from rollup/audit output.
- `E_PARENT_CANCELLED_CHILD_DOUBLE_COUNTED`: cancelled child counted as both done and excluded.

Programmatic verification hook for AC2:

- Hook id: `completionCriteria.validateCancelledChildPolicy`
- Inputs: parent task, direct children, parent AC rows, task relations/decisions.
- Expected: each cancelled child is classified exactly once as `blocked` or `excluded_cancelled`; only `excluded_cancelled` children have valid audit support.
- T10554 doc evidence: `scripts/verify-t10554-completion-criteria-spec.mjs` MUST find section `## 5. Cancelled child policy (AC2)` and all three AC2 error codes.

## 6. Done parent reopen policy (AC3)

A parent task in status `done` MUST be reopened when a material completion dependency becomes unsatisfied after completion. Material dependency changes include:

- A direct child transitions from `done` to any non-terminal or non-satisfying state.
- A direct child is newly added to the parent without an explicit waiver, replacement, or deferred-scope decision.
- A direct child transitions to `cancelled` without satisfying Section 5.
- An active parent AC is added, reactivated, or loses valid evidence.
- A waiver expires or is revoked and no replacement evidence satisfies the original criterion.

The reopen transition MUST set the parent status to `in_progress` or the project’s canonical active status, MUST preserve the historical `done` event, and MUST emit an audit event with:

```ts
interface ParentReopenEvent {
  eventType: 'parent-reopened';
  parentTaskId: string;
  triggeringEntityType: 'child' | 'acceptance-criterion' | 'waiver' | 'evidence';
  triggeringEntityId: string;
  previousStatus: 'done';
  newStatus: string;
  reasonCode: ReopenReasonCode;
  occurredAt: string;
}

type ReopenReasonCode =
  | 'child_regressed'
  | 'child_added'
  | 'cancelled_child_unresolved'
  | 'ac_added_or_reactivated'
  | 'evidence_invalidated'
  | 'waiver_expired_or_revoked';
```

A done parent MUST NOT be reopened for purely cosmetic edits, comment changes, child title edits, or replacement AC text edits that preserve the same verification obligation.

Error codes:

- `E_DONE_PARENT_REOPEN_REQUIRED`: a material dependency became unsatisfied and no reopen occurred.
- `E_DONE_PARENT_REOPEN_EVENT_MISSING`: reopen occurred without required audit event fields.
- `E_DONE_PARENT_REOPEN_SPURIOUS`: reopen occurred for a non-material change.

Programmatic verification hook for AC3:

- Hook id: `completionCriteria.validateDoneParentReopenPolicy`
- Inputs: pre-change parent snapshot, post-change parent snapshot, change event.
- Expected: material unsatisfied changes require a parent reopen event; non-material changes do not.
- T10554 doc evidence: `scripts/verify-t10554-completion-criteria-spec.mjs` MUST find section `## 6. Done parent reopen policy (AC3)`, all six reason codes, and all three AC3 error codes.

## 7. Waiver and replacement semantics (AC4)

### 7.1 Waivers

A waiver MAY satisfy an AC only when it is explicit, approved, scoped, and auditable. A waiver MUST NOT erase the original AC row. A waiver MUST set `state='waived'` on the affected AC row or attach an immutable waiver record addressable from that row.

A waiver MUST contain `waiverId`, `actor`, `reason`, `approvedBy`, `approvedAt`, and `scope`. A temporary waiver MUST contain `expiresAt`. On or after `expiresAt`, a completion evaluator MUST treat the waiver as invalid and MUST re-evaluate the original AC.

A waiver MUST NOT satisfy test evidence requirements for unrelated AC rows. Broad task-level waivers MUST enumerate the aliases or row ids they cover.

### 7.2 Replacements

A replacement changes the required acceptance obligation. A replacement MUST create or reference a distinct active AC row and MUST retain the original row with `state='replaced'` plus a valid `replacement` object.

The replacement row MUST have its own kind-specific row shape, evidence rules, ordinal/alias, and verification hooks. Replacement MUST NOT mutate the original AC text in place.

A replaced AC is considered satisfied for completion only if its replacement row is satisfied or validly waived. Chained replacements SHOULD be avoided; if present, evaluators MUST resolve the chain to exactly one active terminal AC or return `E_AC_REPLACEMENT_CHAIN_INVALID`.

### 7.3 Combined waiver/replacement behavior

An AC row MUST NOT be both `waived` and `replaced` at the same time. If a waiver points to a replacement AC, the original row remains `replaced`, and the waiver applies to the replacement row only unless explicitly scoped otherwise.

Error codes:

- `E_AC_WAIVER_REQUIRED_FIELD`: waiver is missing a required field.
- `E_AC_WAIVER_EXPIRED`: waiver expiry has passed.
- `E_AC_WAIVER_SCOPE_INVALID`: waiver scope does not cover the AC being evaluated.
- `E_AC_REPLACEMENT_REQUIRED_FIELD`: replacement is missing a required field.
- `E_AC_REPLACEMENT_TARGET_MISSING`: replacement target row does not exist.
- `E_AC_REPLACEMENT_CHAIN_INVALID`: replacement chain has zero, multiple, cyclic, or inactive terminal rows.
- `E_AC_STATE_CONFLICT`: row is both waived and replaced or contains incompatible waiver/replacement state.

Programmatic verification hook for AC4:

- Hook id: `completionCriteria.validateWaiverReplacementSemantics`
- Inputs: AC row graph, waiver records, replacement records, current time.
- Expected: waived rows have valid non-expired waiver support; replaced rows resolve to exactly one active terminal row; no row has conflicting states.
- T10554 doc evidence: `scripts/verify-t10554-completion-criteria-spec.mjs` MUST find section `## 7. Waiver and replacement semantics (AC4)` and all seven AC4 error codes.

## 8. Completion evaluator contract

A completion evaluator MUST perform these checks before marking a task `done`:

1. Load task, direct children, AC rows, evidence atoms, waiver records, replacement records, task relations, and relevant decisions in one consistent snapshot.
2. Validate every AC row against Section 4.
3. Resolve waived and replaced AC rows according to Section 7.
4. Verify all active terminal AC rows have compatible evidence or valid waiver support.
5. For parent tasks, evaluate every direct child according to Section 5.
6. If the task is already `done`, compare dependency changes against Section 6 before preserving `done`.
7. Return a machine-readable result.

```ts
interface CompletionCriteriaResult {
  taskId: string;
  canComplete: boolean;
  diagnostics: CompletionCriteriaDiagnostic[];
  effectiveAcIds: string[];
  excludedChildIds: string[];
  requiredReopenEvent?: ParentReopenEvent;
}

interface CompletionCriteriaDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  entityType: 'task' | 'child' | 'acceptance-criterion' | 'waiver' | 'replacement' | 'evidence';
  entityId: string;
  message: string;
}
```

When `canComplete=false`, the evaluator MUST include at least one diagnostic with `severity='error'`. When `canComplete=true`, the evaluator MUST NOT include any diagnostic with `severity='error'`.

## 9. T10554 verification matrix

| T10554 AC | Required normative coverage | Programmatic evidence hook |
| --- | --- | --- |
| AC1: AC kinds have row-shape rules | Section 4 defines kind enum, row-shape requirements, evidence compatibility, and error codes. | `scripts/verify-t10554-completion-criteria-spec.mjs` checks allowed kinds and AC1 error codes. |
| AC2: cancelled child policy specified | Section 5 defines cancelled child rollup treatment, exclusion requirements, visibility, and error codes. | Script checks cancelled-child section and error codes. |
| AC3: done parent reopen policy specified | Section 6 defines material changes, reopen event contract, non-material exclusions, and error codes. | Script checks reopen section, reason codes, and error codes. |
| AC4: waiver/replacement semantics specified | Section 7 defines waiver shape, replacement shape, conflict rules, chain resolution, and error codes. | Script checks waiver/replacement section and error codes. |

## 10. Non-goals

This spec does not mandate database table names, migration filenames, UI copy, or exact CLEO command syntax. Implementations MAY choose their storage and command surfaces, provided they preserve the data contracts and observable behavior above.
