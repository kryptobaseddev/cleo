# T525 — Dedup Block Fix: patterns.ts and learnings.ts

**Task**: Fix empty `if (duplicate)` blocks that caused 96.7% duplicate patterns in brain.db.
**Status**: Complete
**Date**: 2026-04-11

## Changes Made

### `packages/core/src/memory/patterns.ts`

- **Before**: `if (duplicate)` block was empty — fell through to always INSERT a new row.
- **After**: When a duplicate is found by normalized text match (`trim().toLowerCase()`):
  1. Merges `examplesJson` arrays (union of task IDs, deduped via `Set`).
  2. Calls `accessor.updatePattern(duplicate.id, { frequency: +1, extractedAt: now, examplesJson: merged })`.
  3. Fetches the updated row via `accessor.getPattern()` and returns it with `examples` array.
  4. Only falls through to INSERT if no duplicate is found.

### `packages/core/src/memory/learnings.ts`

- **Before**: `if (duplicate)` block was empty — fell through to always INSERT a new row.
- **After**: When a duplicate is found by normalized text match (`trim().toLowerCase()`):
  1. Takes `Math.max(duplicate.confidence, params.confidence)` for the confidence field.
  2. Calls `accessor.updateLearning(duplicate.id, { confidence: maxConfidence })` — `updatedAt` is set automatically by the accessor's `set()` clause.
  3. Fetches the updated row via `accessor.getLearning()` and returns it with `applicableTypes` array.
  4. Only falls through to INSERT if no duplicate is found.
- Also removed the now-unused `now` variable from `storeLearning` (the original had `extractedAt: now` in the entry object despite `brainLearnings` having no `extractedAt` column — this was a latent bug cleaned up as part of this fix).

## Quality Gates

- `pnpm biome check --write` — 4 pre-existing optional-chain warnings (not errors); no new issues.
- `pnpm run build` — passed.
- `pnpm run test` — all relevant test files pass in isolation (45/45 across auto-extract, hook-automation-e2e, performance-safety). Full suite has 2 pre-existing flaky failures under parallel load (performance timing test, hook-automation timing) unrelated to these changes.

## Root Cause Summary

Both files detected duplicates but the detection result was never acted on — the `if (duplicate)` block contained only comments explaining the intent. The accessor already had `updatePattern()` and `updateLearning()` methods ready to use; they just weren't wired up.
