# T035: Intelligence Dimension Implementation

**Status**: complete
**Date**: 2026-03-21
**Task**: T035
**Epic**: T029 (Schema Architecture Review)

## Summary

Completed the Intelligence (I) dimension of BRAIN with adaptive validation and quality prediction. The existing intelligence module already had substantial infrastructure (prediction.ts, patterns.ts, impact.ts). This task extended it with the missing pieces:

## What Was Already in Place

The `packages/core/src/intelligence/` module already contained:

- `prediction.ts` — `calculateTaskRisk`, `predictValidationOutcome`, `gatherLearningContext`
- `patterns.ts` — `extractPatternsFromHistory`, `matchPatterns`, `storeDetectedPattern`, `updatePatternStats`
- `impact.ts` — `analyzeTaskImpact`, `analyzeChangeImpact`, `calculateBlastRadius`
- `types.ts` — all type definitions
- `__tests__/` — 65 passing tests covering all three modules

## What Was Implemented (T035)

### New File: `packages/core/src/intelligence/adaptive-validation.ts`

Four exported functions and four exported types:

#### Functions

**`suggestGateFocus(taskId, taskAccessor, brainAccessor)`**
- Analyzes a task and suggests which verification gates to focus on, ordered by risk
- Skips already-passed gates (avoids redundant recommendations)
- Computes gate-level risk from: task attributes (size, priority, labels) + historical brain_patterns failures
- Security-labeled tasks (auth, security, crypto) automatically get high-priority securityPassed gate
- Returns `AdaptiveValidationSuggestion` with ordered `GateFocusRecommendation[]`, overall confidence, and actionable tips
- Includes mitigations from historical failure patterns in gate rationales

**`scoreVerificationConfidence(taskId, verification, taskAccessor, brainAccessor, options)`**
- Computes a 0-1 confidence score after a verification round
- Score components: gate pass ratio (up to 0.6) + failure log penalty (up to 0.2) + round penalty (up to 0.2)
- Persists a `brain_observations` row (type: discovery) with full gate/task metadata
- Extracts a `brain_learnings` row for notable outcomes:
  - High-confidence first-round passes (confidence >= 0.8, round 1)
  - Multi-gate failures (>= 2 gates failed) → actionable learning
  - High failure log (>= 3 entries) → actionable learning
- Supports `dryRun: true` for tests

**`storePrediction(prediction, brainAccessor, options)`**
- Persists a `ValidationPrediction` to `brain_observations` for future learning
- Stores pass likelihood, blockers, and suggestions as structured facts JSON
- Supports `project` and `sessionId` tagging

**`predictAndStore(taskId, stage, taskAccessor, brainAccessor, options)`**
- Convenience wrapper: calls `predictValidationOutcome` then `storePrediction`
- Returns the prediction with an optional `observationId`

#### Types

- `GateFocusRecommendation` — per-gate priority, rationale, estimated pass likelihood
- `AdaptiveValidationSuggestion` — full suggestion set with ordered gate focus and tips
- `VerificationConfidenceScore` — scored verification result with optional brain IDs
- `StorePredictionOptions` — dryRun, sessionId, project options

### Updated: `packages/core/src/intelligence/index.ts`

Added exports for all four new functions and four new types from `adaptive-validation.ts`.

### New Tests: `packages/core/src/intelligence/__tests__/adaptive-validation.test.ts`

25 tests covering:
- `suggestGateFocus`: not-found, simple task, gate skipping, security labels, historical patterns, ordering, tips
- `scoreVerificationConfidence`: all-fail, all-pass, gate classification, observation persistence, learning extraction
- `storePrediction`: dry-run, persistence, subtitle content
- `predictAndStore`: full integration, dry-run, not-found
- Boundary cases: ideal confidence (1.0), multi-round penalty, clamp to [0,1]

## Quality Gates

| Gate | Status |
|------|--------|
| biome check --write | Pass (1 pre-existing warning in backfill.ts, 0 errors) |
| pnpm run build | Pass (Build complete) |
| pnpm run test | Pass (118 pre-existing failures unchanged; 25 new tests all pass) |

## Files Changed

- `packages/core/src/intelligence/adaptive-validation.ts` — NEW (766 lines)
- `packages/core/src/intelligence/__tests__/adaptive-validation.test.ts` — NEW (670 lines, 25 tests)
- `packages/core/src/intelligence/index.ts` — UPDATED (added 12 new exports)

## Design Decisions

- No new database tables — all storage uses existing `brain_observations` and `brain_learnings` tables
- `dryRun` option on all persistence functions for test isolation
- Gate risk blends 30% intrinsic (task attributes) with 70% historical (brain_patterns) when data is available
- Security labels use a multiplicative approach: 2+ labels → high risk (>= 0.6), 1 label → medium risk
- Learning extraction is selective (notable outcomes only) to avoid noise in brain.db
- Confidence score formula is deterministic: 0.6 gates + 0.2 failure penalty + 0.2 round penalty
