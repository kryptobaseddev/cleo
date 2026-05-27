# T9159: orchestrate waves planner — taskIds[] fix

## Summary

Fixed `orchestrateWaves` returning wave entries with no `taskIds` field.
Orchestrators reading `wave.taskIds` got `undefined` (empty) because the
field was named `tasks` (an array of enriched task objects), not `taskIds`.

## Root Cause

`EnrichedWave` in `packages/core/src/orchestration/waves.ts` had:
- `tasks: EnrichedWaveTask[]` — enriched objects with id/title/status/priority

But had NO `taskIds: string[]` field. Orchestrators expecting
`wave.taskIds` (the older `DependencyWave` shape from `graph-ops.ts`)
got `undefined`, logged as "0 tasks []".

## Fix

### `packages/core/src/orchestration/waves.ts`
- Added `taskIds: string[]` (required) to `EnrichedWave` interface
- Populated in `getEnrichedWaves` as `enrichedTasks.map(t => t.id)`

### `packages/core/src/formatters/waves.ts`
- Added `taskIds?: string[]` (optional) to the formatter's `EnrichedWave` type

### `packages/core/src/orchestrate/__tests__/orchestrate-waves.test.ts` (NEW)
- 4 regression tests verifying:
  - Non-empty `taskIds` per wave for epic with pending children
  - `taskIds` mirrors `tasks.map(t => t.id)` exactly
  - Sum of all wave `taskIds` equals pending task count
  - Empty epic (all done) yields empty wave list

## Commit

`8a0d84a8705ebb1bcc14e1aff31f9f28df46c2ea` on branch `task/T9159`

## Verification

- `pnpm --filter @cleocode/core run build` — passes (tsc, no errors)
- 4 new tests pass in `orchestrate-waves.test.ts`
- 4 existing tests pass in `orchestrate-ready-display.test.ts`
- `biome ci packages/core/src/` — 1179 files, 0 errors
