# T996 — Dream Cycle Migrated to Tick Loop

**Status**: complete
**Commit**: `0de82f872878eedf8b33a5496d5fdaf7976723c6`
**Session**: ses_20260420023541_d7ed28

## What was done

- Deleted `startDreamScheduler` (lines 398-427) and `stopDreamScheduler` (lines 436-441) from `packages/core/src/memory/dream-cycle.ts`
- Removed `nightlyTimer` module-level variable from `dream-cycle.ts`
- Removed `startDreamScheduler` and `stopDreamScheduler` from `packages/core/src/internal.ts` exports
- Updated `_resetDreamState` to no longer call `stopDreamScheduler`
- Updated module-level JSDoc comment to document Tier 3 removal
- Added `DREAM_VOLUME_THRESHOLD_DEFAULT = 50` and `DREAM_IDLE_TICKS_DEFAULT = 5` constants to `tick.ts`
- Added `consecutiveIdleTicks` in-process counter to `tick.ts`
- Added `maybeTriggerDream` helper (swallows errors, tracks idle state)
- Wired `maybeTriggerDream` into `safeRunTick` (post-tick, after outcome determined)
- Extended `TickOptions` with `dreamVolumeThreshold`, `dreamIdleTicks`, and injectable `checkAndDream` for test isolation
- Exported `_resetDreamTickState` and `_getConsecutiveIdleTicks` for test teardown

## Files changed

- `packages/cleo/src/sentient/tick.ts` — volume+idle triggers wired into `safeRunTick`
- `packages/core/src/memory/dream-cycle.ts` — `startDreamScheduler` setTimeout pattern deleted
- `packages/core/src/internal.ts` — removed deleted function exports
- `packages/cleo/src/sentient/__tests__/dream-tick.test.ts` — 8 new tests (DT-1 through DT-8)

## Test results

42 tests passing (0 failing) across dream-tick.test.ts + dream-cycle.test.ts + daemon.test.ts.
