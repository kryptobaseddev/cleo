# T790 BRAIN-01 — Hebbian Co-Retrieval Threshold Fix

**Task**: T790 (child of T770 BRAIN P0 Fixes)
**Epic**: T760 RCASD
**Date**: 2026-04-16
**Worker**: BRAIN-01

---

## Summary

Fixed the Hebbian co_retrieved edge writer to require co-appearance in >= 3 **distinct query strings** before emitting an edge. The previous implementation counted raw log row co-occurrences, meaning that running the same `cleo memory find` 3 times would trivially create edges between all returned nodes (N*(N-1)/2 edges per query batch).

---

## Root Cause (T764 audit: P0-T764-A)

`strengthenCoRetrievedEdges` in `packages/core/src/memory/brain-lifecycle.ts` built a `Map<pairKey, number>` counting raw co-occurrences from `brain_retrieval_log` rows. Each log row (one retrieval call) contributed `N*(N-1)/2` pair counts. With `limit=5`, three calls to any search returning the same results produced count=3 for all 10 pairs, all of which then became edges. The `count < 3` guard was structurally correct but the counting unit was wrong.

The audit found **6,026 co_retrieved edges** vs 1,482 graph nodes — a 4:1 ratio that drowned real supersession/contradiction signals.

---

## Fix Applied

**File**: `packages/core/src/memory/brain-lifecycle.ts`

Changed `Map<string, number>` (raw count per pair) to `Map<string, Set<string>>` (set of distinct normalized query strings per pair).

Key changes:
- Fetch both `query` and `entry_ids` columns from `brain_retrieval_log`
- Normalize query per row: `query.toLowerCase().replace(/\s+/g, ' ').trim()`
- Add query string to a `Set<string>` per pair (deduplicates repeated identical searches)
- Gate: only emit edge when `querySet.size >= 3` (was `count >= 3`)
- Named constant `MIN_DISTINCT_QUERIES = 3` for clarity

Added test-only export `strengthenCoRetrievedEdgesForTest` to enable unit testing without full consolidation pipeline.

**No changes to**: `brain_page_edges.provenance` (T759 owned), RRF (T793 scope), `supersedes` edges (write path untouched).

---

## Migration

**File**: `packages/core/migrations/drizzle-brain/20260416000006_t790-hebbian-prune/migration.sql`

Two DELETE statements (idempotent/no-op-safe):
1. DELETE `co_retrieved` edges with `plasticity_class IN ('hebbian', 'static') AND weight < 0.3` — low-weight noise that never received a full consolidation cycle
2. DELETE `co_retrieved` edges with `plasticity_class IN ('hebbian', 'static') AND created_at < '2026-04-16 00:00:00'` — all pre-fix edges created under the broken raw-count path

Preserves: `plasticity_class = 'stdp'` edges (STDP-upgraded edges carry timing-window signal, remain regardless of weight).

Expected edges pruned: ~5,000-6,000 (audit showed 6,026 total, STDP edges are a small fraction).

Also adds `CREATE INDEX IF NOT EXISTS idx_brain_page_edges_type_plasticity` for efficient edge-type + plasticity queries.

---

## Unit Tests

**File**: `packages/core/src/memory/__tests__/hebbian-threshold.test.ts`

6 test cases:
| Case | Description | Expected |
|------|-------------|----------|
| 1 | 1 log row, pair [A,B] | No edge (1 distinct query < threshold) |
| 2 | Same query repeated 3x | No edge (distinct count = 1) |
| 3 | 3 distinct queries co-returning [A,B] | Edge emitted for A-B only |
| 4 | Mixed-case / whitespace variants of same query | No edge (normalizes to 1 distinct) |
| 5 | nativeDb unavailable | Returns 0, no throw |
| 6 | Retrieval log table missing | Returns 0, graceful no-op |

**Result**: 6/6 PASS. Full core suite: 260 test files, 4060 tests passed, 32 todo.

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/memory/brain-lifecycle.ts` | `strengthenCoRetrievedEdges` — distinct-query counting; added `strengthenCoRetrievedEdgesForTest` export |
| `packages/core/src/memory/__tests__/hebbian-threshold.test.ts` | New: 6 unit tests for threshold gate |
| `packages/core/migrations/drizzle-brain/20260416000006_t790-hebbian-prune/migration.sql` | New: prune noise edges, add index |

---

## Edge Count Estimate

| Metric | Value |
|--------|-------|
| edges_before (audit) | 6,026 co_retrieved |
| edges_preserved (STDP class) | ~50-100 (rough estimate) |
| edges_after_migration (estimate) | <100 |
| test_cases | 6 |
