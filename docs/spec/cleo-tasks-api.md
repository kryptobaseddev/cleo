# CLEO Tasks API Specification

**Version**: 2.0.0
**Status**: AUTHORITY (narrative spec, cites code layer)
**Domain**: `tasks`
**Contract file**: `packages/contracts/src/operations/tasks.ts` (`TasksOps`)
**Operation registry**: `packages/contracts/src/dispatch/operations-registry.ts`
**Implementation root**: `packages/core/src/tasks/`
**Dispatch handler**: `packages/cleo/src/dispatch/domains/tasks.ts`
**Authority pointer**: `cleo docs fetch cleo-api-authority`

This specification MUST be used by anyone reading, mutating, or exposing task
data. When this spec disagrees with the contract or the registry, the code
wins and this spec is a bug.

> **Related docs**:
> - `cleo docs fetch cleo-api-authority`: authority chain
> - [`docs/spec/cleo-studio-http.md`](cleo-studio-http.md): Studio HTTP exposure
> - [`docs/spec/cleo-task-dashboard.md`](cleo-task-dashboard.md): Studio `/tasks` UI
> - [`docs/spec/gate-integrity.md`](gate-integrity.md): evidence grammar (ADR-051)
> - [`docs/adr/adr-051-programmatic-gate-integrity.md`](../adr/adr-051-programmatic-gate-integrity.md)
> - [`docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`](../adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md): containment, relations, reparent and retype rules
> - [`docs/spec/cleo-operation-constitution.md`](cleo-operation-constitution.md): runtime operation tables
> - §9 below: external task links (sync)

---

## 1. Overview

The **tasks** domain is the authoritative record of every unit of work in a
CLEO project. A task is a row of the `tasks_tasks` table in the project store
`<project>/.cleo/cleo.db` (`packages/core/src/store/schema/cleo-project/tasks-core.ts:107`).
The bare legacy tables (`tasks`, `task_dependencies`, …) are no longer read or
written at runtime: `packages/core/src/store/tasks-schema.ts` re-exports the
prefixed tables under the old names (`tasks_tasks as tasks`, …).

Tasks are typed (`saga` / `epic` / `task` / `subtask`), contained via
`parent_id`, blocked for scheduling via `tasks_task_dependencies`, connected by
soft relation edges via `tasks_task_relations`, and tracked on two orthogonal
axes: **status** and **pipeline_stage**.

PM-Core V2 (ADR-088) uses three separate graph surfaces:

| Surface | Storage | Semantics |
|---------|---------|-----------|
| Containment | `tasks_tasks.parent_id` | The parent/child tree. Drives direct children, ancestors, descendants, rollups, completion projection, and cascade mutation planning. |
| Hard dependency | `tasks_task_dependencies` | Scheduler/readiness edge. A task, epic, or saga is not dependency-ready until its upstream dependencies are satisfied. |
| Soft relation | `tasks_task_relations` | Dotted-line context graph: related work, provenance, duplicate/supersede/extend/fix links, advisory blocks, cross-saga grouping. It never creates containment and never blocks scheduling by itself. |

Evidence:
- Tables: `packages/core/src/store/schema/cleo-project/tasks-core.ts` (`tasks_tasks` :107, `tasks_task_dependencies` :369, `tasks_task_relations` :398)
- Status taxonomy: `packages/contracts/src/status-registry.ts:15-23`
- Pipeline stages: `packages/core/src/tasks/pipeline-stage.ts:54-66`

### Invariants (MUST hold at all times)

- **INV-1 — Status is one of seven values.** `status ∈ {pending, active,
  blocked, done, cancelled, archived, proposed}`. Source:
  `packages/contracts/src/status-registry.ts:15-23`.
- **INV-2 — Pipeline stage is one of 11 values OR NULL.** `pipeline_stage ∈
  {research, consensus, architecture_decision, specification, decomposition,
  implementation, validation, testing, release, contribution, cancelled} ∪
  {NULL}`. Source: `packages/core/src/tasks/pipeline-stage.ts:54-66`.
- **INV-3 — Status × stage coupling (T877).** `status = 'done'` REQUIRES
  `pipeline_stage ∈ {contribution, cancelled}`. `status = 'cancelled'` REQUIRES
  `pipeline_stage = 'cancelled'`. Enforced by SQLite triggers on `tasks_tasks`;
  the current update trigger is
  `packages/core/migrations/drizzle-cleo-project/20261105120000_t14218-guard-triggers-compare-old/migration.sql:39-50`.
- **INV-4 — Forward-only pipeline.** `isPipelineTransitionForward()` rejects
  backward transitions unless the current or new stage is unknown. Source:
  `packages/core/src/tasks/pipeline-stage.ts:332-337`.
- **INV-5 — Terminal archive.** `status = 'archived'` has no outgoing
  transitions. Source: `packages/core/src/validation/engine.ts:413-421`.
- **INV-6 — Evidence-gated completion.** `tasks.complete` rejects when any
  required verification gate lacks validated evidence (ADR-051). The required
  gates come from `verification.requiredGates` (default `implemented`,
  `testsPassed`, `qaPassed`: `packages/core/src/config.ts:66`); a
  documentation or research task drops `testsPassed` and `qaPassed`
  (`packages/core/src/tasks/verification-policy.ts:98-157`). Dispatch:
  `packages/cleo/src/dispatch/domains/tasks.ts:502-546`; grammar in
  [`gate-integrity.md`](gate-integrity.md).
- **INV-7 — Containment is `parent_id` only.** Saga/Epic/Task/Subtask hierarchy,
  child listing, rollups, closure, and reparent cascades MUST derive from
  `parent_id`, not `tasks_task_relations` (ADR-088 Decision 2).
- **INV-8 — Soft relations are non-blocking.** Relation rows, including
  `groups` and `blocks`, MUST NOT be treated as scheduler dependencies. Use
  `tasks_task_dependencies` for execution blocking (ADR-088 Decision 3).

---

## 2. Status State Machine

**Canonical taxonomy** (7 values, exact):
`pending | active | blocked | done | cancelled | archived | proposed`

Source: `packages/contracts/src/status-registry.ts:15-23`.

Transitions (source: `packages/core/src/validation/engine.ts:413-421`):

```
proposed   → [pending, cancelled]   (intake: admit or reject)
pending    → [active, blocked, cancelled]
active     → [done, blocked, pending, cancelled]
done       → [pending, archived]
blocked    → [pending, active, cancelled]
cancelled  → [pending]
archived   → []                     (terminal)
```

`proposed` is the intake status: a proposed task is admitted (→ `pending`) or
rejected (→ `cancelled`) and cannot jump to `active` or `done`
(`packages/core/src/validation/engine.ts:404-412`).

Terminal set: `{done, cancelled, archived}`. Source:
`packages/contracts/src/status-registry.ts:70-74`.

---

## 3. Pipeline Stage

`pipeline_stage` is a column **orthogonal** to `status`. It tracks where a task
is in the RCASD-IVTR+C lifecycle. A task MAY progress through pipeline stages
while remaining `status = 'active'`.

Canonical stages (11 values, order-significant):

| # | Stage | Terminal? | Purpose |
|---|-------|-----------|---------|
| 1 | `research` | No | Explore problem space |
| 2 | `consensus` | No | Multi-agent agreement |
| 3 | `architecture_decision` | No | ADR captured |
| 4 | `specification` | No | Spec written |
| 5 | `decomposition` | No | Broken into atomic tasks |
| 6 | `implementation` | No | Code written |
| 7 | `validation` | No | Reviewed / validated |
| 8 | `testing` | No | Tests green |
| 9 | `release` | No | Shipped |
| 10 | `contribution` | **Yes** | Done + lessons captured |
| 11 | `cancelled` | **Yes** | Terminal marker for cancelled tasks |

Source: `packages/core/src/tasks/pipeline-stage.ts:54-66`.

`LIFECYCLE_STAGE_NAMES` in `packages/core/src/store/schema/lifecycle.ts:12-23`
lists stages 1–10 only (no `cancelled`) for lifecycle stage rows. The 11th
marker lives only on `tasks_tasks.pipeline_stage`; it sits at order 11 so a move
into `cancelled` is always forward (`packages/core/src/tasks/pipeline-stage.ts:40-50`).

### Default stage on creation

`resolveDefaultPipelineStage` (`packages/core/src/tasks/pipeline-stage.ts:210-232`):

1. An explicit valid `--pipeline-stage` wins.
2. Otherwise inherit the parent's stage.
3. Otherwise `research` for an epic.
4. Otherwise `implementation`.

Move a task forward with `cleo update <id> --pipeline-stage <stage>`; a backward
move is rejected (INV-4). `cancelled` is set by `cleo cancel`, not by
`--pipeline-stage` (its accepted values stop at `contribution`).

### Status × pipeline_stage coupling (T877)

INV-3 is enforced by triggers. A write that would violate it aborts with
`T877_INVARIANT_VIOLATION`. Since T14218 the update trigger fires only when
`status` or `pipeline_stage` actually changes, so a legacy row with an invalid
pair can still take unrelated edits.

| `status` | Legal `pipeline_stage` |
|----------|------------------------|
| `proposed`, `pending`, `active`, `blocked` | any of 11 |
| `done` | `contribution` OR `cancelled` ONLY |
| `cancelled` | `cancelled` ONLY |
| `archived` | unconstrained by the trigger (keeps its pre-archive value) |

---

## 4. The "Deferred" Clarification

There is NO `deferred` status, column, or enum value. "Deferred" was only ever
a Studio UI label for `status = 'cancelled'` on epics. Studio now names it
"cancelled": the canonical URL parameter is `?cancelled=1`; a legacy
`?deferred=1` still maps to the same filter for one release with a one-time
warning, and the `includeDeferred` option was renamed `includeCancelled`
(`packages/studio/src/routes/tasks/+page.server.ts:23-27`, `:150-160`).

`deferred` is absent from `packages/contracts/src/status-registry.ts`.

Agents MUST NOT use `deferred` as a status. Any code path that writes
`status = 'deferred'` is a bug. Use `status = 'cancelled'` with
`pipeline_stage = 'cancelled'`.

---

## 5. Operation Catalogue

The authoritative wire format is the `TasksOps` map in
`packages/contracts/src/operations/tasks.ts:2353-2429`. An operation is
reachable only when it is also listed in `QUERY_OPS` / `MUTATE_OPS` of the
dispatch handler (`packages/cleo/src/dispatch/domains/tasks.ts:783-860`) and
registered in `packages/contracts/src/dispatch/operations-registry.ts`.
Parameter and result shapes are the `Tasks<Op>Params` / `Tasks<Op>Result`
types named in `TasksOps`; this spec does not copy them.

### 5.1 Query operations

| Op | CLI verb | Description |
|----|----------|-------------|
| `tasks.show` | `cleo show <id>` (several ids allowed) | Task record + view; `--full` returns withheld fields |
| `tasks.list` | `cleo list --parent <id>` | Filter-scoped list (direct children for `--parent`) |
| `tasks.find` | `cleo find "query"` | Lexical search; `--fuzzy` opts into subsequence matching |
| `tasks.tree` | `cleo tree <rootId>` | Hierarchy subtree |
| `tasks.blockers` | `cleo blockers` | Blocked tasks and blocking chains |
| `tasks.depends` | `cleo deps show <id>` (also `overview`, `cycles`) | Dependency graph |
| `tasks.deps.validate`, `tasks.deps.tree` | `cleo deps …` | Dependency-graph validation / tree |
| `tasks.slice` | `cleo tasks slice` | Local WorkGraph slice around a task |
| `tasks.context` | (no CLI verb) | Task-scoped context pack with token budget |
| `tasks.analyze` | `cleo analyze` | Leverage scoring and bottleneck detection |
| `tasks.impact` | `cleo reason impact --change "<text>"` | Keyword-match tasks affected by a change (`change` required) |
| `tasks.next` | `cleo next` | Next-work suggestions |
| `tasks.plan` | `cleo plan` | Composite planning view |
| `tasks.relates` | `cleo relates suggest` / `discover` | Related-task discovery |
| `tasks.complexity.estimate` | `cleo complexity estimate <id>` | small / medium / large estimate |
| `tasks.history` | `cleo history log` / `work` | Task audit and work history |
| `tasks.current` | `cleo current` | Current task for the session |
| `tasks.label.list` | `cleo labels` | Labels with task counts |
| `tasks.sync.links` | `cleo sync links` | External task link inventory |
| `tasks.saga.list`, `.members`, `.rollup` | `cleo saga list` / `members` / `rollup` | Saga reads |
| `tasks.req.list`, `.req.migrate.preview` | `cleo req …` | REQ-ID acceptance gates |

`cleo exists <id>` is a CLI verb that reads core directly; there is no
`tasks.exists` dispatch operation.

### 5.2 Mutate operations

| Op | CLI verb | Description |
|----|----------|-------------|
| `tasks.add` | `cleo add` | Create a task (`--acceptance` is pipe-separated) |
| `tasks.add-batch` | `cleo add-batch --file <json>` | Create several tasks in one transaction |
| `tasks.update` | `cleo update <id>` | Partial update; forward-only `--pipeline-stage` |
| `tasks.complete` | `cleo complete <id>` | ADR-051 evidence-gated completion; rejects `force` (§7) |
| `tasks.cancel` | `cleo cancel <id>` | Soft terminal state; reversible via restore |
| `tasks.decompose` | `cleo decompose <id>` | Move text criteria onto a new child |
| `tasks.reconcile-scope` | `cleo reconcile scope` | Scope reconciliation |
| `tasks.delete` | `cleo delete <id>` | Soft delete to archive; parents with children need `--cascade` or `--force` |
| `tasks.archive` | `cleo archive` | Archive done (and cancelled) tasks (§10) |
| `tasks.restore` | `cleo restore task <id>` | Restore from archived, cancelled or done |
| `tasks.reparent` | `cleo reparent <id> --to <parent>` (`""` for root) | Move a subtree (§8) |
| `tasks.reorder` | `cleo reorder <id> --position <n>` / `--top` / `--bottom` | Sibling order |
| `tasks.reorder-rank`, `tasks.bulk-move`, `tasks.assignee` | (Studio Kanban; no CLI verb) | Bulk board mutations |
| `tasks.relates.add`, `.add-batch`, `.remove` | `cleo relates add` / `add-batch` / `remove` | Soft relation edges |
| `tasks.ranking.revert` | `cleo history revert` | Undo one audited ranking change |
| `tasks.start` | `cleo start <id>` | Set current task and take the session's claim lease |
| `tasks.stop` | `cleo stop` | Stop the current task |
| `tasks.sync.reconcile` | `cleo sync reconcile` | External task reconciliation (§9) |
| `tasks.sync.links.remove` | `cleo sync links remove` | Drop all links for a provider |
| `tasks.claim` | `cleo claim <id>` | Take, renew (`--renew`) or override (`--take-over`, `--force-claim`) the session's leased claim; never writes `assignee` |
| `tasks.unclaim` | `cleo unclaim <id>` | Release the session's lease (`--force-claim`: another session's, audited) |
| `tasks.saga.create`, `.add`, `.detach`, `.repair`, `.reconcile` | `cleo saga …` | Saga mutations (ADR-073) |
| `tasks.req.add`, `.replace`, `.move`, `.migrate` | `cleo req …` | REQ-ID acceptance gates |

There is no `tasks.retype` operation (§8.2).

### 5.3 Registered but not dispatched

These ops appear in `TasksOps` and/or the operation registry but are absent
from the handler's `QUERY_OPS` / `MUTATE_OPS`, so dispatch rejects them as
unsupported: `tasks.completion.list`, `tasks.completion.evaluate`,
`tasks.completion.explain`, `tasks.projection.repair`,
`tasks.saga.migrate-containment`, and the registry-only `tasks.traverse`,
`tasks.rollup`, `tasks.frontier`, `tasks.workgraph.audit`, `tasks.subscribe`.

### 5.4 HTTP exposure

- **Runtime gateway.** Every registered operation is addressable at
  `/v1/<domain>/<operation>` (e.g. `/v1/tasks/show`); the gateway (`query` or
  `mutate`) is inferred from the registry (`packages/runtime/src/gateway/http/listen.ts:53-58`,
  `packages/runtime/src/gateway/registry.ts:85-100`).
- **Studio routes** (`packages/studio/src/routes/api/tasks/`): `GET`/`POST
  /api/tasks`, `GET`/`PATCH`/`DELETE /api/tasks/:id`, `GET /api/tasks/:id/deps`,
  `GET /api/tasks/:id/stream`, `POST /api/tasks/:id/transition`,
  `POST /api/tasks/:id/dispatch`, `GET /api/tasks/search`,
  `GET /api/tasks/tree/:epicId`, `GET /api/tasks/graph`,
  `GET /api/tasks/pipeline`, `GET /api/tasks/events`,
  `GET /api/tasks/sessions`, `GET /api/tasks/subscribe`. The write routes call
  `tasks.add`, `tasks.update`, `tasks.assignee` and `tasks.delete` through the
  `/v1` gateway client first (`api/tasks/+server.ts`, `api/tasks/[id]/+server.ts`,
  `api/tasks/[id]/transition/+server.ts`). See
  [`cleo-studio-http.md`](cleo-studio-http.md).

---

## 6. Error Code Map (tasks-relevant subset)

Numeric codes: `packages/contracts/src/exit-codes.ts`. String-code → exit
mapping for the CLI: `ERROR_CODE_TO_EXIT` in
`packages/cleo/src/dispatch/adapters/cli.ts`.

| ExitCode | Value | When it fires |
|----------|------:|---------------|
| `SUCCESS` | 0 | Normal success |
| `INVALID_INPUT` | 2 | Arg shape wrong |
| `NOT_FOUND` | 4 | `taskId` does not exist |
| `VALIDATION_ERROR` | 6 | Business rule violation |
| `LOCK_TIMEOUT` | 7 | Concurrent SQLite lock |
| `PARENT_NOT_FOUND` | 10 | Parent taskId missing |
| `DEPTH_EXCEEDED` | 11 | Hierarchy depth limit |
| `SIBLING_LIMIT` | 12 | Sibling limit |
| `INVALID_PARENT_TYPE` | 13 | Parent type not allowed for this tier |
| `CIRCULAR_REFERENCE` | 14 | Cycle in hierarchy or dependencies |
| `HAS_CHILDREN` | 16 | Delete without cascade |
| `TASK_COMPLETED` | 17 | Mutation on a completed task |
| `CASCADE_FAILED` | 18 | Cascade mutation failed |
| `HAS_DEPENDENTS` | 19 | Delete with downstream deps |
| `CONCURRENT_MODIFICATION` | 21 | Row version mismatch |
| `ID_COLLISION` | 22 | Task id collision |
| `VERSION_CONFLICT` | 23 | `--if-match` (`expectedUpdatedAt`) differs from the stored version (`E_CONFLICT`; `details` carry the current version) |
| `SESSION_UNBOUND` | 24 | Claim override (`takeOver`/`forceClaim`) with no bound session |
| `TASK_RENAMED` | 26 | Sync re-numbered the task the caller addressed after a display-id collision (T12800); `details.expected` is the new id and nothing was written |
| `SESSION_EXISTS` | 30 | Already-active session conflict |
| `SESSION_NOT_FOUND` | 31 | Session not found |
| `TASK_NOT_IN_SCOPE` | 34 | Task outside the session scope |
| `TASK_CLAIMED` | 35 | Another session holds the task's claim lease (`E_TASK_CLAIMED`; `details` name the holder and override) |
| `SESSION_REQUIRED` | 36 | Operation needs an active session |
| `SESSION_CLOSE_BLOCKED` | 37 | Session has unfinished work |
| `INVALID_GATE` | 42 | Unknown gate name on verify |
| `LIFECYCLE_GATE_FAILED` | 80 | Lifecycle gate not satisfied |
| `AUDIT_MISSING` | 81 | No audit trail for op |
| `PROVENANCE_REQUIRED` | 84 | Missing provenance metadata |

The ADR-051 codes (`E_EVIDENCE_MISSING`, `E_EVIDENCE_INSUFFICIENT`,
`E_EVIDENCE_INVALID`, `E_EVIDENCE_STALE`, `E_EVIDENCE_TESTS_FAILED`,
`E_EVIDENCE_TOOL_FAILED`, `E_FLAG_REMOVED`, `E_ALREADY_DONE`, …) have no entry
of their own in the exit-code maps; match on the string code. The full list is
in [`gate-integrity.md`](gate-integrity.md) §5.3.

**HTTP status** on the runtime gateway comes from `statusForResponse`
(`packages/runtime/src/gateway/http/server.ts:48-64`): success → 200;
`E_NOT_FOUND` or any `*_NOT_FOUND` → 404; `E_UNAUTHORIZED`/`E_AUTH_REQUIRED` →
401; `E_FORBIDDEN` → 403; `E_RATE_LIMITED`/`E_RATE_LIMIT_EXCEEDED` → 429;
`E_VALIDATION*`, `E_INVALID_INPUT`, `E_BAD_REQUEST` → 400;
`E_NOT_IMPLEMENTED`/`E_UNSUPPORTED` → 501; every other code → 500. That includes client refusals such as `E_TASK_CLAIMED`, `E_CONFLICT`,
`E_EVIDENCE_*` and `E_FLAG_REMOVED`; T14607 tracks mapping them to 4xx.

---

## 7. Evidence-Gate Contract (ADR-051)

`tasks.complete` is not callable without evidence for every required gate
(INV-6). Atom kinds, the per-gate minimums and the error codes are specified
in [`gate-integrity.md`](gate-integrity.md); the SSoT is
`GATE_EVIDENCE_REQUIREMENTS` in `packages/contracts/src/evidence-atom-schema.ts:579-600`.

Summary of the minimums:

| Gate | Accepted atom combinations (any one) |
|------|--------------------------------------|
| `implemented` | `commit`+`files`, `commit`+`note`, `decision`+`files`, `decision`+`note`, `pr`+`files`, `pr`+`note` (deletion-only PR) |
| `testsPassed` | `test-run`, `tool`, or `ci` |
| `qaPassed` | `tool`, `ci`, or `qa-run` |
| `documented` | `files` or `url` |
| `securityPassed` | `tool` or `note` |
| `cleanupDone` | `note` |
| `nexusImpact` | `tool` or `note` |

**Re-validation** happens at `tasks.complete`. CLEO re-checks every hard atom
(commit reachable, file sha256, test-run hash); a change between `verify` and
`complete` raises `E_EVIDENCE_STALE` (`packages/core/src/tasks/complete.ts:1912-1927`).

The `--force` flag is removed: dispatch rejects any `force` param with
`E_FLAG_REMOVED` (`packages/cleo/src/dispatch/domains/tasks.ts:502-511`).
`CLEO_OWNER_OVERRIDE=1` (+ `CLEO_OWNER_OVERRIDE_REASON`) on `cleo verify` is
honoured only for the owner and is audited to `.cleo/audit/force-bypass.jsonl`
(see [`gate-integrity.md`](gate-integrity.md) §6).

**How work closes:**

- **PR work** closes through the merge sweep (ADR-099): the PR body carries
  `Closes: T#### AC1,AC2` (or `Refs:` for partial delivery), a non-author
  records a per-AC verdict with `cleo review verdict`, and on merge the sweep
  records the `pr:`, `ci:` and `satisfies:` evidence and closes the task.
  `cleo done --from-merge <pr> --dry-run` previews it.
- **No-PR work**: `cleo done <id> --plan` names the gates and the evidence each
  needs; record them, then complete:

```bash
cleo done T### --plan
cleo verify T### --gate implemented --evidence "commit:<sha>;files:path/a.ts,path/b.ts"
cleo verify T### --gate testsPassed  --evidence "tool:test"
cleo verify T### --gate qaPassed     --evidence "tool:lint;tool:typecheck"
cleo complete T###
```

`cleo done <id>` without `--plan` derives the evidence, records every required
gate in one write, and completes.

### 7.1 Contract — `cleo verify` NEVER auto-completes a task (GH #94)

A `cleo verify` write is scoped to `task.verification.*`. Even when the final
gate write drives `verification.passed = true`, the engine never mutates
`task.status`. Closing is a separate, explicit action (`cleo complete` or the
merge sweep), which re-validates every hard atom before flipping
`status → done`.

Enforced in `packages/core/src/validation/engine-ops.ts:1452-1467` (comment
"policy (b): verify NEVER auto-completes"). The reasons:

1. **Evidence staleness protection.** If `verify` flipped status, nothing would
   force the staleness re-check at `complete`; an agent could verify, edit the
   files, and already be `done`.
2. **Lifecycle audit clarity.** Every transition to `done` is accompanied by an
   explicit completion audit entry.

A gate write that drives `verification.passed = true` with no gate missing
returns a `hint`:

```json
{
  "taskId": "T###",
  "passed": true,
  "missingGates": [],
  "hint": "All gates green. Run: cleo complete T###"
}
```

**Reference**: `packages/core/src/validation/__tests__/gate-verify-hint.test.ts`
(GH #94 reproduction test).

---

## 8. Reparent and Retype (WorkGraph Mutation)

ADR-088 Decisions 2 and 5 require both operations to move or validate whole
subtrees. The current implementation covers reparent only.

### 8.1 `tasks.reparent` — Move a subtree under a new parent

CLI: `cleo reparent <id> --to <parentId>` (`--to ""` makes the task a root).
Params: `TasksReparentQueryParams` = `{ taskId, newParentId }` (`null` or empty
promotes to root). There is no dry-run.

Implementation: `coreTaskReparent` in `packages/core/src/tasks/task-reparent.ts:50`.
Before any write it rejects:
- a move under the task itself or under one of its descendants (circular
  reference);
- a missing parent, or a parent that is a subtask;
- a parent whose sibling limit (`maxSiblings`) is reached;
- a moved subtree whose deepest node would exceed `maxDepth`
  (`task-reparent.ts:177`);
- a parent/type combination the PM-Core V2 matrix forbids.

It then moves the whole subtree (Saga and Epic types are kept; Task/Subtask
descendants change type only when the new parent tier requires it), reopens any
`done` ancestor to `pending` with a note (`task-reparent.ts:210-220`), and
appends a `task_reparented` log entry.

Core result (`task-reparent.ts:61-69`):

```jsonc
{
  "task": "T11203",
  "reparented": true,
  "oldParent": "T11100",
  "newParent": "T10965",
  "newType": "task",
  "ancestorsReopened": ["T10965"],
  "subtreeUpdated": ["T11203", "T11204"]
}
```

The contract type `TasksReparentDispatchResult`
(`packages/contracts/src/operations/tasks.ts:1146-1157`) declares only `task`,
`reparented`, `oldParent`, `newParent`, `newType`.

**Atomicity.** All validation runs before the first write, so a rejected move
writes nothing. The row writes go through a caller-owned transaction when one
is passed (`options.tx`, used by `cancel` to reparent children); otherwise each
row is upserted in turn (`task-reparent.ts:222-228`).

ADR-088 Decision 2 also asks for a caller-visible plan (moved root, depth/type
changes, warnings); that richer result is not implemented.

### 8.2 Retype

ADR-088 Decision 5 requires a retype to be a full-subtree mutation with a
dry-run plan and atomic failure. No `tasks.retype` operation or `cleo retype`
verb exists today. A task's type is changed through `tasks.update`
(`cleo update <id> --type <task|epic|subtask>`).

### 8.3 Canonical rules (ADR-088)

- `parent_id` is the only containment edge.
- Reparenting moves the **entire subtree**.
- Retyping requires a **dry run** and full subtree validation (not yet implemented).
- Invalid reparent or retype **must fail atomically**.

Parent/type matrix: `validateWorkGraphHierarchy()` in
`packages/contracts/src/workgraph.ts:1171`.

---

## 9. External Task Links (sync)

Provider-agnostic reconciliation syncs external issue systems (Linear, Jira,
GitHub Issues, GitLab, …) with CLEO as SSoT. A provider adapter normalizes its
native format into `ExternalTask[]`; the reconciliation engine diffs, creates,
updates and links.

```
External issue tracker (any format)
  -> Provider adapter (implements ExternalTaskProvider)
    -> ExternalTask[] (normalized, provider-agnostic)
      -> reconcile() (packages/core/src/reconciliation/)
        -> CLEO core task operations
        -> tasks_external_task_links table (link tracking)
```

Types: `packages/contracts/src/task-sync.ts`.

```typescript
interface ExternalTaskProvider {
  getExternalTasks(projectDir: string): Promise<ExternalTask[]>;
  pushTaskState?(
    tasks: ReadonlyArray<{ id: string; title: string; status: string }>,
    projectDir: string,
  ): Promise<void>;
}

interface ExternalTask {
  externalId: string;
  title: string;
  status: 'pending' | 'active' | 'completed' | 'removed';
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  type?: 'epic' | 'task' | 'subtask';
  labels?: string[];
  url?: string;
  parentExternalId?: string;
  providerMeta?: Record<string, unknown>;
}

interface ExternalTaskLink {
  id: string;                // UUID
  taskId: string;            // CLEO task id
  providerId: string;        // e.g. 'linear', 'jira', 'github'
  externalId: string;
  externalUrl?: string | null;
  externalTitle?: string | null;
  linkType: 'created' | 'matched' | 'manual' | 'transferred';
  syncDirection: 'inbound' | 'outbound' | 'bidirectional';
  metadata?: Record<string, unknown>;
  linkedAt: string;          // ISO 8601
  lastSyncAt?: string | null;
}
```

Links live in the `tasks_external_task_links` table of the project
`cleo.db` (`packages/core/src/store/schema/cleo-project/tasks-core.ts:656`).

Conflict policy (`ConflictPolicy`): `'cleo-wins'` (default), `'provider-wins'`,
`'latest-wins'`, `'report-only'`.

Surfaces:
- CLI: `cleo sync reconcile` (from a JSON file), `cleo sync links
  [--provider <id>] [--task <id>]`, `cleo sync links remove`.
- Dispatch: `tasks.sync.reconcile`, `tasks.sync.links`, `tasks.sync.links.remove`
  (HTTP via `/v1/tasks/<op>`, §5.4).
- SDK (`packages/core/src/cleo.ts:516-536`):

```typescript
import { Cleo } from '@cleocode/core';

const cleo = await Cleo.init('./project');
const result = await cleo.sync.reconcile({
  externalTasks: normalizedTasks,
  providerId: 'linear',
  dryRun: false,
});
const links = await cleo.sync.getLinks('linear');
const taskLinks = await cleo.sync.getTaskLinks('T123');
await cleo.sync.removeProviderLinks('linear');
```

---

## 10. Archive Semantics

`status = 'archived'` is a status value, a terminal status, and is backed by
companion columns on the same `tasks_tasks` row: `archived_at`,
`archive_reason`, `cycle_time_days`
(`packages/core/src/store/schema/cleo-project/tasks-core.ts:173-177`). There is
no separate archive table.

`cleo archive` archives tasks whose status is `done`, plus `cancelled` ones when
cancelled tasks are included (the default); any other status is skipped
(`packages/core/src/tasks/archive.ts:95`, `:103`, `:124`). Each row is written by
`archiveSingleTask` inside a transaction (`archive.ts:182`). The generic
status map has no `cancelled → archived` edge (§2), which is why the archive
path writes through the accessor rather than the generic validator.

`archive_reason` is one of `verified`, `reconciled`, `superseded`, `shadowed`,
`cancelled`, `completed-unverified` (`packages/contracts/src/enums.ts:110-117`).
The bulk archive path stamps `cancelled` for cancelled tasks, `verified` for
done tasks whose verification passed, and `completed-unverified` otherwise
(`archive.ts:50-60`). `completed-unverified` is a tombstone that new code may
not pass explicitly outside the migration backfill
(`packages/contracts/src/tasks/archive.ts:106-145`).

---

## 11. Workflow Enforcement

Strictness presets, acceptance-criteria rules, sessions, compliance reporting
and backfill (originally Epic T056).

### 11.1 Strictness presets

`cleo config presets` lists them; `cleo config set-preset <strict|standard|minimal>`
applies one. Values: `STRICTNESS_PRESETS` in `packages/core/src/config.ts:498-533`.

| Key | strict | standard | minimal |
|-----|--------|----------|---------|
| `enforcement.acceptance.mode` | `block` | `warn` | `off` |
| `session.requireNotes` | `true` | `false` | `false` |
| `session.multiSession` | `false` | `true` | `true` |
| `lifecycle.mode` | `strict` | `advisory` | `off` |
| `lifecycle.stageGate` | `strict` | (unset) | (unset) |
| `session.autoStart` | `false` | `false` | `false` |

A preset merges over the existing config: keys it does not name are kept, and
applying the same preset twice gives the same result (`config.ts:544-547`).
Individual keys: `cleo config get <key>`, `cleo config set <key> <value>`,
`cleo config list`.

### 11.2 Acceptance criteria

- Tasks need at least `enforcement.acceptance.minimumCriteria` criteria
  (default 3: `packages/core/src/config.ts:56-60`;
  `packages/core/src/tasks/enforcement.ts:46`). Epics need 5 in strict mode
  (`EPIC_MIN_AC`, `packages/core/src/tasks/epic-enforcement.ts:42`).
- `block` refuses creation, update or completion without enough criteria;
  `warn` warns; `off` skips the check (`enforcement.ts:52-105`).
- `--acceptance` is ONE pipe-separated value on both `add` and `update`:

```bash
cleo add "Implement login endpoint" \
  --acceptance "Returns 200 with JWT on valid credentials|Returns 401 on invalid credentials|Rate limiting applied after 5 failed attempts"
cleo update T042 --acceptance "AC1|AC2|AC3"
cleo show T042 --full    # acceptance and verification are withheld without --full
```

### 11.3 Verification gates

New tasks are created with `implemented`, `testsPassed` and `qaPassed` set to
`false` (`buildDefaultVerification`, `packages/core/src/tasks/add.ts:287-301`).
Every gate write needs evidence (§7): `cleo verify <id> --gate <g>` without
`--evidence` returns `E_EVIDENCE_MISSING`, and bare `cleo verify <id> --all` is
rejected the same way. `cleo verify <id> --reset` resets verification;
`cleo verify <id> --explain` shows per-gate evidence and what blocks
`cleo complete`.

### 11.4 Lifecycle stages

```bash
cleo lifecycle show T056
cleo lifecycle start T056 specification
cleo lifecycle complete T056 specification --notes "Spec approved in PR #44"
cleo lifecycle skip T056 consensus --reason "Single author, consensus not needed"
cleo lifecycle gate T056 implementation
```

Other subcommands: `guidance`, `history`, `reset`, `gate-record`.

### 11.5 Sessions

```bash
cleo session start --scope epic:T056 --name "Hardening docs"   # or --scope global
cleo session status
cleo session list
cleo session resume <session-id>
cleo session end --note "..."
```

`--scope` and `--name` are both required. `cleo add` and `cleo complete`
require an active session. The strict preset sets `session.requireNotes: true`.

### 11.6 Compliance monitoring

`cleo stats compliance [--since <ISO date>] [--json]` reports the WF-001 … WF-005
rules (`packages/core/src/stats/workflow-telemetry.ts:228-232`), computed from
the existing `tasks`, `sessions` and `audit_log` data:

| Rule | Level | Requirement |
|------|-------|-------------|
| WF-001 | MUST | Tasks have ≥3 acceptance criteria |
| WF-002 | MUST | Task completions occur within an active session |
| WF-003 | SHOULD | Completed tasks have verification gates set |
| WF-004 | SHOULD | Tasks with verification have all 3 gates set |
| WF-005 | MUST | Tasks have session binding on creation (non-epic) |

MUST rules count double in the weighted score (`workflow-telemetry.ts:454`). The
report carries `overallScore`, `grade` and up to 20 violation samples
(`:483`). Grades (`gradeFromScore`, `:211-218`): A+ ≥ 0.95, A ≥ 0.90,
B ≥ 0.80, C ≥ 0.70, D ≥ 0.60, otherwise F.

Related: `cleo compliance violations`, `cleo compliance skills`,
`cleo compliance summary`.

### 11.7 Backfill

`cleo backfill` (`packages/core/src/backfill/index.ts`) fills tasks that have
no acceptance criteria or no verification record:

1. Generates 3 criteria from the title and description by verb matching
   (`generateAcFromDescription`, `:79`).
2. Initializes verification with the three default gates set to `false`.
3. Adds a note `[T066-backfill] auto-backfilled at <timestamp>: …` (`:145`, `:284`).

```bash
cleo backfill --dry-run            # preview, writes nothing
cleo backfill                      # apply
cleo backfill --tasks T001,T002    # restrict to tasks
cleo backfill --rollback --dry-run
cleo backfill --rollback           # clears AC and verification on tasks carrying the marker note
```

Migration order for an older project: `cleo config set-preset minimal`, run
the backfill, replace generated criteria on important tasks, check
`cleo stats compliance`, then move to `standard` and later `strict`.

---

## References

- **Contract**: `packages/contracts/src/operations/tasks.ts`
- **Operation registry**: `packages/contracts/src/dispatch/operations-registry.ts`
- **Implementation root**: `packages/core/src/tasks/`
- **Dispatch handler**: `packages/cleo/src/dispatch/domains/tasks.ts`
- **Tables**: `packages/core/src/store/schema/cleo-project/tasks-core.ts` (re-exported by `packages/core/src/store/tasks-schema.ts`)
- **Status enum**: `packages/contracts/src/status-registry.ts`
- **Pipeline stages**: `packages/core/src/tasks/pipeline-stage.ts`
- **Archive**: `packages/core/src/tasks/archive.ts`
- **Validation engine**: `packages/core/src/validation/engine.ts`
- **T877 triggers**: `packages/core/migrations/drizzle-cleo-project/20261105120000_t14218-guard-triggers-compare-old/migration.sql`
- **Exit codes**: `packages/contracts/src/exit-codes.ts`
- **HTTP status mapping**: `packages/runtime/src/gateway/http/server.ts`
- **Evidence grammar**: [`docs/spec/gate-integrity.md`](gate-integrity.md)
- **ADR-051**: [`docs/adr/adr-051-programmatic-gate-integrity.md`](../adr/adr-051-programmatic-gate-integrity.md)
- **ADR-088**: [`docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`](../adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md)
- **Operation tables**: [`docs/spec/cleo-operation-constitution.md`](cleo-operation-constitution.md) §6.1
- **External task sync types**: `packages/contracts/src/task-sync.ts`; engine `packages/core/src/reconciliation/`
