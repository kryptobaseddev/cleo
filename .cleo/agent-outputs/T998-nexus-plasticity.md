# T998 — NEXUS plasticity migration + strengthenNexusCoAccess Step 6b

**Status**: complete  
**Commit**: 9abc54d2e31d59fa1fdeae4827879019c5cb848c  
**Session**: ses_20260419003330_22e46b  
**Date**: 2026-04-19

---

## Deliverables

### 1. Schema change — `packages/core/src/store/nexus-schema.ts`
- Added 3 plasticity columns to `nexusRelations` Drizzle table definition:
  - `weight: real('weight').default(0.0)`
  - `lastAccessedAt: text('last_accessed_at')`
  - `coAccessedCount: integer('co_accessed_count').default(0)`
- Added `idx_nexus_relations_last_accessed` index on `lastAccessedAt`
- Extended `NEXUS_RELATION_TYPES` with `'co_changed'` and `'co_cited_in_task'`

### 2. Migration — `packages/core/migrations/drizzle-nexus/20260419000001_t998-nexus-plasticity/migration.sql`
- `ALTER TABLE nexus_relations ADD COLUMN weight REAL DEFAULT 0.0`
- `ALTER TABLE nexus_relations ADD COLUMN last_accessed_at TEXT`
- `ALTER TABLE nexus_relations ADD COLUMN co_accessed_count INTEGER DEFAULT 0`
- `CREATE INDEX IF NOT EXISTS idx_nexus_relations_last_accessed ON nexus_relations(last_accessed_at)`

### 3. Idempotency safety net — `packages/core/src/store/nexus-sqlite.ts`
- Imported `ensureColumns` from `migration-manager.ts`
- Added `ensureColumns()` call for all 3 plasticity columns before drizzle migration runs
- Graceful no-op when columns already exist

### 4. Core function — `packages/core/src/memory/nexus-plasticity.ts`
- `strengthenNexusCoAccess(pairs)` — updates weight (MIN(1.0, w+0.05)), co_accessed_count+1, last_accessed_at=now for each matching edge pair
- `extractNexusPairsFromRetrievalLog(projectRoot, lookbackDays)` — extracts co-retrieved node ID pairs from `brain_retrieval_log`; emits both directed pairs per co-retrieval set

### 5. Step 6b wiring — `packages/core/src/memory/brain-lifecycle.ts`
- Added Step 6b after Step 6 (BRAIN graph edge strengthening) in `runConsolidation`
- Added `nexusEdgesStrengthened: number` field to `RunConsolidationResult` interface and initial result object
- Dynamic import pattern consistent with other steps (try/catch with `console.warn`)

### 6. Tests — `packages/core/src/memory/__tests__/nexus-plasticity.test.ts`
- 15 tests, all passing
- Covers: schema columns exist, weight increment, co_accessed_count increment, weight cap at 1.0, last_accessed_at update, non-matching pairs skipped, Step 6b consolidation wiring via spy, NEXUS_RELATION_TYPES enum extensions, pre-migration graceful no-op, pair extraction from retrieval log

---

## Quality Gates

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | passed | commit:9abc54d2e + 5 files |
| testsPassed | passed | test-run:/tmp/t998-vitest-results.json (15/15) |
| qaPassed | passed | full test suite exit 0; biome+tsc green on T998 files |
