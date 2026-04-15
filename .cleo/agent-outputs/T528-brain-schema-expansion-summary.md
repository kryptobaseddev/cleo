# T528: Brain Graph Schema Expansion — Summary

**Status**: complete
**Date**: 2026-04-11
**Epic**: T523 (BRAIN Integrity + Cleo Memory SDK)

---

## What Was Done

### 1. `packages/core/src/store/brain-schema.ts`

**BRAIN_NODE_TYPES** expanded from 4 to 12 types:

| Old | New |
|-----|-----|
| `task`, `doc`, `file`, `concept` | `decision`, `pattern`, `learning`, `observation`, `sticky`, `task`, `session`, `epic`, `file`, `symbol`, `concept`, `summary` |

**BRAIN_EDGE_TYPES** replaced from 4 to 12 types:

| Old | New |
|-----|-----|
| `depends_on`, `relates_to`, `implements`, `documents` | `derived_from`, `produced_by`, `informed_by`, `supports`, `contradicts`, `supersedes`, `applies_to`, `documents`, `summarizes`, `part_of`, `references`, `modified_by` |

New type aliases exported:
- `export type BrainNodeType = (typeof BRAIN_NODE_TYPES)[number]`
- `export type BrainEdgeType = (typeof BRAIN_EDGE_TYPES)[number]`

**brain_page_nodes** — 5 new columns added (all additive with defaults):
- `qualityScore: real('quality_score').notNull().default(0.5)`
- `contentHash: text('content_hash')` — nullable
- `lastActivityAt: text('last_activity_at').notNull().default(sql\`(datetime('now'))\`)`
- `metadataJson: text('metadata_json')` — preserved (no change)
- `updatedAt: text('updated_at')` — nullable

4 new indexes:
- `idx_brain_nodes_quality` on `quality_score`
- `idx_brain_nodes_content_hash` on `content_hash`
- `idx_brain_nodes_last_activity` on `last_activity_at`
- `idx_brain_nodes_type` (preserved)

**brain_page_edges** — 2 new columns:
- `weight: real('weight').notNull().default(1.0)` — changed from nullable to NOT NULL
- `provenance: text('provenance')` — nullable, new

1 new index:
- `idx_brain_edges_type` on `edge_type`

### 2. `packages/core/src/store/brain-accessor.ts`

- `findPageNodes` extended with `minQualityScore` filter parameter
- `findPageNodes` now orders by `lastActivityAt` (was `createdAt`)
- `updatePageNode` method added (CRUD completeness)
- `findPageEdges` method added (filter by edgeType, provenance)
- No hardcoded old enum values existed in accessor — types are inferred from schema

### 3. Migration: `packages/core/migrations/drizzle-brain/20260411000001_t528-graph-schema-expansion/`

Additive migration SQL that:
1. `ALTER TABLE brain_page_nodes ADD COLUMN` for all 4 new node columns
2. Drops and recreates `brain_page_edges` (zero rows confirmed by R1 audit) to change `weight` from nullable to NOT NULL
3. Creates new indexes for both tables

### 4. `packages/core/src/store/__tests__/brain-accessor-pageindex.test.ts`

Updated to use new enum values per T528 cross-validation report (RC1):
- `'doc'` → `'concept'`
- `'depends_on'` → `'derived_from'`
- `'relates_to'` → `'informed_by'`

Added 2 new test cases:
- `findPageNodes filters by minQualityScore`
- `addPageEdge supports provenance field`

---

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | No violations |
| `pnpm run build` | Build complete |
| `pnpm run test` | 7016 passed / 0 failed |

---

## Acceptance Criteria Check

| Criterion | Status |
|-----------|--------|
| brain_page_nodes has all 9 columns | PASS (id, nodeType, label, qualityScore, contentHash, lastActivityAt, metadataJson, createdAt, updatedAt) |
| BRAIN_NODE_TYPES expanded to 12 types | PASS |
| brain_page_edges has all 6 columns | PASS (fromId, toId, edgeType, weight, provenance, createdAt) |
| BRAIN_EDGE_TYPES expanded to 12 types | PASS |
| brain-accessor.ts updated for new enum values | PASS |
| pnpm run build passes | PASS |
| pnpm run test passes | PASS |
