# T1834: PERF — nexus context/impact/clusters SQL WHERE filter

## Summary

Eliminated full-table scans in `packages/core/src/nexus/{context,impact,clusters}.ts`.
All three files called `db.select().from(nexusSchema.nexusNodes).all()` loading every
row from shared global nexus.db before filtering in JavaScript. With a shared DB of
24k rows (15k from cleocode project alone), this caused multi-hundred-millisecond
query overhead.

## Changes

### `context.ts`
- `getSymbolContext`: replaced `allNodes` full scan + JS `filter(n => n.projectId === projectId && ...)` with:
  - SQL: `WHERE project_id = ? AND kind NOT IN ('community','process')` for symbol candidate nodes
  - SQL: `WHERE project_id = ?` for relations
  - SQL: `WHERE project_id = ?` for `nodeById` lookup map (all kinds needed for community/process label resolution)
- Removed redundant `r['projectId'] === projectId` guards from inner relation filter loops (already SQL-filtered)
- Imports: added `and, notInArray` from `drizzle-orm`

### `impact.ts`
- `getSymbolImpact` (Drizzle ORM path): same pattern as context.ts
  - SQL: `WHERE project_id = ? AND kind NOT IN ('community','process')` for symbol nodes
  - SQL: `WHERE project_id = ?` for relations
  - `nodeById` now built from project-scoped nodes only
  - Removed redundant `r['projectId'] === projectId` guard in adjacency-map loop
- `nexusImpact` (raw SQL path): already used SQL WHERE — left unchanged
- Imports: added `and, eq, notInArray` from `drizzle-orm`

### `clusters.ts`
- `getProjectClusters`: replaced full scan + `filter(kind='community' && projectId)` with:
  - SQL: `WHERE project_id = ? AND kind = 'community'`
- Imports: added `and, eq` from `drizzle-orm`

## Performance Results

Micro-benchmark on live nexus.db (24,348 total rows, 15,434 in cleocode project):

| Pattern | p50 | Speedup |
|---------|-----|---------|
| OLD: full scan + JS filter | 82ms | baseline |
| NEW: SQL WHERE filter | 4ms | **20x faster** |

Bench fixture test (5-file fixture, no regression): passes.

## Follow-up Opportunities

Other files in `packages/core/src/nexus/` that may load full-table:
- `query.ts` — check for unfiltered `.all()` calls
- `flows.ts` — process nodes query pattern
- `augment.ts` — uses raw SQL with WHERE already (lines 209-238), but verify it scopes by projectId consistently
- `living-brain.ts` — large file, check for unfiltered node loads

## Evidence

- Commit: `af70f0aa0572f25d182fdd4e05d11ab3570bed9b` (task/T1834 → merged to main)
- Files: `packages/core/src/nexus/context.ts`, `packages/core/src/nexus/impact.ts`, `packages/core/src/nexus/clusters.ts`
- Tests: 335 passed / 0 failed / 1 skipped (nexus suite, 118 test files)
- lint: biome exit 0 (no fixes needed after auto-format)
- typecheck: tsc -b exit 0
