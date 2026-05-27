# T1001 — Typed Promotion Implementation

**Status**: complete
**Task**: T1001
**Epic**: T1000
**Commit**: e411d1a10b18412a07d180f541c2fc94b829d8e2

## What Was Implemented

### New Files

- `packages/core/src/memory/promotion-score.ts` — 6-signal composite scorer
  - `computePromotionScore(signals)` → [0.0, 1.0]
  - `computePromotionRationale(signals, threshold)` → full per-signal breakdown
  - `mapObservationTypeToTier(type)` → 'learning' | 'pattern'
  - `PROMOTION_THRESHOLD = 0.6`
  - Weights: citation 0.20, quality 0.20, verified 0.20, stability 0.15, recency 0.15, outcome 0.10

- `packages/core/src/memory/__tests__/brain-lifecycle-typed-promotion.test.ts` — 19 tests, all passing

### Modified Files (schema additions already in T1002 commit a2c348c46)

- `packages/core/src/store/memory-schema.ts`
  - `stabilityScore: real('stability_score').default(0.5)` added to brainObservations
  - `brainPromotionLog` table + type exports added

- `packages/core/src/store/memory-sqlite.ts`
  - `ensureColumns(brain_observations, stability_score REAL DEFAULT 0.5)` in runBrainMigrations
  - `CREATE TABLE IF NOT EXISTS brain_promotion_log` + 4 indexes

- `packages/core/src/memory/brain-lifecycle.ts`
  - `promoteObservationsToTyped(projectRoot, limit, threshold)` added
  - Returns `TypedPromotionResult { promoted[], skippedCount, alreadyPromotedCount }`

## Key Design Decisions

1. `promoteObservationsToTyped` writes to brain_promotion_log ONLY — does not insert to brain_learnings/brain_patterns. Downstream step reads log rows.
2. Idempotency via `NOT EXISTS (SELECT 1 FROM brain_promotion_log WHERE observation_id = o.id)` — re-runs are safe.
3. stability_score on brain_observations is distinct from brain_page_edges.stability_score (both coexist).
4. outcome_correlated signal is stubbed at 0 — future wiring to task outcome correlation.

## Test Coverage

19 tests passing:
- computePromotionScore: scoring correctness, range bounds, null handling, verified boost
- computePromotionRationale: round-trip JSON, skip decision
- mapObservationTypeToTier: all 7 observation types
- promoteObservationsToTyped: happy path, no-op below threshold, idempotency, rationale_json capture, mixed batch, feature→pattern mapping
- stability_score: PROMOTION_THRESHOLD type check, null-safe scoring
