# T645 — Phase 3a: BRAIN_EDGE_TYPES enum drift fix

**Date**: 2026-04-15
**Status**: complete
**Task**: T645

## Summary

Fixed two edge types emitted by shipped code that were absent from Drizzle's `BRAIN_EDGE_TYPES` enum, plus two additional constants (`affects`, `mentions`) in `EDGE_TYPES` that were also absent from the schema.

## Changes Made

### 1. `packages/core/src/store/brain-schema.ts`

Added three new values to `BRAIN_EDGE_TYPES` (now 16 elements, was 13):
- `'code_reference'` — memory node → nexus symbol/file (graph-memory-bridge.ts emitter)
- `'affects'` — observation → symbol/file impact tracking (EDGE_TYPES.AFFECTS constant)
- `'mentions'` — observation → symbol name weak reference (EDGE_TYPES.MENTIONS constant)

Note: `'co_retrieved'` was already present from a prior commit. The description in the task context was based on older source; the schema had been partially updated.

### 2. `packages/core/src/memory/edge-types.ts`

Added `CODE_REFERENCE: 'code_reference'` constant to the `EDGE_TYPES` object. This removes the last caller that used a raw string literal for this edge type.

### 3. `packages/core/src/memory/graph-memory-bridge.ts`

Removed the `as import('../store/brain-schema.js').BrainEdgeType` cast on the `edgeType: 'code_reference'` insert (line ~284). The cast workaround comment said "Drizzle's enum type may not yet include 'code_reference'". With it now in the enum, the cast is no longer needed and `edgeType: 'code_reference'` is type-safe without coercion.

### 4. `packages/core/src/memory/__tests__/edge-type-enum-coverage.test.ts` (NEW)

New test file with 14 tests that guard against future enum drift:
- `it.each(EMITTED_EDGE_TYPES)` — iterates all 7 edge types emitted by shipped code, asserts each is in `BRAIN_EDGE_TYPES`
- `EDGE_TYPES constant values are a subset of BRAIN_EDGE_TYPES` — ensures all named constants stay in sync with schema
- Individual pin tests for `co_retrieved` and `code_reference` (the T626/T645 additions)
- `EDGE_TYPES.CO_RETRIEVED` and `EDGE_TYPES.CODE_REFERENCE` value pin tests
- No-duplicate check on `BRAIN_EDGE_TYPES`

## Migration Status

The `relates_to` → `co_retrieved` migration already existed at:
- `packages/core/migrations/drizzle-brain/20260415000001_t626-normalize-co-retrieved-edge-type/migration.sql`
- Idempotent safety-net UPDATE in `brain-sqlite.ts` initializer (lines 171-180)

No new migration was needed for `code_reference` — it was never emitted under a different name, it was simply missing from the enum while the INSERT used a raw cast to bypass the type check.

## Quality Gates

- `pnpm biome check --write packages/core` — clean, no fixes applied
- `pnpm --filter @cleocode/core run build` — clean (tsc, no errors)
- `pnpm --filter @cleocode/core run test` — 14 new tests pass; 1 pre-existing failure in `backup-pack.test.ts` (confirmed pre-existing on main before this change)

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| `co_retrieved` added to `BRAIN_EDGE_TYPES` | Already present (prior work) |
| `code_reference` added to `BRAIN_EDGE_TYPES` | Done in this task |
| One-shot migration `UPDATE brain_page_edges SET edge_type='co_retrieved' WHERE edge_type='relates_to'` | Already in migration + brain-sqlite.ts initializer (prior work) |
| `strengthenCoRetrievedEdges` emits `'co_retrieved'` not `'relates_to'` | Already done via `EDGE_TYPES.CO_RETRIEVED` constant (prior work) |
| `cleo memory code-auto-link` still works | Verified — cast removed, type-safe insert |
| All existing tests still pass | Confirmed — no new failures introduced |
| New test verifies enum coverage | Done — 14 tests in edge-type-enum-coverage.test.ts |
