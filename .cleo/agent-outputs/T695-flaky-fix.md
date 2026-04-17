# T695-1 Flaky Test Fix — Ratio-Based Complexity Proof

**Task**: T695-1  
**Date**: 2026-04-16  
**Status**: complete  

## Problem

`T695-1: session-bucket O(n²) guard — consolidation completes within 10 seconds`

Used an absolute 10 s threshold. The test passes in isolation (~3 s) but fails under parallel vitest worker load (>17 s on a 4-core machine with 4 parallel test files). The threshold is machine- and load-dependent and does not actually prove complexity class.

## Fix Strategy

Owner directive: "If the algorithm is O(n log n), make the test assert the algorithmic complexity instead of absolute time."

Replace the absolute time check with a **ratio-based complexity proof**:
- Run with N=50 spikes (5 sessions × 10 rows) — measure `timeSmallMs`
- Run with N=200 spikes (20 sessions × 10 rows) — measure `timeLargeMs`
- Assert `timeLargeMs / timeSmallMs < 8`

This works because:
- Linear O(n): 4× input → ~4× time → ratio ~4
- Log-linear O(n log n): 4× input → ~5× time → ratio ~5
- Quadratic O(n²): 4× input → ~16× time → ratio ~16

A ratio < 8 proves the implementation is sub-quadratic on this dataset, regardless of machine speed or parallel load.

A sanity absolute ceiling of 60 s per run catches truly broken implementations (infinite loop, deadlock, etc.).

## Diff Summary

**File**: `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts`

**Changed**: Lines 338–390 (T695-1 test body)

Removed:
- Single `applyStdpPlasticity` call with 200 spikes
- Absolute `expect(durationMs).toBeLessThan(10_000)` assertion

Added:
- `measureRun(dir, numSessions, rowsPerSession)` async helper inside the test
- Small run: 5 sessions × 10 rows = 50 spikes in `tempDir` (managed by beforeEach/afterEach)
- Large run: 20 sessions × 10 rows = 200 spikes in a second `mkdtemp` dir (created and cleaned inline with try/finally)
- `expect(timeSmallMs).toBeLessThan(60_000)` — sanity ceiling
- `expect(timeLargeMs).toBeLessThan(60_000)` — sanity ceiling
- `expect(timeLargeMs / Math.max(timeSmallMs, 1)).toBeLessThan(8)` — complexity proof

## Verification — 3-Run Isolation Test

Each run targets only `src/memory/__tests__/brain-stdp-wave3.test.ts`:

```
=== Run 1 ===  Tests  13 passed (13)
=== Run 2 ===  Tests  13 passed (13)
=== Run 3 ===  Tests  13 passed (13)
```

Zero failures across 3 consecutive runs. All 13 tests in the file pass.

## Sibling Test Impact

Full `@cleocode/core` test suite: 4294 passed, 32 todo. The 1 failure observed in some runs is the pre-existing `t311-integration.test.ts` Scenario 13 flake — unrelated to STDP and present before this change.

## Why This Is Not a Bandaid

The original test was a bandaid: it used an arbitrary time budget that masked the actual algorithmic question. This fix answers the actual question ("is the implementation sub-quadratic?") with a machine-independent assertion that holds under any parallel worker load.
