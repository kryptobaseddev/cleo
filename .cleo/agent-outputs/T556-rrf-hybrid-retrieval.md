# RRF Hybrid Retrieval Implementation

**Task**: RRF Worker — Reciprocal Rank Fusion for BRAIN memory search
**Date**: 2026-04-13
**Status**: complete

## Summary

Implemented proper Reciprocal Rank Fusion (Cormack, Clarke & Buettcher SIGIR 2009) replacing the old weighted-score hybrid search in `brain-search.ts`.

## Changes

### `packages/core/src/memory/brain-search.ts`

Replaced the old `hybridSearch` (weighted normalized scores) with a proper RRF implementation:

**New exports:**
- `RRF_K = 60` — the research-proven smoothing constant
- `RrfHit` — input type for a single ranked result from one source
- `RrfResult` — fused output with `rrfScore`, `ftsRank`, `vecRank`, `sources`
- `reciprocalRankFusion(sources, k?)` — pure function, DB-free, testable

**Refactored `hybridSearch`:**
- Runs FTS5 and vector search in parallel (`Promise.all`)
- Builds ranked `RrfHit[]` from each source
- Fuses with `reciprocalRankFusion`
- `HybridSearchOptions` simplified: `limit` + `rrfK` only (removed `ftsWeight/vecWeight/graphWeight`)
- `HybridResult` now exposes `ftsRank` and `vecRank` for transparency

### `packages/core/src/memory/brain-retrieval.ts`

- Added `useRRF?: boolean` to `SearchBrainCompactParams` (default: `true`)
- RRF path: runs FTS and `hybridSearch` in parallel, uses FTS rows for dates, uses RRF for ordering
- Correctly backfills dates from FTS scan so `date` field is populated on RRF path
- FTS-only fallback for: agent filter (T418), `useRRF: false`

### `packages/core/src/memory/engine-compat.ts`

- `memorySearchHybrid` weight params (`ftsWeight/vecWeight/graphWeight`) marked `@deprecated`
- Only `limit` is now forwarded to `hybridSearch`

### `packages/core/src/memory/__tests__/brain-rrf.test.ts` (new)

20 tests covering:
- `RRF_K` constant equals 60
- Empty inputs return empty array
- Score formula: rank-0 = `1/(k+0)`, rank-1 = `1/(k+1)`, etc.
- Exact numeric verification: `1/60`, `1/61`, `1/62`
- Accumulation: item in 2 lists gets both contributions
- Cross-source fusion beats single-source champion
- `ftsRank`/`vecRank` correctness
- `sources` array tracking
- Custom `k` parameter
- `hybridSearch` integration: graceful degradation, limit, sort order

## Function Signature

```typescript
export function reciprocalRankFusion(
  sources: Array<{ source: 'fts' | 'vec' | 'graph'; hits: RrfHit[] }>,
  k?: number  // default: 60
): RrfResult[]

export async function hybridSearch(
  query: string,
  projectRoot: string,
  options?: { limit?: number; rrfK?: number }
): Promise<HybridResult[]>
```

## Math Verification

For a document appearing at rank `i` in a list with k=60:
- rank 0: score = 1/60 = 0.016667
- rank 1: score = 1/61 = 0.016393
- rank 59: score = 1/119 = 0.008403

Document in both FTS (rank 2) and vec (rank 0):
- score = 1/(60+2) + 1/(60+0) = 1/62 + 1/60 = 0.02957

FTS-only champion at rank 0:
- score = 1/60 = 0.016667

RRF correctly promotes the cross-source document above the FTS champion.

## Quality Gates

1. `pnpm biome check --write` — PASS (0 errors)
2. `pnpm run build` — PASS (0 errors)
3. `pnpm dlx vitest run .../brain-rrf.test.ts` — 20/20 PASS
4. `pnpm run test` — 0 new failures (pre-existing flaky failures in unrelated test files confirmed pre-existing via stash isolation)
