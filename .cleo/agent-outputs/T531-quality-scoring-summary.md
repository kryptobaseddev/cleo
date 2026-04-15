# T531 — Quality Scoring Wired into Store Functions

**Task**: Wave C-2: Wire quality scoring into store functions
**Epic**: T523
**Status**: complete
**Date**: 2026-04-12

## Summary

Quality score computation is now wired into all four BRAIN memory store
functions (`storePattern`, `storeLearning`, `storeDecision`, `observeBrain`).
Search results from `brain-search.ts` exclude entries with
`quality_score < 0.3`, using `IS NULL OR quality_score >= 0.3` to preserve
legacy rows that have no score yet.

## Files Created

- `packages/core/src/memory/quality-scoring.ts` — reusable scoring module
  (exported from `packages/core/src/index.ts` for T530 backfill and future hooks)
- `packages/core/migrations/drizzle-brain/20260412000001_t531-quality-score-typed-tables/migration.sql`
  — ALTER TABLE adds `quality_score` column + indexes to all 4 typed tables

## Files Modified

### Schema
- `packages/core/src/store/brain-schema.ts`
  - `brainDecisions.qualityScore: real('quality_score')` + index
  - `brainPatterns.qualityScore: real('quality_score')` + index
  - `brainLearnings.qualityScore: real('quality_score')` + index
  - `brainObservations.qualityScore: real('quality_score')` + index

### Store functions
- `packages/core/src/memory/decisions.ts` — `storeDecision` calls
  `computeDecisionQuality` before insert; score is passed in `NewBrainDecisionRow`
- `packages/core/src/memory/patterns.ts` — `storePattern` calls
  `computePatternQuality` before insert; score is passed in `NewBrainPatternRow`
- `packages/core/src/memory/learnings.ts` — `storeLearning` calls
  `computeLearningQuality` before insert; score is passed in `NewBrainLearningRow`
- `packages/core/src/memory/brain-retrieval.ts` — `observeBrain` calls
  `computeObservationQuality` before insert; score is passed in `NewBrainObservationRow`

### Search filtering
- `packages/core/src/memory/brain-search.ts`
  - FTS5 queries: JOIN condition extended with `AND (t.quality_score IS NULL OR t.quality_score >= ?)`
  - LIKE fallback queries: same condition applied to all four tables
  - Imports `QUALITY_SCORE_THRESHOLD` (0.3) from `quality-scoring.ts`

### Exports
- `packages/core/src/index.ts` — exports all four compute functions,
  the threshold constant, and the four input type interfaces

## Quality Score Formulas

| Entry type   | Base | Key bonuses |
|--------------|------|-------------|
| Pattern      | 0.4  | +0.10 workflow type; +0.10 pattern > 100 chars; +0.10 context > 50 chars; +0.10 examples > 3 |
| Learning     | confidence | +0.10 actionable; +0.10 insight > 100 chars; +0.10 application > 20 chars |
| Decision     | high=0.9 / medium=0.7 / low=0.5 | +0.10 rationale > 50 chars; +0.05 task linked |
| Observation  | 0.6  | +0.10 text > 200 chars; +0.05 title > 10 chars |

All scores clamped to [0.0, 1.0]. NULL = legacy entry (not excluded).

## Quality Gates

- `pnpm biome check --write --unsafe` — no errors; 5 files cleaned
- `pnpm run build` — passes (390 test files, zero build errors)
- `pnpm run test` — 7016 passed, 15 skipped, 32 todo (zero new failures)
