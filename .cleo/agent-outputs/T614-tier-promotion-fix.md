# T614: BRAIN Tier Promotion Fix

**Task**: BUG: BRAIN tier promotion not running — 235 observations stuck in short tier
**Status**: complete
**Date**: 2026-04-14

## Root Cause

`runTierPromotion` required `verified = 1` as a hard gate for ALL promotion paths. Since 239/275 observations were `verified = 0` (the default), they could never promote regardless of quality score or citation count.

The function was also not called from `cleo brain maintenance` — only from `session end` via `setImmediate`.

## Diagnosis

```sql
-- All 275 observations stuck in short tier
SELECT memory_tier, verified, COUNT(*) FROM brain_observations GROUP BY memory_tier, verified;
-- short|0|239
-- short|1|36

-- Observations that should have promoted but didn't
SELECT id, quality_score, verified, citation_count FROM brain_observations
WHERE verified = 1 AND created_at < datetime('now', '-24 hours') AND quality_score >= 0.7;
-- e.g. O-mnxnlc5s-0|0.75|1|15  -- quality=0.75, 15 citations, >24h old -- SHOULD HAVE PROMOTED
```

## Fix

### 1. Relaxed promotion criteria in `runTierPromotion` (brain-lifecycle.ts)

**Before**: `verified = 1` required for ALL paths (blocked 239 observations).

**After**: Three independent promotion tracks for short → medium:
- A. `citation_count >= 3 AND age > 24h` (no verified required)
- B. `quality_score >= 0.7 AND age > 24h` (no verified required)
- C. `verified = 1 AND age > 24h` (owner-verified)

Medium → long promotion:
- A. `citation_count >= 5 AND age > 7d` (no verified required)
- B. `verified = 1 AND age > 7d` (accelerated track)

### 2. Added tier promotion to `runBrainMaintenance` (brain-maintenance.ts)

Previously `cleo brain maintenance` only ran decay, consolidation, reconciliation, embeddings. Now it also runs tier promotion as step 4 between reconciliation and embeddings. Added `--skip-tier-promotion` flag and `tierPromotion` result field.

### 3. Added `cleo memory consolidate` command (memory-brain.ts)

New on-demand command that runs the full `runConsolidation` pipeline (dedup, quality recompute, tier promotion, contradiction detection, soft eviction, graph strengthening, summaries). Previously only accessible via session end hook.

### 4. Exported new symbols from internal.ts

Added `runConsolidation`, `runTierPromotion`, `EvictionRecord`, `PromotionRecord`, `PromotionResult`, `RunConsolidationResult`, `BrainMaintenanceTierPromotionResult` to `@cleocode/core/internal`.

## Results

Before: all 275+ observations in short tier.

After running `cleo memory consolidate` (or `cleo brain maintenance`):
- medium: 27 observations promoted
- short: 295 (was 313)
- invalid (evicted): 15 stale low-quality entries soft-evicted

## Files Changed

- `packages/core/src/memory/brain-lifecycle.ts` — relaxed promotion criteria
- `packages/core/src/memory/brain-maintenance.ts` — added tier promotion step + types
- `packages/core/src/internal.ts` — exported new symbols
- `packages/cleo/src/cli/commands/brain.ts` — added `--skip-tier-promotion` flag
- `packages/cleo/src/cli/commands/memory-brain.ts` — added `cleo memory consolidate`
- `packages/core/src/memory/__tests__/brain-lifecycle-tier-promotion.test.ts` — 9 new tests
- `packages/core/src/memory/__tests__/brain-automation.test.ts` — added runTierPromotion mock

## Tests

9 new unit tests in `brain-lifecycle-tier-promotion.test.ts`:
1. Null nativeDb returns empty result
2. Unverified observation with quality_score >= 0.7 promotes (T614 regression test)
3. Unverified observation with citation_count >= 3 promotes
4. Verified observation with any quality promotes via owner-verified track
5. Unverified medium entry with citation_count >= 5 promotes to long
6. Verified medium entry accelerates to long without citation threshold
7. Soft eviction of stale short entries
8. All four memory tables processed
9. Empty result when no entries qualify

All 9 tests pass. Brain-automation tests fixed (7 failures resolved by adding runTierPromotion mock).
