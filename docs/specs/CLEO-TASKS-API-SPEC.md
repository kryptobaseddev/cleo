# CLEO Tasks API Specification

**Version**: 1.0.0
**Status**: AUTHORITY (narrative spec, cites code layer)
**Domain**: `tasks`
**Contract file**: `packages/contracts/src/operations/tasks.ts`
**Implementation root**: `packages/core/src/tasks/`
**Dispatch handler**: `packages/cleo/src/dispatch/domains/tasks.ts`
**Authority pointer**: `docs/specs/CLEO-API-AUTHORITY.md` §2

This specification MUST be used by anyone reading, mutating, or exposing task
data. When this spec disagrees with the contract or the registry, the code
wins and this spec is a bug.

> **Related specs**:
> - `docs/specs/CLEO-API-AUTHORITY.md` — authority chain
> - `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` — HTTP exposure and envelope
> - `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` — Studio `/tasks` UI
> - `docs/specs/T832-gate-integrity-spec.md` — evidence grammar (ADR-051)
> - `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
> - `docs/specs/TASK-RECONCILIATION-SPEC.md` — external task links

---

## 1. Overview

The **tasks** domain is the authoritative record of every unit of work in a
CLEO project. A task is a row in `tasks` table in `tasks.db`. Tasks are
typed (`epic` / `task` / `subtask`), linked via `parent_id`, related via
`task_dependencies`, and tracked through two orthogonal axes: **status** and
**pipeline_stage**.

Evidence:
- Schema: `packages/core/src/store/tasks-schema.ts:137-219` (column list)
- Status taxonomy: `packages/contracts/src/status-registry.ts:15-22`
- Pipeline stages: `packages/core/src/tasks/pipeline-stage.ts:54-66`

### Invariants (MUST hold at all times)

- **INV-1 — Status is one of six values.** `status ∈ {pending, active, blocked,
  done, cancelled, archived}`. Source: `packages/contracts/src/status-registry.ts:15-22`.
- **INV-2 — Pipeline stage is one of 11 values OR NULL.** `pipeline_stage ∈
  {research, consensus, architecture_decision, specification, decomposition,
  implementation, validation, testing, release, contribution, cancelled} ∪
  {NULL}`. Source: `packages/core/src/tasks/pipeline-stage.ts:54-66`.
- **INV-3 — T877 coupling.** `status = 'done'` REQUIRES `pipeline_stage ∈
  {contribution, cancelled}`. `status = 'cancelled'` REQUIRES `pipeline_stage
  = 'cancelled'`. Enforced by SQLite triggers in
  `packages/core/migrations/drizzle-tasks/20260417000000_t877-pipeline-stage-invariants/migration.sql:155-173`.
- **INV-4 — Forward-only pipeline.** `isPipelineTransitionForward()` rejects
  backward transitions unless current or new stage is unknown. Source:
  `packages/core/src/tasks/pipeline-stage.ts:285-290`.
- **INV-5 — Terminal archive.** `status = 'archived'` has no outgoing
  transitions. Source: `packages/core/src/validation/engine.ts:403-411`.
- **INV-6 — Evidence-gated completion.** `tasks.complete` REJECTS when any of
  the 5 required gates lacks validated evidence atoms per ADR-051.
  Source: `packages/cleo/src/dispatch/domains/tasks.ts:321-340` +
  `docs/specs/T832-gate-integrity-spec.md`.

---

## 2. Status State Machine

**Canonical taxonomy** (6 values, exact):
`pending | active | blocked | done | cancelled | archived`

Source: `packages/contracts/src/status-registry.ts:15-22`.

Transitions (source: `packages/core/src/validation/engine.ts:403-411`):

```
pending    → [active, blocked, cancelled]
active     → [done, blocked, pending, cancelled]
done       → [pending, archived]
blocked    → [pending, active, cancelled]
cancelled  → [pending]
archived   → []                 (terminal)
```

Diagram:

```
                       ┌───────────┐
                       │  pending  │◄────────┐
                       └─────┬─────┘         │
            ┌────────────────┼────────────────┼────────────────┐
            ▼                ▼                ▼                ▼
      ┌─────────┐      ┌─────────┐      ┌──────────┐     ┌───────────┐
      │ active  │◄────►│ blocked │      │cancelled │     │           │
      └────┬────┘      └────┬────┘      └────┬─────┘     │           │
           │                │                │           │           │
           ▼                ▼                ▼           │           │
      ┌─────────┐           │           (to pending)     │           │
      │  done   │───────────┘                            │           │
      └────┬────┘                                        │           │
           ▼                                             │           │
      ┌──────────┐                                       │           │
      │ archived │  ◄── TERMINAL (no outgoing)           │           │
      └──────────┘                                       └───────────┘
```

Terminal set: `{done, cancelled, archived}` — source
`packages/contracts/src/status-registry.ts:69-73`.

---

## 3. Pipeline Stage

`pipeline_stage` is an **orthogonal** column to `status`. It tracks where a
task is in the RCASD-IVTR+C lifecycle. A task MAY progress through pipeline
stages while remaining `status = 'active'`.

Canonical stages (11 values, order-significant):

| # | Stage | Terminal? | Purpose |
|---|-------|-----------|---------|
| 1 | `research` | No | Explore problem space |
| 2 | `consensus` | No | Multi-agent agreement |
| 3 | `architecture_decision` | No | ADR captured (labelled "Design / ADR" in UI per T880) |
| 4 | `specification` | No | Spec written |
| 5 | `decomposition` | No | Broken into atomic tasks |
| 6 | `implementation` | No | Code written |
| 7 | `validation` | No | Reviewed / validated |
| 8 | `testing` | No | Tests green |
| 9 | `release` | No | Shipped |
| 10 | `contribution` | **Yes** | Done + lessons captured |
| 11 | `cancelled` | **Yes** | Terminal marker for cancelled tasks |

Source: `packages/core/src/tasks/pipeline-stage.ts:54-66`.

A sibling enum `LIFECYCLE_STAGE_NAMES` at
`packages/core/src/store/tasks-schema.ts:87-98` lists stages 1–10 only (no
`cancelled`) for the `lifecycle_stages.stage_name` column. The 11th marker
lives ONLY on `tasks.pipeline_stage`. This divergence is intentional per
`packages/core/src/tasks/pipeline-stage.ts:48-53`.

### Status × pipeline_stage coupling (T877)

INV-3 above is enforced by SQLite triggers at
`packages/core/migrations/drizzle-tasks/20260417000000_t877-pipeline-stage-invariants/migration.sql:155-173`.
Attempts that would violate it raise `T877_INVARIANT_VIOLATION` at
INSERT/UPDATE time.

| `status` | Legal `pipeline_stage` |
|----------|------------------------|
| `pending` | any of 11 |
| `active` | any of 11 |
| `blocked` | any of 11 |
| `done` | `contribution` OR `cancelled` ONLY |
| `cancelled` | `cancelled` ONLY |
| `archived` | inherited from pre-archive state |

---

## 4. The "Deferred" Clarification

There is NO `deferred` status, column, or enum value. `deferred` appears
**exclusively as a Studio UI synonym** for `status = 'cancelled'` applied
to `type = 'epic'` rows, toggled by the URL query param `?deferred=1`.

**Evidence** (cited verbatim from the audit):

- `packages/studio/src/routes/tasks/+page.server.ts:151` reads the URL:
  `const showDeferred = url.searchParams.get('deferred') === '1';`
- `packages/studio/src/routes/tasks/+page.server.ts:109-112`:
  ```ts
  const epicFilter = includeDeferred
    ? `status != 'archived'`
    : `status NOT IN ('archived','cancelled')`;
  ```
- `packages/studio/src/routes/tasks/+page.svelte:384-391` renders a
  `deferred` badge on cancelled epics when the toggle is on.
- T878/T900 design note in `+page.server.ts:96-97`: *"status is now returned
  so the UI can render a 'Deferred' badge, and `cancelled` bucket is surfaced
  for the same reason."*

Grep confirmation that `deferred` is NOT in Layer-1:

- Absent from `packages/contracts/src/status-registry.ts`.
- Absent from `packages/core/src/store/tasks-schema.ts`.
- Absent from every `migration.sql` under
  `packages/core/migrations/drizzle-tasks/`.
- `packages/core/src/tasks/crossref-extract.ts:13,20` uses `'deferred-to'`
  as a **relation type** (`task_relations.relation_type`), NOT a status.

### Recommendation (PROPOSED — @HITL)

Rename the Studio UI filter label from "Show deferred epics" to
**"Show cancelled epics"**. The URL param `?deferred=1` MAY stay for backward
compatibility with bookmarks, but the rendered label and tooltip MUST match the
underlying data. See `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §10.

### Agent guidance (non-negotiable)

Agents MUST NOT use `deferred` as if it were a status. Any code path that
writes `status = 'deferred'` is a bug; the SQLite column enum will reject
it. Use `status = 'cancelled'` with `pipeline_stage = 'cancelled'` and,
separately, display as "Deferred" in UI if the filter is active.

---

## 5. Operation Catalogue

The **tasks** contract at `packages/contracts/src/operations/tasks.ts`
declares **22 operations** (10 query + 12 mutate). The registry
(`packages/cleo/src/dispatch/registry.ts`) registers additional wrapping ops
such as `tasks.sync.reconcile`, `tasks.claim`, `tasks.unclaim`,
`tasks.complexity.estimate`, and `tasks.label.list` — see
`docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.1 for the fully-enumerated
runtime list (32 ops at v2026.4.42).

Each row cites `packages/cleo/src/dispatch/domains/tasks.ts` (the dispatch
surface). Error codes are drawn from
`packages/contracts/src/exit-codes.ts` and mapped to HTTP status per
`docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §3.

> **Legend**
> - HTTP column: either `verb /path` (currently exposed by Studio) or `(CLI only)` (MUST NOT be assumed reachable over HTTP today). Proposed additions are marked `PROPOSED verb /path`.
> - Idempotent: "yes" iff same request body → same final state; retries are safe.

### 5.1 Query operations

| Op | CLI verb | HTTP | Params | Result | Error codes | Idempotent | Description | Cite |
|----|----------|------|--------|--------|-------------|------------|-------------|------|
| `tasks.show` | `cleo show <id>` | `GET /api/tasks/:id` | `taskId`, `history?`, `ivtrHistory?` | `{ task, subtasks }` | `NOT_FOUND` (404) | yes | Single task + its subtasks | `tasks.ts:78-91` |
| `tasks.list` | `cleo list --parent` | `GET /api/tasks` (limited) | `parent?`, `status?`, `priority?`, `type?`, `phase?`, `label?`, `children?`, `limit?`, `offset?`, `compact?` | `{ tasks, total }` | `VALIDATION_ERROR` (400) | yes | Filter-scoped task list | `tasks.ts:93-107` |
| `tasks.find` | `cleo find "query"` | `GET /api/tasks/search` | `query`, `limit?`, `id?`, `exact?`, `status?`, `includeArchive?`, `offset?`, `fields?`, `verbose?` | `{ kind, task?, tasks?, total? }` | `VALIDATION_ERROR` (400) | yes | ID lookup or fuzzy title/description search | `tasks.ts:109-125` |
| `tasks.exists` | `cleo exists <id>` | PROPOSED `HEAD /api/tasks/:id` | `taskId` | `{ exists: boolean }` | — | yes | Non-throwing existence check | (PROPOSED) |
| `tasks.tree` | `cleo tree <id>` | `GET /api/tasks/tree/:epicId` | `taskId?` | `{ epic: TreeNode, stats }` | `NOT_FOUND` (404) | yes | Recursive subtree (500-cap) | `tasks.ts:127-131` |
| `tasks.blockers` | `cleo blockers` | PARTIAL `GET /api/tasks/:id/deps` | `analyze?`, `limit?` | `{ blockers }` | — | yes | Enumerates upstream-blocked tasks | `tasks.ts:133-139` |
| `tasks.depends` | `cleo deps <id>` | `GET /api/tasks/:id/deps` | `taskId?`, `action?` ({overview, cycles}), `direction?` ({upstream, downstream, both}), `tree?` | `{ taskId, upstream, downstream, allUpstreamReady, blockedCount, blockingCount }` | `NOT_FOUND` (404) | yes | Upstream + downstream dep graph | `tasks.ts:141-168` |
| `tasks.analyze` | `cleo analyze` | PROPOSED `GET /api/tasks/analyze` | `taskId?`, `tierLimit?` | `{ analysis }` | — | yes | Aggregate analytics | `tasks.ts:170-175` |
| `tasks.impact` | `cleo impact` | PROPOSED `GET /api/tasks/impact` | `change` (required), `matchLimit?` | `{ matches }` | `VALIDATION_ERROR` (400) | yes | Keyword-match tasks affected by a change | `tasks.ts:177-192` |
| `tasks.next` | `cleo next` | PROPOSED `GET /api/tasks/next` | `count?`, `explain?` | `{ candidates }` | — | yes | Next-best-work suggestions | `tasks.ts:194-200` |
| `tasks.plan` | `cleo plan` | PROPOSED `GET /api/tasks/plan` | — | `{ plan }` | — | yes | Composite multi-query view | `tasks.ts:202-205` |
| `tasks.relates` | `cleo relates <id>` | PROPOSED `GET /api/tasks/:id/relates` | `taskId`, `mode?` ({suggest, discover}), `threshold?` | `{ related }` | `NOT_FOUND` (404) | yes | Find related tasks | `tasks.ts:207-219` |
| `tasks.complexity.estimate` | `cleo complexity <id>` | PROPOSED `GET /api/tasks/:id/complexity` | `taskId` | `{ estimate }` | `NOT_FOUND` (404) | yes | Heuristic sizing estimate | `tasks.ts:221-226` |
| `tasks.current` | `cleo current` | PROPOSED `GET /api/tasks/current` | — | `{ task? }` | — | yes | Current active task for session | `tasks.ts:228-231` |
| `tasks.history` | `cleo history [<id>]` | PROPOSED `GET /api/tasks/:id/history` | `taskId?`, `limit?` | `{ events }` | — | yes | Task lifecycle audit | `tasks.ts:233-241` |
| `tasks.label.list` | `cleo label list` | PROPOSED `GET /api/tasks/labels` | — | `{ labels }` | — | yes | Distinct labels across project | `tasks.ts:243-246` |
| `tasks.sync.links` | `cleo sync links` | PROPOSED `GET /api/tasks/sync/links` | `providerId?`, `taskId?` | `{ links }` | — | yes | External task link inventory | `tasks.ts:248-254` |

### 5.2 Mutate operations

| Op | CLI verb | HTTP | Params | Result | Error codes | Idempotent | Description | Cite |
|----|----------|------|--------|--------|-------------|------------|-------------|------|
| `tasks.add` | `cleo add` | PROPOSED `POST /api/tasks` | `title`, `description?`, `parent?`, `depends?`, `priority?`, `labels?`, `type?`, `acceptance?`, `phase?`, `size?`, `notes?`, `files?`, `dryRun?`, `parentSearch?` | `{ task }` | `VALIDATION_ERROR` (400), `PARENT_NOT_FOUND` (404), `DEPTH_EXCEEDED` (409), `SIBLING_LIMIT` (409), `INVALID_PARENT_TYPE` (409), `ID_COLLISION` (409) | NO | Create a task/epic/subtask | `tasks.ts:278-296` |
| `tasks.update` | `cleo update <id>` | PROPOSED `PATCH /api/tasks/:id` | `taskId` + any `add` field + `addLabels?`, `removeLabels?`, `addDepends?`, `removeDepends?`, `pipelineStage?` | `{ task, changes }` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `TASK_COMPLETED` (409), `LIFECYCLE_GATE_FAILED` (422), `CIRCULAR_REFERENCE` (409) | yes | Partial update; forward-only pipeline_stage | `tasks.ts:298-319` |
| `tasks.complete` | `cleo complete <id>` | PROPOSED `POST /api/tasks/:id/complete` | `taskId`, `notes?` (REJECTS `force`) | `{ task, gates }` | `NOT_FOUND` (404), `E_EVIDENCE_MISSING` (422), `E_EVIDENCE_INSUFFICIENT` (422), `E_EVIDENCE_STALE` (422), `E_EVIDENCE_TESTS_FAILED` (422), `E_EVIDENCE_TOOL_FAILED` (422), `LIFECYCLE_GATE_FAILED` (422), `FLAG_REMOVED` (410 on `force:true`) | yes | ADR-051 evidence-gated completion | `tasks.ts:321-340` |
| `tasks.delete` | `cleo delete <id>` | PROPOSED `DELETE /api/tasks/:id` | `taskId`, `force?` | `{ deletedIds }` | `NOT_FOUND` (404), `HAS_CHILDREN` (409), `HAS_DEPENDENTS` (409), `CASCADE_FAILED` (500) | yes | Permanent removal (default rejects if children) | `tasks.ts:342-349` |
| `tasks.archive` | `cleo archive [<id>]` | PROPOSED `POST /api/tasks/:id/archive` | `taskId?`, `before?`, `taskIds?`, `includeCancelled?`, `dryRun?` | `{ archived }` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400) | yes | Soft-archive (bulk or single) | `tasks.ts:351-363` |
| `tasks.restore` | `cleo restore <id>` | PROPOSED `POST /api/tasks/:id/restore` | `taskId`, `from?` ({done, archived}), `status?`, `reason?`, `preserveStatus?`, `cascade?`, `notes?` | `{ task }` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400) | yes | Restore from any terminal state | `tasks.ts:365-388` |
| `tasks.cancel` | `cleo cancel <id>` | PROPOSED `POST /api/tasks/:id/cancel` | `taskId`, `reason?` | `{ task }` | `NOT_FOUND` (404), `TASK_COMPLETED` (409) | yes | Soft terminal (reversible) | `tasks.ts:390-397` |
| `tasks.reparent` | `cleo reparent <id> <newParent>` | PROPOSED `POST /api/tasks/:id/reparent` | `taskId`, `newParentId` (string OR null) | `{ task }` | `NOT_FOUND` (404), `CIRCULAR_REFERENCE` (409), `INVALID_PARENT_TYPE` (409) | yes | Move task under new parent; `null` reroots | `tasks.ts:399-406` |
| `tasks.reorder` | `cleo reorder <id> <pos>` | PROPOSED `POST /api/tasks/:id/reorder` | `taskId`, `position` | `{ task }` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400) | yes | Change sibling order | `tasks.ts:408-415` |
| `tasks.relates.add` | `cleo relates add <id> <related>` | PROPOSED `POST /api/tasks/:id/relates` | `taskId`, `relatedId\|targetId`, `type`, `reason?` | `{ relation }` | `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `ALREADY_EXISTS` (200 `NO_CHANGE`) | yes | Record a relation between tasks | `tasks.ts:417-438` |
| `tasks.start` | `cleo start <id>` | PROPOSED `POST /api/tasks/:id/start` | `taskId` | `{ task, sessionId }` | `NOT_FOUND` (404), `SESSION_REQUIRED` (409), `TASK_CLAIMED` (409), `TASK_NOT_IN_SCOPE` (409) | yes | Set as current task for active session | `tasks.ts:440-443` |
| `tasks.stop` | `cleo stop` | PROPOSED `POST /api/tasks/stop` | — | `{ previousTaskId }` | — | yes | Stop current task (session-scoped) | `tasks.ts:445-448` |
| `tasks.sync.reconcile` | `cleo sync reconcile` | PROPOSED `POST /api/tasks/sync/reconcile` | `providerId`, `externalTasks`, `dryRun?`, `conflictPolicy?`, `defaultPhase?`, `defaultLabels?` | `{ reconciled, conflicts }` | `VALIDATION_ERROR` (400), `CONFLICT_POLICY_FAILED` (409) | yes | External task link reconciliation | `tasks.ts:450-460` |
| `tasks.sync.links.remove` | `cleo sync links remove` | PROPOSED `DELETE /api/tasks/sync/links` | `providerId` | `{ removed }` | — | yes | Drop all links from provider | `tasks.ts:462-465` |
| `tasks.claim` | `cleo claim <id>` | PROPOSED `POST /api/tasks/:id/claim` | `taskId`, `agentId` | `{ task }` | `NOT_FOUND` (404), `TASK_CLAIMED` (409) | yes | Lock a task to a single agent | `tasks.ts:467-492` |
| `tasks.unclaim` | `cleo unclaim <id>` | PROPOSED `POST /api/tasks/:id/unclaim` | `taskId` | `{ task }` | `NOT_FOUND` (404) | yes | Release an agent claim | `tasks.ts:494-508` |

---

## 6. Error Code Map (tasks-relevant subset)

Full enum at `packages/contracts/src/exit-codes.ts:11-160`. The table below
lists only codes that can surface from `tasks.*` operations.

| ExitCode | Value | HTTP | When it fires |
|----------|------:|------|---------------|
| `SUCCESS` | 0 | 200 | Normal success |
| `INVALID_INPUT` | 2 | 400 | Arg shape wrong |
| `NOT_FOUND` | 4 | 404 | `taskId` does not exist |
| `VALIDATION_ERROR` | 6 | 400 | Business rule violation |
| `LOCK_TIMEOUT` | 7 | 423 | Concurrent SQLite lock |
| `PARENT_NOT_FOUND` | 10 | 404 | Parent taskId missing |
| `HAS_CHILDREN` | 16 | 409 | Delete without cascade |
| `HAS_DEPENDENTS` | 19 | 409 | Delete with downstream deps |
| `CONCURRENT_MODIFICATION` | 21 | 409 | Row version mismatch |
| `SESSION_EXISTS` | 30 | 409 | Already-active session conflict |
| `SESSION_NOT_FOUND` | 31 | 404 | start/stop without session |
| `TASK_CLAIMED` | 35 | 409 | Claim collision |
| `SESSION_CLOSE_BLOCKED` | 37 | 409 | Session has unfinished work |
| `INVALID_GATE` | 42 | 400 | Unknown gate name on verify |
| `LIFECYCLE_GATE_FAILED` | 80 | 422 | Gate not satisfied |
| `AUDIT_MISSING` | 81 | 422 | No audit trail for op |
| `PROVENANCE_REQUIRED` | 84 | 422 | Missing provenance metadata |
| `E_EVIDENCE_MISSING` | — | 422 | ADR-051 gate lacks evidence |
| `E_EVIDENCE_INSUFFICIENT` | — | 422 | Atom kind wrong for gate |
| `E_EVIDENCE_STALE` | — | 422 | Files/commits changed post-verify |
| `E_EVIDENCE_TESTS_FAILED` | — | 422 | Test-run atom reports failures |
| `E_EVIDENCE_TOOL_FAILED` | — | 422 | Tool atom exited non-zero |
| `E_FLAG_REMOVED` | — | 410 | `force:true` removed per ADR-051 |

HTTP mapping is centralised (PROPOSED) in a `dispatchAsHttp()` helper — see
`docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §4.

---

## 7. Evidence-Gate Contract (ADR-051)

Per `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`, `tasks.complete` is
NOT callable without evidence atoms. The 5 canonical gates and their
required atom kinds are specified in
`docs/specs/T832-gate-integrity-spec.md` and summarised here.

| Gate | Purpose | Required atoms (one-of or all) | Emergency override |
|------|---------|--------------------------------|---------------------|
| `implemented` | Code shipped | `commit:<sha>` AND `files:<list>` | `CLEO_OWNER_OVERRIDE=1` + reason |
| `testsPassed` | Tests green | `tool:pnpm-test` OR `test-run:<json>` | same |
| `qaPassed` | Lint/type clean | `tool:biome` AND `tool:tsc` | same |
| `documented` | Docs updated | `files:<docs-paths>` OR `url:<live-url>` | same |
| `securityPassed` | Security OK | `tool:security-scan` OR `note:<waiver>` | same |
| `cleanupDone` | Repo tidy | `note:<summary>` | same |

**Re-validation** happens at `tasks.complete` time. CLEO re-checks hard atoms
(commit reachable, file sha256 match, test-run hash match). Tampering between
`verify` and `complete` raises `E_EVIDENCE_STALE` and forces re-verify.

The legacy `--force` flag is REMOVED (`E_FLAG_REMOVED` on attempt). Owner
override MUST go through `CLEO_OWNER_OVERRIDE=1` + `CLEO_OWNER_OVERRIDE_REASON`,
which appends a line to `.cleo/audit/force-bypass.jsonl`.

Legal sequence at the CLI:

```bash
cleo verify T### --gate implemented \
  --evidence "commit:<sha>;files:path/a.ts,path/b.ts"
cleo verify T### --gate testsPassed  --evidence "tool:pnpm-test"
cleo verify T### --gate qaPassed     --evidence "tool:biome;tool:tsc"
cleo verify T### --gate documented   --evidence "files:docs/spec.md"
cleo verify T### --gate securityPassed --evidence "tool:security-scan"
cleo verify T### --gate cleanupDone  --evidence "note:removed dead branches"
cleo complete T###
```

The HTTP equivalent (PROPOSED) is `POST /api/tasks/:id/verify` per
`docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §2.

---

## 8. External Task Links (sync)

`tasks.sync.*` operations reconcile external provider IDs against CLEO
tasks. Canonical reference:
`docs/specs/TASK-RECONCILIATION-SPEC.md`. This spec does not duplicate
content; it documents only the HTTP-exposure question:

Today: not exposed via HTTP. `tasks.sync.reconcile` is CLI-only.
PROPOSED: `POST /api/tasks/sync/reconcile` per §5.2 above.

---

## 9. Archive Semantics

`status = 'archived'` is both (a) a status enum value, (b) a terminal status,
AND (c) backed by three companion columns on the SAME `tasks` row:
`archived_at`, `archive_reason`, `cycle_time_days`.

Evidence: `packages/core/src/store/tasks-schema.ts:181-184`.

There is NO separate archive table. `cleo archive` flips
`status = 'archived'` and populates the companion columns atomically via
`archiveSingleTask()` at
`packages/core/src/tasks/archive.ts:111-114`.

Archive is triggered only from `status ∈ {done, cancelled}` (source:
`packages/core/src/tasks/archive.ts:51,72-75`). The generic
`validateStatusTransition` map does not include `cancelled → archived`, which
is why `archive.ts` uses the direct accessor call (intentional archive-path
write that bypasses the generic validator).

`archive_reason` is exactly one of `{'completed', 'cancelled'}`.

---

## 10. Contract Gaps

These operations exist today but are NOT exposed via HTTP. They are marked
PROPOSED in §5 above and slated for implementation via the HTTP adapter
described in `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §4.

**Read gaps** (CLI-only today):
`tasks.exists`, `tasks.analyze`, `tasks.impact`, `tasks.next`, `tasks.plan`,
`tasks.relates`, `tasks.complexity.estimate`, `tasks.current`, `tasks.history`,
`tasks.label.list`, `tasks.sync.links`.

**Write gaps** (CLI-only today — all 16 mutate ops):
`tasks.add`, `tasks.update`, `tasks.complete`, `tasks.delete`, `tasks.archive`,
`tasks.restore`, `tasks.cancel`, `tasks.reparent`, `tasks.reorder`,
`tasks.relates.add`, `tasks.start`, `tasks.stop`, `tasks.sync.reconcile`,
`tasks.sync.links.remove`, `tasks.claim`, `tasks.unclaim`.

Studio exposes **0 tasks writes** today (verified in
`.cleo/agent-outputs/T910-docs-audit/http-endpoint-inventory.md` §2 TASKS).

See `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §2 proposed-additions table for
the full mapping and request/response shapes.

---

## 11. Open Questions (HITL)

- **Q1 — "Deferred" label** (`@HITL`). Rename Studio UI label to "Show
  cancelled epics"? See §4. Blocks CLEO-TASK-DASHBOARD-SPEC.md §10.
- **Q2 — `tasks.claim` / `tasks.unclaim` workflow** (`@HITL`). Constitution
  lists them; no spec explains the intended multi-agent lock workflow. Draft
  needed.
- **Q3 — `tasks.impact` keyword-match algorithm** (`@HITL`). Constitution +
  archived `docs/archive/CLEO-API.md` §15 reference the concept; no algorithm
  spec exists. Source: `tasks.ts:177-192` takes a `change` string and
  `matchLimit?`; semantics unspecified.
- **Q4 — DELETE cascade default** (`@HITL`). CLI defaults to REJECT
  (`HAS_CHILDREN 16`). HTTP should mirror this — confirm.
- **Q5 — `tasks.complete` with `force:true`** (`@HITL`). `410 Gone` vs `400
  FLAG_REMOVED`? `410` is semantically accurate but some clients confuse it
  with CORS. Owner call.

---

## References

- **Contract**: `packages/contracts/src/operations/tasks.ts`
- **Implementation root**: `packages/core/src/tasks/` (38 files, 11K LoC)
- **Dispatch handler**: `packages/cleo/src/dispatch/domains/tasks.ts`
- **Registry**: `packages/cleo/src/dispatch/registry.ts`
- **Schema**: `packages/core/src/store/tasks-schema.ts`
- **Status enum**: `packages/contracts/src/status-registry.ts`
- **Pipeline stages**: `packages/core/src/tasks/pipeline-stage.ts`
- **Archive**: `packages/core/src/tasks/archive.ts`
- **Validation engine**: `packages/core/src/validation/engine.ts`
- **T877 migration**:
  `packages/core/migrations/drizzle-tasks/20260417000000_t877-pipeline-stage-invariants/migration.sql`
- **Exit codes**: `packages/contracts/src/exit-codes.ts`
- **LAFS envelope**: `packages/contracts/src/lafs.ts`
- **Evidence grammar**: `docs/specs/T832-gate-integrity-spec.md`
- **ADR-051**: `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- **Constitution**: `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.1
- **Audit evidence**: `.cleo/agent-outputs/T910-docs-audit/task-schema-audit.md`,
  `.cleo/agent-outputs/T910-docs-audit/api-docs-inventory.md` §TASKS

---

**End.**
