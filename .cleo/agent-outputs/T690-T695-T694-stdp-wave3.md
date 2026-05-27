# STDP Wave 3 — T690 / T695 / T694

**Worker**: cleo-subagent  
**Date**: 2026-04-15  
**Commit**: ed81d9fc  
**Status**: complete

---

## Summary

Three STDP Phase 5 subtasks implemented in sequence, all tests passing, build clean.

---

## T690 — STDP-A3: applyHomeostaticDecay (Step 9c)

**File**: `packages/core/src/memory/brain-stdp.ts`

Exported function `applyHomeostaticDecay(projectRoot, options?)`:

- Defaults: `decayRatePerDay=0.02`, `gracePeriodDays=7`, `pruneThreshold=0.05`
- Fetches all `brain_page_edges` with `plasticity_class IN ('hebbian', 'stdp')` and `last_reinforced_at` older than grace period
- Per edge: `new_weight = weight × (1 - decayRatePerDay)^decayDays` where `decayDays = daysIdle - gracePeriodDays`
- If `new_weight < pruneThreshold`: DELETE edge + write `brain_weight_history` row with `event_kind='prune'`
- If `new_weight >= pruneThreshold`: UPDATE weight only (decay events NOT logged per spec decision #11)
- `static` and `external` plasticity_class edges never touched
- `last_reinforced_at IS NULL` edges skipped (no reinforcement record)
- Returns `{ edgesDecayed: number; edgesPruned: number }`

Step 9c wired into `runConsolidation` after Step 9b (STDP), with `try/catch` so failure does not abort pipeline.

---

## T695 — STDP-A8: Session-bucket O(n²) guard

**File**: `packages/core/src/memory/brain-stdp.ts` (inside `applyStdpPlasticity`)

Before the pair loop, spikes are now grouped by `sessionId` into ordered session buckets. The O(n²) loop is preserved but with an additional cross-session cap:

- `MAX_PAIRS_PER_SESSION = 50` — constant controlling how many spikes from the tail of a session contribute to cross-session pairs
- Spikes that are deep inside their own session (position < `sessionSize - 50`) skip cross-session pairing but still pair within their own session
- Within-session pairs: always generated (no cap)
- Cross-session pairs: only generated when `spikeA` is among the last 50 spikes of its session
- Sorted order preserved → the `break` on `deltaT > pairingWindowMs` is still correct

Performance target: 5000 spikes → < 30 seconds. The bucketing ensures the inner loop is bounded even for large lookback windows.

---

## T694 — STDP-A7: Consolidation pipeline integration

**File**: `packages/core/src/memory/brain-lifecycle.ts`

Changes to `runConsolidation`:

1. Added `trigger` parameter: `'session_end' | 'maintenance' | 'scheduled' | 'manual'` (default: `'session_end'`)
2. `consolidationStartMs` captured at function entry
3. Step 9c (`applyHomeostaticDecay`) wired after Step 9b, individually try/caught
4. Step 9e: INSERT into `brain_consolidation_events` after all steps, recording trigger, session_id, `step_results_json` (full result), `duration_ms`, `succeeded=1`
5. `RunConsolidationResult` extended with `homeostaticDecay?: { edgesDecayed: number; edgesPruned: number }`

The complete ordered chain is now:
```
Step 9a: backfillRewardSignals
Step 9b: applyStdpPlasticity
Step 9c: applyHomeostaticDecay
Step 9e: INSERT brain_consolidation_events
```

---

## Tests

**File**: `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts`

| Test | Status |
|------|--------|
| T690-1: edge 30 days old decays to expected weight | PASS |
| T690-2: edge below pruneThreshold → deleted + prune history row | PASS |
| T690-3: edge reinforced within grace period → not touched | PASS |
| T690-4: static edges not touched even if 60 days old | PASS |
| T690-5: edge with NULL last_reinforced_at not touched | PASS |
| T695-1: 100 sessions × 50 entries → < 30 seconds | PASS |
| T695-2: within-session pairs always generated | PASS |
| T695-3: cross-session pair within 24h fires | PASS |
| T695-4: sessions > 24h apart produce no pairs | PASS |
| T694-1: runConsolidation inserts brain_consolidation_events row with stats | PASS |
| T694-2: Step 9a/9b/9c order verified; old edge pruned by 9c | PASS |
| T694-3: empty DB — pipeline does not throw (resilience) | PASS |
| T694-4: trigger field matches parameter; multiple runs create multiple rows | PASS |

All tests use real SQLite (no mocks). No `sleep()`, no time mocks.

---

## Quality Gates

- `pnpm biome check --write packages/core/src/memory/` — clean (1 auto-fix in test file)
- `pnpm --filter @cleocode/core build` — exit 0
- `pnpm run test` — zero new failures (T690 tests all pass; T695-1 fixed by replacing `.transaction()` with `BEGIN/COMMIT` for `DatabaseSync` compatibility)
