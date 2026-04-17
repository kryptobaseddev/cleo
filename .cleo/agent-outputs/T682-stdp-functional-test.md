# T682 — STDP Phase 5 Functional Test

**Status**: complete
**Date**: 2026-04-17
**Task**: T682 — STDP-W5: Functional test, end-to-end CLI test verifying plasticity events fire in real brain.db

## Deliverable

Created: `/mnt/projects/cleocode/packages/core/src/memory/__tests__/brain-stdp-functional.test.ts`

## Test Results

```
Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  2.67s
```

All 3 tests pass with zero mocked DB components.

## Tests Implemented

### T682-1: cleo memory dream writes brain_plasticity_events with kind=ltp to real brain.db
- Creates a fresh tmpdir brain.db via `getBrainDb`
- Inserts 2 retrieval rows 60s apart (same session, within pairingWindowMs=5min)
- Closes the in-process connection to avoid WAL conflicts
- Spawns `cleo memory dream --json` via `execFile` with `CLEO_DIR` set to the tmpdir
- Asserts `stdpPlasticity.ltpEvents >= 1` in the CLI JSON output
- Re-opens the DB and asserts `brain_plasticity_events COUNT > 0` and `kind='ltp'`
- Asserts `brain_page_edges` has at least one `co_retrieved` edge

### T682-2: cleo brain plasticity stats --json reports totalEvents > 0
- Same setup as T682-1
- After dream cycle completes, spawns `cleo brain plasticity stats --json`
- Asserts `totalEvents > 0` and `ltpCount >= 1` in the parsed stats JSON

### T682-3: LTP plasticity events have non-zero weight delta (delta_w > 0)
- Inserts 3 retrieval rows (A, B, A+C pattern) to generate multiple spike pairs
- After dream cycle, queries `brain_plasticity_events` directly
- Asserts every LTP event has `delta_w > 0`

## Acceptance Criteria Verification

| AC | Status |
|----|--------|
| test file at `packages/core/src/memory/__tests__/brain-stdp-functional.test.ts` | PASS |
| test uses real brain.db in tmpdir (mkdtemp) -- no vi.mock on brain-sqlite.js | PASS |
| test inserts real retrieval log rows as JSON arrays within past 5 minutes | PASS |
| test invokes cleo binary via execFileNoThrow (execFile + promisify) | PASS |
| after cleo brain maintenance (dream cycle): brain_plasticity_events COUNT > 0 | PASS |
| at least one plasticity event has kind=ltp | PASS |
| brain_page_edges has at least one co_retrieved edge | PASS |
| cleo brain plasticity stats output shows totalEvents > 0 | PASS |
| pnpm run test passes including this new test file with zero mocked DB components | PASS |
| test cleans up tmpdir in afterEach | PASS |

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome ci` (file-level) | PASS — no errors |
| `pnpm --filter @cleocode/core run build` | PASS |
| Test run: 3/3 passing | PASS |

## Key Implementation Notes

- Used `vi.setConfig({ testTimeout: 60_000 })` (not the non-existent `setConfig`)
- `CLEO_DIR` set as absolute path to `tmpdir/.cleo` — cleo binary derives project root as `dirname(CLEO_DIR)` per `paths.ts` lines 298-306
- In-process DB closed with `closeBrainDb()` before CLI spawn to avoid WAL-mode conflicts
- DB re-opened after CLI exits for direct assertion queries
- Pattern matches `brain-stdp-w2.test.ts` (same real-SQLite no-mock approach)
- The `cleo memory dream --json` command triggers `runConsolidation` Steps 9a+9b+9c which includes `applyStdpPlasticity`
