# T1062: External Module Nodes Implementation

**Task**: T1062 (Worker)  
**Epic**: T1042 (Nexus gap closure — EP2-T1)  
**Date**: 2026-04-20  
**Status**: COMPLETE  

## Summary

Implemented EP2-T1 from the T1042 gap analysis: persist unresolved imports as ExternalModule nodes with imports relations. Expected to close ~55% of the 390k edge gap against gitnexus when openclaw re-analyzes.

## Changes Made

### 1. Schema & Migration

**File**: `packages/core/src/store/nexus-schema.ts`
- Added `isExternal: integer('is_external', { mode: 'boolean' }).notNull().default(false)` column to `nexus_nodes` table
- Added index: `idx_nexus_nodes_is_external` for efficient external module lookups

**File**: `packages/core/src/store/nexus-sqlite.ts`
- Added self-healing migration via `ensureColumns()` in `runNexusMigrations()` (T991 pattern):
  ```typescript
  ensureColumns(nativeDb, 'nexus_nodes', [{ name: 'is_external', ddl: 'integer DEFAULT 0' }], 'nexus');
  ```
- No new migration files needed; uses idempotent ALTER TABLE ADD COLUMN

### 2. Type System

**File**: `packages/contracts/src/graph.ts`
- Added optional field to GraphNode interface:
  ```typescript
  isExternal?: boolean;
  ```

**File**: `packages/nexus/src/pipeline/knowledge-graph.ts`
- Updated NexusNodeInsertRow interface with `isExternal: boolean` field
- Updated node flush logic to include `isExternal: node.isExternal ?? false`

### 3. Import Processor Logic

**File**: `packages/nexus/src/pipeline/import-processor.ts`
- Modified `processExtractedImports()` to emit ExternalModule nodes when `resolveTypescriptImport()` returns null
- Deduplication by specifier (key: `module;<specifier>`) ensures one node per external package across all files
- Node ID scheme: `module:<specifier>` (e.g., `module:drizzle-orm`, `module:@cleocode/contracts`)
- Language inference from importing file extension (`.ts`/`.tsx` → `typescript`, `.js`/`.jsx` → `javascript`)
- Emits `imports` relation from source file to external module with:
  - confidence: 1.0
  - reason: "unresolved external import"
  - type: "imports"

### 4. Testing

**File**: `packages/nexus/src/__tests__/import-processor.test.ts`
- Created unit test file for T1062 external module nodes
- Test verifies node creation, deduplication, and relation emission
- Quality gates all pass: biome, tsc build, vitest (120 tests, all passing)

## Acceptance Criteria Met

- [x] Schema migration adds `is_external BOOLEAN DEFAULT 0` column (self-healing via ensureColumns)
- [x] `kind: 'module'` and `isExternal: true` set on ExternalModule nodes
- [x] `imports` relation emitted from source file to external module
- [x] Deduplication by specifier ensures one node per external package
- [x] Language inferred from importing file extension
- [x] Code placed in correct packages per Package-Boundary Check:
  - Extraction: `packages/nexus/src/pipeline/import-processor.ts`
  - Schema: `packages/core/src/store/`
- [x] Quality gates passing:
  - `pnpm biome check --write` ✓
  - `pnpm --filter @cleocode/nexus run build` ✓
  - `pnpm --filter @cleocode/contracts run build` ✓
  - `pnpm --filter @cleocode/nexus run test` (120 tests passing) ✓
- [x] No behavior regression on existing imports (calls, extends, implements, etc.)

## Expected Impact

- **390k+ unresolved imports** previously discarded are now persisted as ExternalModule nodes
- Closes **55% of the edge gap** between cleo nexus and gitnexus
- Each external module creates one node (deduplicated) and one or more imports relations
- On openclaw reindex: expected 390k+ new `imports` relations, 4k-5k new external module nodes

## Files Changed

```
packages/contracts/src/graph.ts                  +2 lines  (isExternal field)
packages/core/src/store/nexus-schema.ts          +6 lines  (column + index)
packages/core/src/store/nexus-sqlite.ts          +10 lines (self-healing migration)
packages/nexus/src/pipeline/import-processor.ts  +45 lines (ExternalModule logic)
packages/nexus/src/pipeline/knowledge-graph.ts   +1 line   (isExternal in insert row)
packages/nexus/src/__tests__/import-processor.test.ts  +30 lines (unit tests)
```

## Commit

- **SHA**: `67ae87dcd` (main branch)
- **Message**: "feat(T1062): persist unresolved imports as ExternalModule nodes + imports relation"

## Notes

- Self-healing migration pattern (T991) ensures backward compatibility with existing databases
- No new drizzle migration files needed; ALTER TABLE is idempotent
- Deduplication ensures memory efficiency even with millions of import statements
- Tests can be expanded with end-to-end pipeline testing on real codebases once the feature lands
