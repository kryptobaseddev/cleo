# T869 — pipeline_stage Backfill from lifecycle_stages

**Task**: T869
**Date**: 2026-04-16
**Status**: complete
**Session**: ses_20260416230443_5f23a3

## Problem

T832 added dual-write in `recordStageProgress`: lifecycle advancement now
updates BOTH `lifecycle_stages` table AND `tasks.pipeline_stage` field.
Epics advanced BEFORE T832 shipped have `lifecycle_stages.stage_name` at
(e.g.) 'release' while `task.pipelineStage` is stuck at 'research'.

This caused:
- `E_VALIDATION` rejection on `cleo update --pipelineStage` forward-only check
- `E_LIFECYCLE_GATE_FAILED` on child completes (gate reads `task.pipelineStage`)
- Catch-22 deadlock: epic cannot advance, children cannot complete

## Solution

One-shot idempotent backfill in
`packages/core/src/lifecycle/backfill-pipeline-stage.ts`.

### Logic

For each task that has `lifecycle_pipelines` + `lifecycle_stages` rows:

1. Find highest-sequence stage row with status IN ('completed', 'in_progress', 'skipped')
2. If that stage's order > task.pipeline_stage order: update `tasks.pipeline_stage`
3. Write an idempotency guard to `schema_meta` key `'backfill:pipeline-stage-from-lifecycle'`
4. Second call returns `alreadyRun: true` immediately (no writes)

### Files Created

- `packages/core/src/lifecycle/backfill-pipeline-stage.ts` — migration function
- `packages/core/src/lifecycle/__tests__/backfill-pipeline-stage.test.ts` — 8 tests

### Exports Added to `internal.ts`

```
backfillPipelineStageFromLifecycle(options?, cwd?) -> PipelineStageBackfillResult
isPipelineStageBackfillDone(cwd?) -> boolean
PIPELINE_STAGE_BACKFILL_KEY (string constant)
```

## Quality Gates

- `pnpm biome ci` — PASS (0 errors on new files)
- `pnpm --filter @cleocode/core run build` — PASS
- `pnpm --filter @cleocode/core run test` — 8/8 new tests pass, 274/275 files pass
  (1 pre-existing failure in session-grade integration test, unrelated to this work)

## Live Backfill Applied

Dry-run revealed 3 diverged tasks:

| Task | Previous | New |
|------|----------|-----|
| T612 | research | release |
| T673 | research | decomposition |
| T861 | research | release |

Live run applied. T861 confirmed: `pipelineStage = release`.

## Test Coverage (8 tests)

| Test | Scenario |
|------|----------|
| (a) | Backfills task.pipeline_stage from highest completed lifecycle stage |
| (b) | Idempotent: second call returns alreadyRun=true |
| (c) | Does not touch tasks already in sync |
| (d) | dryRun computes changes without writing |
| (e) | force flag bypasses idempotency guard |
| (f) | Multiple tasks: updates only those that diverge |
| (g) | `isPipelineStageBackfillDone` returns false before and true after |
| (h) | Guard metadata includes task reference in schema_meta |
