# T635 Phase 1 — LBNode.createdAt + Time Slider

**Task**: T635 (Phase 1 of 3)
**Date**: 2026-04-15
**Status**: complete

## Summary

Wired `LBNode.createdAt: string | null` from each substrate's timestamp column
and enabled the time slider in `/living-brain`.

## Files Changed

### Type Contract
- `packages/studio/src/lib/server/living-brain/types.ts`
  - Added `createdAt: string | null` field to `LBNode` interface with full TSDoc

### Substrate Adapters
- `adapters/brain.ts` — set `createdAt: row.created_at` on all four node types
  (observations, decisions, patterns, learnings); source column is ISO-8601 text
- `adapters/nexus.ts` — added `indexed_at` to `NexusNodeRow`, set `createdAt: row.indexed_at ?? null`
- `adapters/tasks.ts` — set `createdAt: row.created_at` for tasks, `createdAt: row.started_at` for sessions
- `adapters/conduit.ts` — corrected `created_at` type from `string` to `number` (INTEGER unix epoch),
  added `epochToIso()` helper, set `createdAt: epochToIso(row.created_at)`
- `adapters/signaldock.ts` — corrected `created_at` type to `number | null`, added `epochToIso()` helper,
  set `createdAt: epochToIso(row.created_at)`

### Svelte Page
- `src/routes/living-brain/+page.svelte`
  - Added `useTimeSlider` and `sliderIndex` `$state` variables
  - Added `allDates` `$derived` (sorted unique YYYY-MM-DD strings from all graph nodes)
  - Added `filterDate` `$derived` (selected date or null when slider is off)
  - Extended `filteredGraph` `$derived` to apply date filter (nodes created after slider date are hidden;
    nodes with `null` createdAt are always visible)
  - Added `toggleSlider()` and `onSliderChange()` handlers
  - Added time-slider toggle button + range input to header controls
  - Replaced legend TODO placeholder with functional time slider legend
  - Removed orphaned `.legend-todo` and `.todo-note` CSS selectors
  - Added toggle/slider CSS classes

### Tests
- `__tests__/types.test.ts` — updated all `LBNode` fixtures to include `createdAt`; added 2 new test cases
- `__tests__/created-at-projection.test.ts` (new) — 10 tests covering:
  - `createdAt` contract via `getAllSubstrates()` (string | null, never undefined)
  - ISO-8601 format validation for string values
  - Fixture-based tests for each substrate type
  - UNIX epoch conversion (conduit/signaldock pattern)
  - `allDates` derivation logic (null filtering, dedup, sort)

### Infrastructure
- `packages/studio/package.json` — added `"test": "vitest run"` script
- `packages/studio/vitest.config.ts` (new) — node environment, `$lib` alias

## Quality Gates

- `pnpm biome check --write packages/studio` — No fixes applied (clean)
- `pnpm --filter @cleocode/studio run build` — Built in 1.87s (0 errors)
- `pnpm --filter @cleocode/studio run test` — 2 test files, 34 tests passed

## Out of Scope

Phase 2 (SSE endpoint) and Phase 3 (Cosmograph) were not touched.
