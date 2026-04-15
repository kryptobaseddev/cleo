# T626-M1: Normalize `co_retrieved` Edge Type

> Task: T626 (epic) — M1 micro-task
> Date: 2026-04-15
> Status: complete
> Commit: be65a0da

## Summary

Fixed the Hebbian co-retrieval strengthener in `brain-lifecycle.ts` which was emitting `edge_type = 'relates_to'` instead of the canonical `'co_retrieved'` value already present in `BRAIN_EDGE_TYPES`. Added canonical edge-type constants and a data migration.

## Changes Made

### New File: `packages/core/src/memory/edge-types.ts`
- `EDGE_TYPES` constant map with 7 canonical brain_page_edges edge type strings
- `EdgeType` union type
- Exported from `packages/core/src/memory/index.ts`

### Fixed: `packages/core/src/memory/brain-lifecycle.ts`
- `strengthenCoRetrievedEdges` now imports and uses `EDGE_TYPES.CO_RETRIEVED`
- Both the UPDATE path (strengthen existing edge) and INSERT path (create new edge) use the constant
- No more raw `'relates_to'` strings in Hebbian code

### Migration: `packages/core/migrations/drizzle-brain/20260415000001_t626-normalize-co-retrieved-edge-type/migration.sql`
- One-shot `UPDATE brain_page_edges SET edge_type = 'co_retrieved' WHERE edge_type = 'relates_to' AND provenance LIKE 'consolidation:%'`
- Provenance-gated to only touch Hebbian edges, not semantic edges

### Safety Net: `packages/core/src/store/brain-sqlite.ts`
- `runBrainMigrations` applies the same idempotent UPDATE as a guard for installs where the Drizzle journal reconciler may have already marked the migration applied

## Acceptance Criteria Status

- [x] `BRAIN_EDGE_TYPES` contains `'co_retrieved'` (was already present)
- [x] `strengthenCoRetrievedEdges` emits `edge_type = 'co_retrieved'` only
- [x] Migration correctly relabels existing `relates_to` rows from co-retrieval provenance
- [x] Drizzle typed layer accepts the edge without casting
- [x] `pnpm biome check --write .` passes (clean)
- [x] `pnpm run build` passes
- [x] `pnpm run test` — 7491 tests pass, 0 new failures

## Key Files

- `/mnt/projects/cleocode/packages/core/src/memory/edge-types.ts` (new)
- `/mnt/projects/cleocode/packages/core/src/memory/brain-lifecycle.ts` (lines 24, 985, 996)
- `/mnt/projects/cleocode/packages/core/src/store/brain-sqlite.ts` (lines 162-179)
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/20260415000001_t626-normalize-co-retrieved-edge-type/migration.sql`
