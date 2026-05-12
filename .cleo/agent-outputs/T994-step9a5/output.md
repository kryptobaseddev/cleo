# T994 — correlateOutcomes Step 9a.5 + trackMemoryUsage wiring

**Status**: complete
**Commit**: fb59ba1fa1852d4b7c9f00cdf96d497fe0b45b1f

## Changes

### packages/core/src/memory/brain-lifecycle.ts
- Added `outcomeCorrelation` field to `RunConsolidationResult` interface
- Added `nexusEdgesStrengthened` field (pre-existing T998 gap fix)
- Updated step docstring to list Step 9a.5
- Inserted Step 9a.5 between Step 9a and Step 9b: calls `correlateOutcomes`, wraps in try/catch identical to sibling steps

### packages/core/src/memory/quality-feedback.ts
- Extended `MemoryOutcome` type with `'verified'` to support gate-set lifecycle events

### packages/cleo/src/dispatch/domains/tasks.ts
- Added `setImmediate` fire-and-forget `trackMemoryUsage(projectRoot, taskId, true, taskId, 'success')` in the `complete` case

### packages/cleo/src/dispatch/domains/check.ts
- Added `setImmediate` fire-and-forget `trackMemoryUsage(projectRoot, taskId, true, taskId, 'verified')` in the `gate.set` case

### packages/core/src/memory/__tests__/brain-lifecycle-step9a5.test.ts
- New test file with 7 tests:
  - T994-1: runConsolidation populates outcomeCorrelation
  - T994-2: Steps 9a, 9a.5, 9b all present
  - T994-3: Step 9a.5 failure does not abort consolidation
  - T994-4: Idempotency (two consecutive runs both succeed)
  - T994-5: trackMemoryUsage inserts row with outcome=success
  - T994-6: trackMemoryUsage inserts row with outcome=verified
  - T994-7: correlateOutcomes handles verified rows without error

## Gates
- implemented: commit fb59ba1fa + 5 files verified
- testsPassed: 7/7 tests passed (test-run:/tmp/t994-vitest-out.json)
- qaPassed: tsc clean + biome ci clean on T994 files
