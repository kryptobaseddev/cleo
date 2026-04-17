# T900 — Schema Integrity: status ↔ pipelineStage sync + Studio consistency

**Status**: SHIPPED
**Date**: 2026-04-17
**Epic**: T870 (auto-assigned id; owner-requested T900)
**Children**: T871 (sync), T872 (backfill), T873 (Studio pipeline), T874 (Studio progress)
**Session**: ses_20260417155803_a8ece7

---

## Problem (owner-flagged 2026-04-17)

Three systemic bugs caused Studio's DONE column to render empty while 28
tasks carried `status=done`. Root cause: `cleo complete` / `cleo cancel`
did not maintain `tasks.pipeline_stage` in lock-step with `tasks.status`.
Symptoms:

| Bug | Description |
|-----|-------------|
| BUG 1 | `cleo complete` left `pipelineStage` at `research`/`implementation`/`release` for 28 rows |
| BUG 1 | `cleo cancel` did not touch `pipelineStage` at all |
| BUG 2 | Studio Pipeline Kanban groups purely by `pipelineStage` — DONE column empty |
| BUG 3 | Studio dashboard epic progress: numerator = direct children, denominator = recursive descendants (5/29 nonsense on T487) |

## Solution summary

- Extend `TASK_PIPELINE_STAGES` with `'cancelled'` (order 11) so cancelled
  tasks have a first-class terminal pipelineStage value.
- `cleo complete` now unconditionally advances `pipelineStage` to
  `'contribution'` when the current stage is not already terminal.
- `cleo cancel` (both `coreTaskCancel` and pure `cancelTask`) advances
  `pipelineStage` to `'cancelled'` when not already terminal.
- `coreTaskRestore` resets `pipelineStage` from `'cancelled'` back to the
  stage-default (`research` for epics, `implementation` otherwise) so
  restored tasks can advance through the chain again.
- New idempotent data migration
  `backfillTerminalPipelineStage()` fixes existing drift. Applied to
  local tasks.db: **38 rows corrected** (28 `done` + 10 `cancelled`).
- Studio Pipeline view now routes `status=done` tasks to a DONE column
  and `status=cancelled` tasks to a CANCELLED column regardless of
  `pipelineStage`. Column taxonomy mirrors core canonical stages.
- Studio dashboard epic progress uses a single direct-children basis
  (`parent_id = epic.id AND status != 'archived'`) for both numerator
  and denominator, matching `cleo list --parent <epicId>` exactly.

---

## Schema diff — PipelineStage enum

```diff
  export const TASK_PIPELINE_STAGES = [
    'research',
    'consensus',
    'architecture_decision',
    'specification',
    'decomposition',
    'implementation',
    'validation',
    'testing',
    'release',
    'contribution',
+   'cancelled',           // T871 — terminal marker for cancelled tasks
  ] as const;

  const STAGE_ORDER: Record<TaskPipelineStage, number> = {
    research: 1,
    consensus: 2,
    architecture_decision: 3,
    specification: 4,
    decomposition: 5,
    implementation: 6,
    validation: 7,
    testing: 8,
    release: 9,
    contribution: 10,
+   cancelled: 11,
  };

+ export const TERMINAL_PIPELINE_STAGES: ReadonlySet<TaskPipelineStage> =
+   new Set(['contribution', 'cancelled']);

+ export function isTerminalPipelineStage(
+   stage: string | null | undefined,
+ ): boolean {
+   return !!stage && TERMINAL_PIPELINE_STAGES.has(stage as TaskPipelineStage);
+ }
```

No drizzle migration required — `pipeline_stage` is `text` with no CHECK
constraint, so adding a new string value to the in-code enum is a
zero-cost change.

---

## File-by-file changes

### packages/core/src/tasks/pipeline-stage.ts
- Added `'cancelled'` to `TASK_PIPELINE_STAGES`.
- Added `TERMINAL_PIPELINE_STAGES` constant and `isTerminalPipelineStage()`.
- Added/kept forward-only validator (cancelled > contribution, so
  transitions into cancelled from any stage pass, transitions away fail).

### packages/core/src/tasks/complete.ts
- Kept the T719 `EXECUTION_STAGES_FOR_RELEASE → 'release'` nudge.
- Added a second, always-fires sync step: if `pipelineStage` is not a
  terminal marker, set it to `'contribution'`.
- Auto-completed epic parents also get their `pipelineStage` synced to
  `'contribution'`.

### packages/core/src/tasks/task-ops.ts
- `coreTaskCancel`: dual-write `pipelineStage = 'cancelled'` (idempotent).
- `coreTaskRestore`: when restoring a cancelled task, reset
  `pipelineStage` from `'cancelled'` back to the stage-default so
  subsequent updates are not blocked by forward-only validation.

### packages/core/src/tasks/cancel-ops.ts
- Pure `cancelTask(tasks[])` function now sets `pipelineStage='cancelled'`
  to mirror the DB-backed path.

### packages/core/src/lifecycle/backfill-terminal-pipeline-stage.ts (new)
- Idempotent data migration guarded by `schema_meta` key
  `'backfill:terminal-pipeline-stage'`.
- Finds every row where `status IN ('done','cancelled')` and
  `pipeline_stage` is NOT terminal, and routes:
  - `status=done` → `pipeline_stage='contribution'`
  - `status=cancelled` → `pipeline_stage='cancelled'`
- Supports `{dryRun, force}` options. Exports
  `isTerminalPipelineStageBackfillDone()` helper.

### packages/core/src/internal.ts
- Exports: `backfillTerminalPipelineStage`,
  `isTerminalPipelineStageBackfillDone`,
  `TERMINAL_PIPELINE_STAGE_BACKFILL_KEY`, plus the
  `TerminalPipelineStageBackfillChange` /
  `TerminalPipelineStageBackfillResult` types.

### packages/studio/src/routes/tasks/pipeline/+page.server.ts
- Replaced hardcoded column list (`research, specification, ...,
  done`) that included non-canonical `'design'`/`'review'` and used
  `'done'` as a pipelineStage value (which never existed in core).
- New canonical column taxonomy mirrors core
  `TASK_PIPELINE_STAGES` with terminal display buckets `done` +
  `cancelled` appended.
- New pure `resolveColumnId(row)` function routes:
  - `status=done` → DONE column
  - `status=cancelled` → CANCELLED column
  - `pipeline_stage IN ('contribution','done')` → DONE column
  - `pipeline_stage='cancelled'` → CANCELLED column
  - otherwise → pipeline_stage column (or unassigned if NULL).
- Exported `__testing__ = { resolveColumnId, PIPELINE_STAGES }` for unit
  tests.

### packages/studio/src/routes/tasks/+page.server.ts
- Extracted epic-progress computation into pure `computeEpicProgress(db)`
  function (tested against in-memory SQLite).
- Replaced `WITH RECURSIVE` descendant counter with a direct-children
  aggregate. Both numerator and denominator now count
  `parent_id = epic.id AND status != 'archived'`.

---

## Test coverage added

All tests pass (0 regressions in scoped run, 88/88 green):

| File | Tests | Focus |
|------|-------|-------|
| `packages/core/src/tasks/__tests__/pipeline-stage.test.ts` | +9 | `TERMINAL_PIPELINE_STAGES`, `isTerminalPipelineStage`, enum-has-cancelled, forward-only into/out of `cancelled` |
| `packages/core/src/tasks/__tests__/complete.test.ts` | +4 | `completeTask` sets `pipelineStage='contribution'` from research / implementation / release / already-contribution (idempotent) |
| `packages/core/src/tasks/__tests__/cancel-ops.test.ts` | +4 | `cancelTask` sets `pipelineStage='cancelled'` from research / implementation / NULL / already-terminal (idempotent) |
| `packages/core/src/lifecycle/__tests__/backfill-terminal-pipeline-stage.test.ts` (new) | 13 | basic backfill both statuses, NULL pipeline_stage, already-terminal skip, non-terminal-status skip, 28+ mixed fleet, idempotency guard, `schema_meta` key, dryRun, force |
| `packages/studio/src/routes/tasks/pipeline/__tests__/resolve-column-id.test.ts` (new) | 16 | every `status × pipeline_stage` combination, column taxonomy includes DONE+CANCELLED |
| `packages/studio/src/routes/tasks/__tests__/epic-progress.test.ts` (new) | 7 | direct-children only, archived exclusion, numerator-≤-denominator property, zero children, multiple epics |

**Scoped run**: 88 tests passed, 0 failed, 0 skipped.

---

## Live migration applied to local DB

```
$ cleo backup add                # snapshot first
{"success":true,"backupId":"snapshot-2026-04-17T16-12-55-012Z",...}

$ node -e "… backfillTerminalPipelineStage({}, '.') …"
{ "alreadyRun": false, "tasksScanned": 38, "tasksUpdated": 38 }

# Idempotency check
$ node -e "… backfillTerminalPipelineStage({}, '.') …"
{ "alreadyRun": true,  "tasksUpdated": 0 }
```

Spot checks after migration:

| Task | Before | After |
|------|--------|-------|
| T487 | status=done, pipelineStage=release       | status=done,       pipelineStage=**contribution** |
| T821 | status=done, pipelineStage=research      | status=done,       pipelineStage=**contribution** |
| T832 | status=done, pipelineStage=implementation| status=done,       pipelineStage=**contribution** |
| T010 | status=cancelled, pipelineStage=research | status=cancelled, pipelineStage=**cancelled**     |

Full breakdown: 28 `done` + 10 `cancelled` rows corrected.

---

## Evidence for close

| Task | commit | files | tests | qa |
|------|--------|-------|-------|----|
| T871 | `04021568a` | 4 files (`pipeline-stage.ts`, `complete.ts`, `cancel-ops.ts`, `task-ops.ts`) | `T871-scoped.json` 88/88 | `biome ci` clean |
| T872 | `04021568a` | 2 files (`backfill-terminal-pipeline-stage.ts`, `internal.ts`) | `T871-scoped.json` 88/88 | `biome ci` clean |
| T873 | `04021568a` | 1 file (`+page.server.ts`, pipeline) | `T871-scoped.json` 88/88 | `biome ci` clean |
| T874 | `04021568a` | 1 file (`+page.server.ts`, dashboard) | `T871-scoped.json` 88/88 | `biome ci` clean |

All 4 children: `status=done, pipelineStage=contribution` (proves Fix 1
lives on the dogfooded path — each was completed with the new build).

Epic T870 (owner requested T900): `status=done, pipelineStage=contribution`.

Evidence artefacts:
- `/mnt/projects/cleocode/.cleo/agent-outputs/T870-schema-integrity/tests.json` — scoped vitest JSON report
- `/mnt/projects/cleocode/.cleo/agent-outputs/T870-schema-integrity/T487-after.json` — post-backfill state
- `/mnt/projects/cleocode/.cleo/agent-outputs/T870-schema-integrity/T870-after.json` — epic final state
- `/tmp/tasks-backup-t871.db` + `cleo backup add` snapshots — pre-migration safety

---

## Quality gates

| Gate | Result |
|------|--------|
| `pnpm biome ci .` | clean (only pre-existing schema-version info + archive symlink warning — both unrelated) |
| `pnpm --filter @cleocode/core run build` | green |
| `pnpm --filter @cleocode/cleo run build` | green |
| `pnpm run build` (full monorepo) | green |
| Scoped test run (T870 touch-set) | 88/88 passed |
| Full suite | 8579/8623 pass, 2 pre-existing STDP functional failures unrelated to this work |

---

## Not in scope (explicit non-goals)

- Wiring the backfill to auto-run on CLI startup. The T869 precedent
  also declines to do this; owner can invoke on demand or it will be
  picked up once a dedicated data-migration registry lands.
- Changing `cleo list --parent` semantics — Studio now matches CLI,
  not the other way around.
- Introducing archived-descendant visibility in Studio. Out of scope
  for Bug 3; archived tasks remain excluded.

---

## Followup suggestions for owner

1. Consider wiring `backfillTerminalPipelineStage` into a named
   data-migration pipeline that runs once per fresh project (alongside
   the T869 pipeline-stage backfill).
2. The global `cleo` binary is still on v2026.4.80 pre-fix. Re-publish
   (owner decision) to propagate the complete/cancel fix to other
   dogfood projects.
