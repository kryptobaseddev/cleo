# T549 Wave 3: Consolidator + Tier Promotion + Budget-Aware Retrieval

**Task**: T549 Wave 3 (Subagent Worker)
**Date**: 2026-04-11
**Status**: Complete
**Quality Gates**: biome clean, build clean, 7129/7129 tests pass (0 new failures)

---

## What Was Built

### Wave 3-B: Tier Promotion (`packages/core/src/memory/brain-lifecycle.ts`)

New exported function `runTierPromotion(projectRoot)` implementing:

- **short → medium**: citationCount >= 3 AND age > 24h AND verified = true, OR qualityScore >= 0.70 AND verified = true (fast-track)
- **medium → long**: citationCount >= 5 AND age > 7 days AND verified = true
- **Soft eviction**: short-term entries older than 7 days, unverified, qualityScore < 0.5 get `invalidAt = now()`
- **Long-term protection**: long entries are never touched by auto-eviction
- **Best-effort**: all table operations wrapped in try/catch; per-table failures skip gracefully
- Covers all four tables: `brain_observations`, `brain_learnings`, `brain_patterns`, `brain_decisions`

### Wave 3-C: Contradiction Detection (`packages/core/src/memory/brain-consolidator.ts`)

New file with exported function `detectContradictions(projectRoot)` implementing:

- Scans verified, valid entries per table (up to 200 per table)
- Builds keyword sets, finds pairs with >= 3 shared keywords
- Detects polarity flip via 19 negation markers: "not", "never", "deprecated", "removed", "replaced", etc.
- Creates `contradicts` edges in `brain_page_edges` (both directions) for found pairs
- Lowers the contradicted entry's quality_score by 0.15
- Short-circuits at 50 contradiction pairs to limit consolidation cost
- Returns `ContradictionResult[]` with entryAId, entryBId, contradictedId, sharedKeywords, negationMarkers

### Wave 3-D: Extended Consolidation (`packages/core/src/memory/brain-lifecycle.ts`)

New exported function `runConsolidation(projectRoot)` orchestrating 7 sequential steps:

1. **Deduplication** — `deduplicateByEmbedding()`: merges exact content-hash duplicates (transfers citations, soft-evicts clones)
2. **Quality recompute** — `recomputeQualityScores()`: applies citation boost (+0.01/citation, capped at +0.15)
3. **Tier promotion** — calls `runTierPromotion()`
4. **Contradiction detection** — calls `detectContradictions()` from brain-consolidator
5. **Soft eviction** — `softEvictLowQualityMedium()`: invalidates medium-tier entries older than 30d with quality < 0.30
6. **Graph edge strengthening** — `strengthenCoRetrievedEdges()`: reads `brain_retrieval_log`, increments weight +0.1 on co-retrieved pairs (>= 3 times in 30d), inserts new `relates_to` edges if absent
7. **Summary generation** — delegates to existing `consolidateMemories()` (clusters >= 5, age >= 30d)

Each step is individually wrapped in try/catch; any step failure logs to `console.warn('[consolidation]')` and continues.

### Wave 3-E/F: Session End Wiring (`packages/core/src/hooks/handlers/session-hooks.ts`)

New hook handler `handleSessionEndConsolidation` registered at priority 5 (runs after backup at priority 10):

```typescript
setImmediate(async () => {
  const { runConsolidation } = await import('../../memory/brain-lifecycle.js');
  await runConsolidation(projectRoot);
});
```

Uses `setImmediate` to yield the event loop so the session end response reaches the caller before consolidation begins — implementing the "sleep-time compute" pattern from the spec.

### Wave 3-A: Budget-Aware Retrieval (`packages/core/src/memory/brain-retrieval.ts`)

New exported function `retrieveWithBudget(projectRoot, query, tokenBudget=500, options?)` implementing:

- **Parallel search strategies**: FTS5 (50% weight) + vector KNN (40%) + graph neighbors (10%, currently stubbed as empty — degrades gracefully)
- **Score fusion**: `(fts*0.50 + vec*0.40 + graph*0.10) × qualityScore`
- **Recency boost**: +0.05 for entries updated in last 7 days
- **Type priority**: procedural/pattern entries get +0.10 boost
- **Option filters**: `types` (semantic/episodic/procedural), `tiers` (short/medium/long), `verified`
- **Budget enforcement**: walks candidates in priority order (procedural first, episodic last), stops when tokenBudget exhausted
- **Citation tracking**: `setImmediate(() => incrementCitationCounts(...))` — non-blocking background increment via internal helper that routes IDs to correct tables by prefix
- Returns `BudgetedResult` with `entries`, `tokensUsed`, `tokensRemaining`, `excluded`

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/memory/brain-lifecycle.ts` | Added `runTierPromotion`, `runConsolidation`, plus private helpers: `deduplicateByEmbedding`, `recomputeQualityScores`, `softEvictLowQualityMedium`, `strengthenCoRetrievedEdges`. Types: `PromotionRecord`, `EvictionRecord`, `PromotionResult`, `RunConsolidationResult`. |
| `packages/core/src/memory/brain-consolidator.ts` | New file. `detectContradictions`, `ContradictionResult`, helpers. |
| `packages/core/src/memory/brain-retrieval.ts` | Added `retrieveWithBudget`, `incrementCitationCounts`, types: `BudgetedRetrievalOptions`, `BudgetedEntry`, `BudgetedResult`. Added `searchSimilar` import. |
| `packages/core/src/hooks/handlers/session-hooks.ts` | Added `handleSessionEndConsolidation` hook (priority 5, setImmediate fire-and-forget). |
| `packages/core/src/memory/index.ts` | Added `export * from './brain-consolidator.js'`. |

---

## Design Decisions

- **`brain_retrieval_log` graceful no-op**: Graph edge strengthening queries `brain_retrieval_log` which may not exist yet (Wave 4 creates it). The step catches the missing-table error and returns 0 — clean no-op.
- **Vector search in `retrieveWithBudget`**: Uses the existing `searchSimilar()` from `brain-similarity.ts` which already handles the "no embeddings" case by returning `[]`. No extra guard needed.
- **Graph neighbor score fusion**: Stubbed as empty array in the parallel Promise.all — the architecture is wired for the 10% weight, but populating graph neighbors requires a graph query that would add latency. The slot exists for Wave 4 to fill.
- **Content-hash dedup focus**: `deduplicateByEmbedding` currently does exact content-hash dedup (not embedding cosine), since brain_embeddings only exists for observations. This is correct for Wave 3 scope; embedding-level dedup across tables is a Wave 4 concern.
- **Long-term protection enforced at two levels**: Both `runTierPromotion` (eviction exclusion via `WHERE memory_tier = 'short'`) and `softEvictLowQualityMedium` (only targets `memory_tier = 'medium'`) never touch long-tier entries.

---

## Quality Gates

- `pnpm biome check --write` — clean (4 files auto-fixed for formatting)
- `pnpm run build` — clean (all packages built successfully)
- `pnpm run test` — 396 test files passed, 7129 tests passed, 0 new failures
