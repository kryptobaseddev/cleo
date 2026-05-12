# T793 + T794 — BRAIN P1 Batch: RRF Normalization + Retention Floor

**Date**: 2026-04-16
**Status**: complete
**Tasks**: T793 (BRAIN-04), T794 (BRAIN-05)
**Files Modified**:
- `packages/core/src/memory/brain-retrieval.ts`
- `packages/core/src/memory/__tests__/brain-retrieval.test.ts`

---

## T793 — BRAIN-04: RRF Relevance Normalization

### Problem

`memoryFind` / `searchBrainCompact` RRF path only returned `relevance` (a min-max
normalized version of the raw RRF score). Callers had no way to see the raw RRF score
or a BM25-derived score to distinguish strong from weak matches.

### Solution

**`BrainCompactHit` interface** (`brain-retrieval.ts` line ~49):

Added two optional fields:
- `rrfScore?: number` — raw RRF-fused score (sum of 1/(rank+60)) for the result.
  Present only on RRF path. Raw value directly comparable within a query.
- `bm25Score?: number` — BM25-derived score, min-max normalized to [0, 1].
  `1.0` = best FTS rank, `0.0` = not found via FTS. Present only on RRF path.

**RRF result mapping** (inside `searchBrainCompact`, RRF path):

```
const ftsRanks = rrfResults.map((r) => r.ftsRank ?? undefined).filter(...)
const maxFtsRank = ftsRanks.length > 0 ? Math.max(...ftsRanks) : 0

bm25Score = ftsRank !== undefined ? 1 - (maxFtsRank > 0 ? ftsRank / maxFtsRank : 0) : 0
rrfScore = r.score  // raw 1/(rank+60) sum
relevance = rrfRange > 0 ? (r.score - minRrf) / rrfRange : r.score  // unchanged semantic
```

### Proof

```
$ grep -c "rrfScore\|bm25Score" packages/core/src/memory/brain-retrieval.ts
13
```

### Tests Added (4 new in `T793 — rrfScore and bm25Score on compact hits` suite)

1. FTS-only path has no `rrfScore`; RRF path has `rrfScore > 0`
2. All `bm25Score` values in [0, 1] range
3. Single FTS result gets `bm25Score = 1.0`
4. `rrfScore` values are in descending order across results

---

## T794 — BRAIN-05: Short-Tier Observation Retention Floor

### Problem

All observations default to `memoryTier = 'short'`. With 1152 observations in short
tier (per T764 audit), cross-task and multi-task observations are vulnerable to
soft-eviction (7-day cutoff, quality < 0.5).

### Solution

**`ObserveBrainParams` interface** (`brain-retrieval.ts` line ~142):

Added optional field:
- `crossRef?: string[]` — explicit cross-references to other memory/task IDs.
  When ≥1 entry, the observation is auto-promoted to `'medium'` at write time.

**`observeBrain` function** — auto-promotion logic added before `memoryTier` assignment:

```typescript
// T794 BRAIN-05: retention floor
const taskIdMatches = text.match(/T\d+/g) ?? [];
const distinctTaskIds = new Set(taskIdMatches);
const hasMultipleTaskRefs = distinctTaskIds.size >= 2;
const hasCrossRef = Array.isArray(crossRef) && crossRef.length >= 1;
const memoryTier: BrainMemoryTier = hasMultipleTaskRefs || hasCrossRef ? 'medium' : 'short';
```

Two promotion criteria (either is sufficient):
- A. Text contains ≥2 **distinct** task ID patterns (`/T\d+/`)
- B. `crossRef` param has ≥1 entry

Duplicate task IDs in text do NOT trigger promotion — `new Set()` deduplicates.

### Proof

```
$ grep -c "crossRef\|distinctTaskIds\|hasCrossRef\|hasMultipleTaskRefs\|retention floor" packages/core/src/memory/brain-retrieval.ts
8
```

### Tests Added (7 new in `T794 — retention floor` suite)

1. Single task ID text stays `'short'`
2. Two distinct task IDs (`T793`, `T794`) promote to `'medium'`
3. Three distinct task IDs promote to `'medium'`
4. Same task ID repeated does NOT promote (dedup via `Set`)
5. `crossRef: ['D-rrf1']` promotes to `'medium'`
6. `crossRef: []` stays `'short'`
7. `crossRef` with no task IDs in text still promotes to `'medium'`

---

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | PASS (1 file reformatted) |
| `tsc` (brain-retrieval.ts) | PASS (0 errors in modified file) |
| `vitest run src/memory/__tests__/brain-retrieval.test.ts` | PASS — 35/35 |
| Pre-existing failures | brain-vec.test.ts, embedding-pipeline.test.ts — sqlite-vec env issue, NOT introduced |

## Test Run Output

```
Test Files  1 passed (1)
     Tests  35 passed (35)
  Start at  09:31:42
  Duration  4.53s
```
