# Task Schema Audit — Is `deferred` a Real Status?

**Audit date**: 2026-04-17
**Scope**: CLEO task status taxonomy, pipeline stages, archive semantics, and the `deferred` concept across the monorepo.
**Verdict**: `deferred` is **NOT a real task status**. It is a pure Studio UI synonym for `status = 'cancelled'` rendered with a special badge.

---

## Executive Summary (one bullet per question)

- **Q1 — Canonical statuses**: 6 values, defined exactly once in `packages/contracts/src/status-registry.ts:15-22` → `['pending','active','blocked','done','cancelled','archived']`. Matches Drizzle `tasks.status` column enum in `packages/core/src/store/tasks-schema.ts:143-147`.
- **Q2 — Is `deferred` real?** No. It is NOT in `TASK_STATUSES`, NOT a column, NOT in any migration, NOT in any CHECK constraint. It exists solely in Studio as a URL filter (`?deferred=1`) and a CSS badge that re-labels cancelled epics as "deferred" in the Epic Progress panel.
- **Q3 — Status vs pipeline_stage independence**: They are structurally independent COLUMNS but constrained by T877 migration triggers. `status='done'` REQUIRES `pipeline_stage IN ('contribution','cancelled')`; `status='cancelled'` REQUIRES `pipeline_stage='cancelled'`. So `status='done'` with `pipeline_stage='research'` is ILLEGAL and raises `T877_INVARIANT_VIOLATION` at the SQLite trigger level.
- **Q4 — `pipeline_stage` values**: 11 canonical values (RCASD-IVTR+C) defined in `packages/core/src/tasks/pipeline-stage.ts:54-66` → `research, consensus, architecture_decision, specification, decomposition, implementation, validation, testing, release, contribution, cancelled`. The 10-stage core sequence is named "RCASD-IVTR+C" in `packages/core/src/tasks/pipeline-stage.ts:7-17`. A parallel (but NOT identical) enum `LIFECYCLE_STAGE_NAMES` in `tasks-schema.ts:87-98` lists the first 10 stages for the `lifecycle_stages.stage_name` column.
- **Q5 — `archived`**: It is ALL THREE ways: (a) a `TaskStatus` enum value in `status-registry.ts:21`, (b) a terminal status in `TERMINAL_TASK_STATUSES` at line 72, AND (c) backed by three archive-metadata columns on the SAME `tasks` table: `archived_at`, `archive_reason`, `cycle_time_days` (`tasks-schema.ts:182-184`). No separate archive table. `cleo archive` flips `status='archived'` and populates those columns atomically.

---

## 1. Canonical Task Status Taxonomy

### Source of truth: `packages/contracts/src/status-registry.ts:15-22`

```
TASK_STATUSES = ['pending','active','blocked','done','cancelled','archived']
```

### Drizzle column enforcement: `packages/core/src/store/tasks-schema.ts:143-147`

```ts
status: text('status', { enum: TASK_STATUSES })
  .notNull()
  .default('pending'),
```

### Terminal set: `packages/contracts/src/status-registry.ts:69-73`

```
TERMINAL_TASK_STATUSES = { 'done', 'cancelled', 'archived' }
```

### Status transition state machine

Defined in `packages/core/src/validation/engine.ts:403-411`:

```
pending    → [active, blocked, cancelled]
active     → [done, blocked, pending, cancelled]
done       → [pending, archived]
blocked    → [pending, active, cancelled]
cancelled  → [pending]
archived   → []              (terminal; no outgoing transitions)
```

ASCII state diagram:

```
                       ┌───────────┐
                       │  pending  │◄─────────┐
                       └─────┬─────┘          │
            ┌────────────────┼────────────────┼────────────────┐
            ▼                ▼                ▼                ▼
      ┌─────────┐      ┌─────────┐      ┌──────────┐    ┌───────────┐
      │ active  │◄────►│ blocked │      │cancelled │    │           │
      └────┬────┘      └────┬────┘      └────┬─────┘    │           │
           │                │                │          │           │
           ▼                ▼                ▼          │           │
      ┌─────────┐           │           (to pending)    │           │
      │  done   │───────────┘                           │           │
      └────┬────┘                                       │           │
           ▼                                            │           │
      ┌──────────┐                                      │           │
      │ archived │  ◄── TERMINAL (no outgoing)          │           │
      └──────────┘                                      └───────────┘
```

---

## 2. Is `deferred` a Real Status, Field, or Neither?

### Grep evidence (exhaustive, `packages/**/*.ts` + `*.svelte` + `*.md`, excludes node_modules)

| Where `deferred` appears | What it means |
|--------------------------|---------------|
| `packages/contracts/src/status-registry.ts` | **NOT present**. Not a `TaskStatus`. |
| `packages/core/src/store/tasks-schema.ts` | **NOT present**. Not a column, not in any CHECK constraint. |
| Any `migration.sql` in `packages/*/migrations/drizzle-tasks/**/*.sql` | **NOT present**. No schema ever contained the word. |
| `packages/core/src/tasks/crossref-extract.ts:13,20` | A `RelatesType` enum value `'deferred-to'` — this is a **cross-reference relation type**, not a task status. Used for linking tasks via `task_relations.relation_type`. |
| `packages/cleo-os/src/registry/provider-matrix.ts:8` | Prose mention in a comment only. |
| `packages/nexus/src/pipeline/*.ts` | "Deferred execution" in extraction pipeline (unrelated to tasks). |
| `packages/adapters/src/providers/claude-sdk/session-store.ts:9` | "Persistence is intentionally deferred" — prose. |
| `packages/studio/src/routes/tasks/+page.server.ts` | URL filter `?deferred=1`, field `showDeferred: boolean`, option `includeDeferred` on `_computeEpicProgress`. **See below**. |
| `packages/studio/src/routes/tasks/+page.svelte:17-18, 349-356, 384-390, 802-806` | UI toggle chip labelled "Show deferred epics" and CSS class `.epic-deferred`. |
| `packages/studio/src/routes/tasks/__tests__/dashboard-filters.test.ts` | Tests for the UI filter. |
| `CHANGELOG.md`, `docs/plans/*.md` | Prose English ("deferred to follow-up"). Not schema. |

### Answer grid

- **Is `deferred` a status enum value?** **NO.** Grep of `status-registry.ts` shows the 6 canonical values; `deferred` is absent.
- **Is `deferred` a field name on the `tasks` table?** **NO.** `tasks-schema.ts:137-219` lists every column; there is no `deferred`, `deferredAt`, or similar.
- **Does Studio have a "Deferred" filter/button?** **YES.** See `packages/studio/src/routes/tasks/+page.svelte:349-357`:

```svelte
<a href={toggleUrl('deferred')}
   class="filter-chip"
   class:active={filters.showDeferred}
   title="Show deferred / cancelled epics in the Epic Progress panel">
  <span class="chip-check">{filters.showDeferred ? '✓' : ' '}</span>
  Show deferred epics
</a>
```

### What does clicking "Show deferred epics" actually do? (trace)

1. The chip `<a href={toggleUrl('deferred')}>` toggles the URL query param `?deferred=1`.
2. `packages/studio/src/routes/tasks/+page.server.ts:151` reads it: `const showDeferred = url.searchParams.get('deferred') === '1'`.
3. It is passed to `_computeEpicProgress(db, { includeDeferred: showDeferred })`.
4. Inside that function (`+page.server.ts:106-112`):

```ts
const epicFilter = includeDeferred
  ? `status != 'archived'`
  : `status NOT IN ('archived','cancelled')`;
```

5. So "deferred" is a **pure display synonym** for `status = 'cancelled'` on `type = 'epic'` rows. By default, the Epic Progress panel hides cancelled epics; the toggle un-hides them. They render with a `deferred` badge (`+page.svelte:389-391`) and a dimmed CSS class `.epic-deferred` (`+page.svelte:802-806`).

The T878/T900 design note in `+page.server.ts:96-97` confirms: *"T878: `status` is now returned so the UI can render a 'Deferred' badge, and `cancelled` bucket is surfaced for the same reason."*

> **Conclusion: `deferred` is a Studio-only UI synonym for cancelled epics. There is no `deferred` status, no `deferred` column, no `deferred` enum value, no `deferred` migration, and no backing state machine transition. An agent using "deferred" as if it were a canonical status will produce invalid data.**

---

## 3. Pipeline Stage vs Status — Independence & Invariants

### Both are separate columns on `tasks`

From `packages/core/src/store/tasks-schema.ts:143-147, 198`:

```ts
status: text('status', { enum: TASK_STATUSES }).notNull().default('pending'),
// ...
pipelineStage: text('pipeline_stage'),  // NO enum constraint at Drizzle level
```

- `status` is CHECK-constrained via the Drizzle enum to `TASK_STATUSES`.
- `pipeline_stage` is a free text column at Drizzle level (no enum), but runtime validation in `packages/core/src/tasks/pipeline-stage.ts:142-173` rejects anything not in `TASK_PIPELINE_STAGES`.

### Invariants enforced by T877 migration (SQLite TRIGGERS)

Source: `packages/cleo/migrations/drizzle-tasks/20260417000000_t877-pipeline-stage-invariants/migration.sql:155-173`

```sql
CREATE TRIGGER trg_tasks_status_pipeline_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN (NEW.status = 'done'      AND (NEW.pipeline_stage IS NULL OR NEW.pipeline_stage NOT IN ('contribution','cancelled')))
  OR (NEW.status = 'cancelled' AND (NEW.pipeline_stage IS NULL OR NEW.pipeline_stage != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: ...');
END;
```

(Matching UPDATE trigger on the same file, lines 165-173.)

### Semantic rules (what is actually possible)

| `status` | Legal `pipeline_stage` values | Notes |
|----------|-------------------------------|-------|
| `pending` | Any of the 11 canonical stages | Commonly `research`/`implementation`/etc. |
| `active` | Any of the 11 canonical stages | Stage indicates current work phase. |
| `blocked` | Any of the 11 | Orthogonal. |
| `done` | Only `contribution` OR `cancelled` | Trigger-enforced. |
| `cancelled` | Only `cancelled` | Trigger-enforced. |
| `archived` | Inherited from pre-archive state | No trigger explicitly constrains archived rows. |

**Answer to "can `status='done'` coexist with `pipeline_stage='research'`?"** — **NO.** The T877 trigger raises `ABORT` at INSERT/UPDATE time.

### Kanban (by `status`) vs Pipeline (by `pipeline_stage`) distinction

The operator's memory is correct: these are independent view axes. The `status` axis drives Kanban-style views (`pending → active → done`), while `pipeline_stage` drives the RCASD-IVTR+C pipeline view. T877 couples them only at the terminal boundary so terminated rows cannot claim to be in mid-pipeline stages.

---

## 4. What IS `pipeline_stage` Exactly?

### Concept: "RCASD-IVTR+C"

Named in `packages/core/src/tasks/pipeline-stage.ts:7-17` header comment:

```
* Stages (in order):
*   1. research
*   2. consensus
*   3. architecture_decision
*   4. specification
*   5. decomposition
*   6. implementation
*   7. validation
*   8. testing
*   9. release
*  10. contribution  (cross-cutting, treated as terminal)
```

Also cross-referenced in `memory-bridge.md`: *"RCASD-IVTR+C Lifecycle Model — RCASD planning + IVTR execution + Contribution"*.

### Canonical list with order — `packages/core/src/tasks/pipeline-stage.ts:54-66`

```ts
export const TASK_PIPELINE_STAGES = [
  'research',                // 1
  'consensus',               // 2
  'architecture_decision',   // 3
  'specification',           // 4
  'decomposition',           // 5
  'implementation',          // 6
  'validation',              // 7
  'testing',                 // 8
  'release',                 // 9
  'contribution',            // 10  (terminal — success)
  'cancelled',               // 11  (terminal — cancelled)
] as const;
```

### Parallel (and slightly divergent) enum: `LIFECYCLE_STAGE_NAMES`

`packages/core/src/store/tasks-schema.ts:87-98` defines:

```ts
export const LIFECYCLE_STAGE_NAMES = [
  'research','consensus','architecture_decision','specification',
  'decomposition','implementation','validation','testing',
  'release','contribution',
] as const;  // 10 entries — MISSING 'cancelled'
```

This is the enum for `lifecycle_stages.stage_name`. It is 10 entries; `TASK_PIPELINE_STAGES` adds `cancelled` as an 11th terminal marker. This divergence is intentional per `pipeline-stage.ts:48-53`: the `cancelled` marker is only used on `tasks.pipeline_stage`, never on `lifecycle_stages.stage_name`.

### Terminal stages — `packages/core/src/tasks/pipeline-stage.ts:95-98`

```
TERMINAL_PIPELINE_STAGES = { 'contribution', 'cancelled' }
```

### Transition rule — forward-only, `pipeline-stage.ts:285-290`

```ts
export function isPipelineTransitionForward(currentStage, newStage): boolean {
  const currentOrder = getPipelineStageOrder(currentStage);
  const newOrder = getPipelineStageOrder(newStage);
  if (currentOrder === -1 || newOrder === -1) return true;  // unknown: allow
  return newOrder >= currentOrder;
}
```

Throws `E_VALIDATION` on backward transitions.

### Lifecycle stage status (different concept) — `status-registry.ts:35-42`

```
LIFECYCLE_STAGE_STATUSES = ['not_started','in_progress','blocked','completed','skipped','failed']
```

This is the *status of a stage instance* (i.e., the `lifecycle_stages.status` column), not the stage name itself. Stage name + stage status together describe where a task is in its pipeline.

---

## 5. `archived` — Status, Table, or Column Flag?

**Answer: All three surfaces in one.** It is a single status value PLUS three companion columns on the same `tasks` row.

### Evidence

**Status enum**: `status-registry.ts:21` includes `'archived'` in `TASK_STATUSES`.

**Terminal set**: `status-registry.ts:69-73` includes `'archived'` in `TERMINAL_TASK_STATUSES`.

**Archive metadata columns on `tasks` table** — `tasks-schema.ts:181-184`:

```ts
// Archive metadata (populated when status = 'archived')
archivedAt: text('archived_at'),
archiveReason: text('archive_reason'),
cycleTimeDays: integer('cycle_time_days'),
```

**Index supporting archive queries**: `tasks-schema.ts:217` → `index('idx_tasks_status_archive_reason')`.

**No separate archive table** — grep for `CREATE TABLE.*archive` in migrations returns no hits. Archiving is in-place on `tasks`.

### Transition sequence — `packages/core/src/tasks/archive.ts:111-114`

```ts
await acc.archiveSingleTask(t.id, {
  archivedAt: now,
  archiveReason: t.status === 'cancelled' ? 'cancelled' : 'completed',
});
```

Only tasks with `status IN ('done', 'cancelled')` are eligible (line 51, 72-75). Archiving flips the status to `'archived'`, stamps `archivedAt`, and records the reason ('completed' | 'cancelled').

### Why the validateStatusTransition map allows it

`packages/core/src/validation/engine.ts:404-411`:

```
done      → [pending, archived]
cancelled → [pending]    ← cannot go directly to archived via this map
```

But `archive.ts` uses a direct `archiveSingleTask` accessor call that bypasses `validateStatusTransition`, which is why cancelled tasks CAN still be archived. This is an intentional archive-path write, not a generic status update.

---

## Full Reference Table — Every Status/Stage/Archived Value

| Value | Axis | Where valid | Semantic meaning | Terminal? | Transitions from |
|-------|------|-------------|------------------|-----------|------------------|
| `pending` | `status` | `tasks.status` | Created, not yet started | No | `[active, blocked, cancelled]` |
| `active` | `status` | `tasks.status` | Currently in progress | No | `[done, blocked, pending, cancelled]` |
| `blocked` | `status` | `tasks.status` | Cannot advance; blocked by `blocked_by` reason | No | `[pending, active, cancelled]` |
| `done` | `status` | `tasks.status` | Completed successfully; requires `completedAt` | Effectively | `[pending, archived]` |
| `cancelled` | `status` | `tasks.status` | Abandoned; requires `cancelledAt` + `cancellationReason` | Effectively | `[pending]` |
| `archived` | `status` | `tasks.status` | Stored, inactive; companion cols populated | Yes | `[]` (hard terminal) |
| `research` | `pipeline_stage` | RCASD-IVTR+C #1 | Exploring the problem space | No | Any stage with order >= 1 |
| `consensus` | `pipeline_stage` | RCASD-IVTR+C #2 | Multi-agent agreement | No | Any stage >= 2 |
| `architecture_decision` | `pipeline_stage` | RCASD-IVTR+C #3 | ADR captured | No | >= 3 |
| `specification` | `pipeline_stage` | RCASD-IVTR+C #4 | Spec written | No | >= 4 |
| `decomposition` | `pipeline_stage` | RCASD-IVTR+C #5 | Broken into atomic tasks | No | >= 5 |
| `implementation` | `pipeline_stage` | RCASD-IVTR+C #6 | Code written | No | >= 6 |
| `validation` | `pipeline_stage` | RCASD-IVTR+C #7 | Reviewed / validated | No | >= 7 |
| `testing` | `pipeline_stage` | RCASD-IVTR+C #8 | Tests green | No | >= 8 |
| `release` | `pipeline_stage` | RCASD-IVTR+C #9 | Shipped | No | >= 9 |
| `contribution` | `pipeline_stage` | RCASD-IVTR+C #10 | Done + lessons captured | Yes | None |
| `cancelled` | `pipeline_stage` | RCASD-IVTR+C #11 | Terminal marker for cancelled tasks | Yes | None |
| `archived_at` | column | `tasks.archived_at` | ISO timestamp; set when `status='archived'` | n/a | — |
| `archive_reason` | column | `tasks.archive_reason` | `'completed'` | `'cancelled'` | n/a | — |
| `cycle_time_days` | column | `tasks.cycle_time_days` | Days from creation to archive | n/a | — |
| `deferred` | **UI-only synonym** | `?deferred=1` URL param + `.epic-deferred` CSS class | Display label for cancelled epics in Studio Epic Progress panel | **NOT A STATUS** | — |
| `deferred-to` | relation type | `task_relations.relation_type` via `crossref-extract.ts:13` | Cross-reference: "this task was deferred to task X" | n/a | — |

---

## Files Cited (absolute paths)

- `/mnt/projects/cleocode/packages/contracts/src/status-registry.ts`
- `/mnt/projects/cleocode/packages/contracts/src/task.ts`
- `/mnt/projects/cleocode/packages/contracts/src/task-record.ts`
- `/mnt/projects/cleocode/packages/core/src/store/tasks-schema.ts`
- `/mnt/projects/cleocode/packages/core/src/tasks/pipeline-stage.ts`
- `/mnt/projects/cleocode/packages/core/src/tasks/archive.ts`
- `/mnt/projects/cleocode/packages/core/src/tasks/crossref-extract.ts`
- `/mnt/projects/cleocode/packages/core/src/validation/engine.ts`
- `/mnt/projects/cleocode/packages/core/src/lifecycle/state-machine.ts`
- `/mnt/projects/cleocode/packages/cleo/migrations/drizzle-tasks/20260417000000_t877-pipeline-stage-invariants/migration.sql`
- `/mnt/projects/cleocode/packages/studio/src/routes/tasks/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/tasks/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/tasks/__tests__/dashboard-filters.test.ts`
