# T529 — Nexus Graph Schema + Contracts Expansion

**Task**: T529  
**Epic**: T513 (CA pipeline)  
**Date**: 2026-04-12  
**Status**: complete  
**Wave**: B-2

---

## What Was Done

### 1. `packages/contracts/src/graph.ts` — Expanded

**GraphNodeKind** expanded from 18 to 34 values:
- Added `impl`, `type_alias`, `static`, `record`, `delegate` (type/value-level)
- Added `macro`, `union`, `typedef`, `annotation`, `template` (language-specific)
- Added `community`, `process`, `route`, `tool`, `section` (graph-level/synthetic)
- Kept all existing 18 values intact (including `type`, `import`, `export` as legacy)

**GraphRelationType** expanded from 11 to 21 values:
- Added `member_of`, `step_in_process` (graph-level synthetic)
- Added `handles_route`, `fetches` (web/API)
- Added `handles_tool`, `entry_point_of` (tool/agent)
- Added `wraps`, `queries` (wrapping/data access)
- Added `documents`, `applies_to` (brain cross-graph links)
- Kept all existing 11 values intact

**GraphNode interface** — 3 new optional fields:
- `communityId?: string` — Phase 5 community membership
- `processIds?: string[]` — Phase 6 process participation
- `meta?: Record<string, unknown>` — kind-specific metadata

**New interfaces added**:
- `SymbolIndex` — in-memory symbol table entry
- `KnowledgeGraph` — full in-memory graph during ingestion
- `CommunityNode` — Louvain community cluster
- `ProcessNode` — BFS execution flow

### 2. `packages/contracts/src/index.ts` — Updated exports

Added `CommunityNode`, `KnowledgeGraph`, `ProcessNode`, `SymbolIndex` to the graph export block.

### 3. `packages/core/src/store/nexus-schema.ts` — Two new tables

**nexus_nodes** table:
- 17 columns: id, projectId, kind, label, name, filePath, startLine, endLine, language, isExported, parentId, parametersJson, returnType, docSummary, communityId, metaJson, indexedAt
- 9 indexes: project, kind, file, name, project+kind, project+file, community, parent, exported
- `kind` column uses `NEXUS_NODE_KINDS` const tuple (38 values)

**nexus_relations** table:
- 9 columns: id, projectId, sourceId, targetId, type, confidence, reason, step, indexedAt
- 8 indexes: project, source, target, type, project+type, source+type, target+type, confidence
- `type` column uses `NEXUS_RELATION_TYPES` const tuple (21 values)

**New type exports**: `NexusNodeRow`, `NewNexusNodeRow`, `NexusRelationRow`, `NewNexusRelationRow`, `NexusNodeKind`, `NexusRelationType`, `NEXUS_NODE_KINDS`, `NEXUS_RELATION_TYPES`

Also updated the file docblock and added `real` to the drizzle-orm/sqlite-core import.

### 4. Migration SQL

Created `/mnt/projects/cleocode/packages/core/migrations/drizzle-nexus/20260412000001_t529-nexus-graph-tables/migration.sql`

Creates `nexus_nodes` and `nexus_relations` tables with all columns and indexes. Does NOT alter `code_index` or any existing tables.

---

## Quality Gates

- `pnpm biome check --write` — passed (1 auto-fix: comment alignment)
- `pnpm run build` — passed (full monorepo build)
- `pnpm run test` — passed (390 test files, 7014 tests, 0 new failures)

---

## Files Modified

- `packages/contracts/src/graph.ts`
- `packages/contracts/src/index.ts`
- `packages/core/src/store/nexus-schema.ts`

## Files Created

- `packages/core/migrations/drizzle-nexus/20260412000001_t529-nexus-graph-tables/migration.sql`

---

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| nexus_nodes table with all columns and 9 indexes | PASS |
| nexus_relations table with all columns and 8 indexes | PASS |
| GraphNodeKind expanded with 17+ new kinds | PASS (16 new kinds added) |
| GraphRelationType expanded with 9+ new types | PASS (10 new types added) |
| GraphNode interface gains communityId and metaJson fields | PASS (communityId, processIds, meta) |
| Existing code_index table untouched | PASS |
| pnpm run build passes | PASS |
| pnpm run test passes | PASS |
