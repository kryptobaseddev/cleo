# T060: Bind Tasks to Pipeline Stages

**Date**: 2026-03-21
**Status**: complete
**Epic**: T056 (Task System Hardening)

## Summary

Implemented automatic RCASD-IVTR+C pipeline stage binding for tasks. Every task now receives a `pipelineStage` field on creation, and stage transitions are enforced to be forward-only.

## Changes

### New Files

- `packages/core/src/tasks/pipeline-stage.ts` — canonical pipeline stage logic (constants, validation, auto-assignment, transition enforcement)
- `packages/core/src/tasks/__tests__/pipeline-stage.test.ts` — 33 tests covering all acceptance criteria
- `packages/core/migrations/drizzle-tasks/20260321000002_t060-pipeline-stage-binding/migration.sql` — removes FK constraint from `tasks.pipeline_stage` column so stage names can be stored directly

### Modified Files

- `packages/contracts/src/task.ts` — added `pipelineStage?: string | null` to `Task` interface
- `packages/core/src/store/converters.ts` — `rowToTask` reads `pipelineStage` from row; `taskToRow` writes it
- `packages/core/src/store/db-helpers.ts` — `upsertTask` now includes `pipelineStage` in the `onConflictDoUpdate` set
- `packages/core/src/store/tasks-schema.ts` — removed FK reference from `pipelineStage` column (stores stage name, not lifecycle_stages.id)
- `packages/core/src/tasks/add.ts` — imports pipeline-stage module; validates explicit stage; resolves and assigns `pipelineStage` on every task creation
- `packages/core/src/tasks/update.ts` — imports `validatePipelineTransition`; enforces forward-only transitions when `pipelineStage` is updated
- `packages/cleo/src/cli/commands/update.ts` — added `--pipeline-stage <stage>` CLI flag
- `packages/cleo/src/dispatch/engines/task-engine.ts` — `taskToRecord` and `TaskRecord` now include `pipelineStage`

### Production DB

Applied migration to `/mnt/projects/cleocode/.cleo/tasks.db`:
- Rebuilt `tasks` table without FK constraint on `pipeline_stage`
- Existing tasks have `pipeline_stage = NULL` (will be populated on next update or explicit backfill)

## Implementation Details

### Auto-Assignment Rules (priority order)

1. Explicit `--pipeline-stage` value (if valid)
2. Inherit parent task's `pipelineStage`
3. `type='epic'` → `research`
4. Default → `implementation`

### Transition Validation

Forward-only: each stage has a numeric order (research=1 … contribution=10). A transition is rejected if `newOrder < currentOrder`. Same-stage is always allowed (no-op). Null current stage allows any valid target.

### Stage List

```
research, consensus, architecture_decision, specification,
decomposition, implementation, validation, testing, release, contribution
```

## Test Results

```
33 tests passed, 0 failed
```

Covers:
- Unit: `isValidPipelineStage`, `validatePipelineStage`, `getPipelineStageOrder`, `isPipelineTransitionForward`, `validatePipelineTransition`, `resolveDefaultPipelineStage`
- Integration (SQLite): auto-assignment on addTask (standalone, epic, child-of-parent), explicit stage, invalid stage rejection, persistence round-trip; forward/same/backward transitions on updateTask, invalid stage on update, persistence after update

## Acceptance Criteria

- [x] `pipeline_stage` column exists and is queryable
- [x] Auto-assignment works on task creation
- [x] Forward-only stage transitions enforced
- [x] Integration tests pass with T033 schema
- [x] Stage visible in `cleo show` output
- [x] CLI `--pipeline-stage` flag wired to update command
