# T719 — Pipeline Backfill + Auto-Advance

**Status**: complete
**Date**: 2026-04-15
**Agent**: cleo-subagent Worker

## Root Cause

Three separate bugs caused the pipeline to appear stuck:

1. **Stats bug** (`systemStats` in `system-engine.ts`): `byPhase` was computed from `t.phase`
   (the legacy project-phase field, always NULL in this project) instead of `t.pipelineStage`
   (the RCASD-IVTR+C pipeline stage). Result: `{unassigned: 211}` always.

2. **Studio pipeline server** (`api/tasks/pipeline/+server.ts`): `PIPELINE_STAGES` array
   contained stale/incorrect stage names (`design`, `review`, `done`) that don't match RCASD.
   Tasks with valid RCASD stages like `consensus` or `architecture_decision` fell through to
   the `unassigned` bucket.

3. **No auto-advance on lifecycle events**: `cleo start TXXX` and `cleo complete TXXX` never
   touched `pipelineStage`. Stages only advanced via the manual `cleo lifecycle stage.gate.pass`
   command, which agents rarely invoked.

4. **98 tasks with NULL `pipeline_stage`**: Tasks created before T060 (auto-assignment feature)
   had no `pipeline_stage` set.

## Fixes Applied

### Fix 1: Stats reads pipelineStage

`packages/cleo/src/dispatch/engines/system-engine.ts` line 436:
```ts
// Before (bug):
const phase = t.phase || 'unassigned';

// After (fix):
const phase = t.pipelineStage || 'unassigned';
```

### Fix 2: Studio PIPELINE_STAGES matches RCASD

`packages/studio/src/routes/api/tasks/pipeline/+server.ts`:
```ts
// Before (stale list, missing RCASD stages):
['research', 'specification', 'decomposition', 'design', 'implementation', 'testing', 'validation', 'review', 'release', 'done']

// After (correct RCASD-IVTR+C):
['research', 'consensus', 'architecture_decision', 'specification', 'decomposition', 'implementation', 'validation', 'testing', 'release', 'contribution']
```

### Fix 3: Auto-advance on cleo start

`packages/core/src/task-work/index.ts` — `startTask()`:
- If `pipelineStage` is in RCASD planning stages (research/consensus/architecture_decision/
  specification/decomposition), auto-advance to `implementation` on `cleo start TXXX`.

### Fix 4: Auto-advance on cleo complete

`packages/core/src/tasks/complete.ts` — `completeTask()`:
- If `pipelineStage` is in IVTR execution stages (implementation/validation/testing),
  auto-advance to `release` on `cleo complete TXXX`.

### Fix 5: TaskFieldUpdates includes pipelineStage

`packages/contracts/src/data-accessor.ts` — `TaskFieldUpdates` interface:
- Added `pipelineStage?: string | null` so `acc.updateTaskFields()` can write pipeline stage.

`packages/core/src/store/sqlite-data-accessor.ts` — `updateTaskFields()`:
- Added `['pipelineStage', 'pipelineStage']` to field map.

### Fix 6: Backfill 98 NULL tasks (direct SQLite)

Applied policy via sqlite3 shell:
- `status='done'` → `pipeline_stage='release'`
- `status='active'` → `pipeline_stage='implementation'`
- `type='epic', status='pending'` → `pipeline_stage='research'`
- `type!='epic', status='pending'` → `pipeline_stage='implementation'`
- `status='cancelled'` → skipped (not actionable)

Backfill is idempotent (WHERE pipeline_stage IS NULL).

Also created `scripts/backfill-pipeline-stages.ts` for future reference.

## Verification

**Before fix** (from `cleo stats` on installed CLI):
```json
{"byPhase": {"unassigned": 211}}
```

**After fix** (from `node packages/cleo/dist/cli/index.js stats`):
```json
{"byPhase": {"research": 117, "implementation": 89, "release": 10}}
```

**DB distribution** (sqlite3 direct query):
```
research|120
implementation|89
release|10
Remaining NULL: 0
```

## Test Results

- `packages/contracts` — 6/6 pass
- `packages/core` — 3978/3978 pass (32 todo, 1 worker OOM pre-existing)
- `packages/cleo` — 1250/1250 pass (2 skipped)
- No new test failures introduced

## Files Changed

- `packages/contracts/src/data-accessor.ts` — added `pipelineStage` to `TaskFieldUpdates`
- `packages/core/src/store/sqlite-data-accessor.ts` — added pipelineStage to field map
- `packages/core/src/task-work/index.ts` — auto-advance on `startTask`
- `packages/core/src/tasks/complete.ts` — auto-advance on `completeTask`
- `packages/cleo/src/dispatch/engines/system-engine.ts` — stats reads pipelineStage
- `packages/studio/src/routes/api/tasks/pipeline/+server.ts` — correct RCASD stages
- `scripts/backfill-pipeline-stages.ts` — created (for reference/re-run)
- `.cleo/tasks.db` — 98 tasks backfilled (not committed; live DB file)
