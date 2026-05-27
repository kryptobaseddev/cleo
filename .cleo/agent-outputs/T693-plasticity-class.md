# T693: STDP-A6 plasticity_class Column Writer

## Completed

This worker completed the STDP-A6 plasticity_class writer, implementing edge metadata updates for timing-dependent plasticity.

## Summary

Implemented the plasticity_class column writer for brain_page_edges per STDP spec §3.10:

- **File**: `packages/core/src/memory/brain-plasticity-class.ts` (new)
- **Test file**: `packages/core/src/memory/__tests__/plasticity-class.test.ts` (new)
- **Modified files**:
  - `packages/core/src/memory/brain-stdp.ts` — STDP LTP/LTD path updates
  - `packages/core/src/memory/brain-lifecycle.ts` — Hebbian co-retrieval updates

## Implementation Details

### Helper Functions

1. **`upgradePlasticityClass(currentClass, event)`**
   - Decision logic per spec synthesis decision #12: "STDP always upgrades to 'stdp' on UPDATE"
   - Handles transitions: static → hebbian, static → stdp, hebbian → stdp, stdp stays stdp
   - Null/undefined treated as 'static'

2. **`computeStabilityScore(reinforcementCount, lastReinforcedAt, now)`**
   - Formula: `stability = tanh(rc/10) × exp(-(days/30))`
   - Null returns if edge has no reinforcement history
   - Result clamped to [0, 1]
   - Used for decay pass filtering and plasticity event ordering

### Changes to STDP Writer (`brain-stdp.ts`)

**LTP Path (A→B edge)**:
- INSERT: sets `plasticity_class='stdp'`, `reinforcement_count=1`, computes stability
- UPDATE: increments `reinforcement_count`, sets `last_reinforced_at=now`, upgrades class to 'stdp', recomputes stability

**LTD Path (B→A reverse edge)**:
- UPDATE only (no INSERT): increments `depression_count`, sets `last_depressed_at=now`, upgrades class to 'stdp', recomputes stability based on LTP count (not depression count per spec)

### Changes to Hebbian Writer (`brain-lifecycle.ts`)

**strengthenCoRetrievedEdges**:
- INSERT: sets `plasticity_class='hebbian'`
- UPDATE: sets `plasticity_class='hebbian'` (maintains classification even if edge was previously 'static')

## Acceptance Criteria Met

✓ LTP INSERT sets plasticity_class='stdp' on new edges  
✓ LTP UPDATE sets plasticity_class='stdp' on existing edges (upgrades 'hebbian' to 'stdp')  
✓ strengthenCoRetrievedEdges (Hebbian Step 6) sets plasticity_class='hebbian' on INSERT and UPDATE  
✓ Static structural edges never touched (default='static' via schema)  
✓ Homeostatic decay will use `WHERE plasticity_class IN ('hebbian','stdp')` guard (spec §3.9)  
✓ pnpm biome check passes  
✓ pnpm run build passes (BUILD COMPLETE)  
✓ pnpm run test passes (3922 passed in core package)  

## Test Coverage

12 unit tests in `plasticity-class.test.ts`:
- Upgrade logic: 6 tests
  - static → hebbian on hebbian event
  - static → stdp on stdp event
  - hebbian → stdp on stdp event
  - stdp stability (no downgrade)
  - hebbian stability on hebbian event
  - null/undefined handling as static

- Stability score: 6 tests
  - Returns null for zero/negative reinforcement_count
  - Returns null if lastReinforcedAt is null
  - Computes tanh(rc/10) × 1.0 correctly (rc=10, rc=5, rc=1)
  - Decays with time: exp(-(days/30)) ratio validation
  - Clamps result to [0, 1]
  - Uses Date.now() by default

## Compliance

**Code Quality Rules** (mandatory per AGENTS.md):
- ✓ No `any` type used
- ✓ No `unknown` type shortcuts
- ✓ TSDoc comments on all exported functions
- ✓ Types from contracts or properly defined
- ✓ Biome format check passes
- ✓ Build passes with zero type errors
- ✓ All tests pass

**STDP Specification Compliance** (T673 spec):
- ✓ Decision #12: STDP upgrades to 'stdp' on UPDATE
- ✓ Decision #13: stability_score formula matches spec exactly
- ✓ §3.10 plasticity_class assignment rules implemented
- ✓ Two-window architecture uses new parameters (separate lookup/pairing windows) — prepared for T679 integration

## Commit

```
cccce008 feat(brain): STDP-A6 plasticity_class writer + stability_score (T693)
```

Changes:
- 112 lines: `plasticity-class.test.ts` (new)
- 94 lines: `brain-plasticity-class.ts` (new, helpers)
- 46 lines: `brain-lifecycle.ts` (Hebbian path)
- 375 lines: `brain-stdp.ts` (LTP/LTD paths + upgraded queries)

**Total**: 4 files, 606 insertions (+), 21 deletions (-)

## Notes

The plasticity_class column is now fully wired for both Hebbian and STDP update paths. The stability_score computation enables fast filtering in the decay pass (skip edges with stability > 0.9). This completes the "A6 plasticity_class writer" subtask of T673.

The implementation is ready for integration with:
- T679 (complete STDP algorithm)
- T706 (edge reinforcement/depression tracking & history)
- T677 (homeostatic decay with plasticity_class guards)
