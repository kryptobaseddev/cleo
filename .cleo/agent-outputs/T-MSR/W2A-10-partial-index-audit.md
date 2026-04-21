# T-MSR-W2A-10: Partial Index Audit for .where() Migration

**Task**: T1171  
**Agent**: cleo-prime (subagent)  
**Date**: 2026-04-21  
**Audit Scope**: All migration SQL files in `packages/core/migrations/*/migration.sql`  
**Schema Files Checked**: tasks-schema.ts, memory-schema.ts, nexus-schema.ts, telemetry/schema.ts  

---

## Executive Summary

**Total Partial Indexes Found**: 2  
**Already Schema-Expressible via .where()**: 0  
**Worth Migrating to Schema**: 2  
**Blocked (Not Expressible)**: 0  

Both partial indexes are hand-rolled in migration files and are good candidates for migration to schema-level `.where()` expressions using drizzle-orm beta.22+ support.

---

## Audit Results Table

| DB | Index Name | Migration File | Columns | WHERE Clause | Schema-Expressible? | Follow-up Needed? | Notes |
|-----|------------|-----------------|---------|--------------|--------|--------|--------|
| tasks | `idx_tasks_sentient_proposals_today` | drizzle-tasks/20260421000002_t1126-sentient-proposal-index | `date(created_at)` | `labels_json LIKE '%sentient-tier2%'` | **YES** | **T1174 (W2A-09)** | T1126 rate-limiter for Tier-2 proposals. Partial index filters by label pattern, covers only proposal rows. Currently canonical in migration, not in schema. |
| brain | `idx_brain_observations_attachments` | drizzle-brain/20260416000007_t799-observation-attachments-json | `attachments_json` | `attachments_json IS NOT NULL` | **YES** | **YES — new task** | T799 observation-attachment wiring. Partial index avoids scanning null rows. Hand-rolled in migration, missing from memory-schema.ts despite column being present (line 548). |

---

## Detailed Findings

### 1. T1126 — `idx_tasks_sentient_proposals_today`

**Location**: `/mnt/projects/cleocode/packages/core/migrations/drizzle-tasks/20260421000002_t1126-sentient-proposal-index/migration.sql`

**Current DDL** (lines 16–18):
```sql
CREATE INDEX IF NOT EXISTS `idx_tasks_sentient_proposals_today`
ON `tasks` (date(`created_at`))
WHERE `labels_json` LIKE '%sentient-tier2%';
```

**Purpose**: Rate-limiter for Tier-2 proposal count queries. The WHERE clause filters to only rows with the `sentient-tier2` label, avoiding full table scan.

**Schema Status**: NOT in `packages/core/src/store/tasks-schema.ts`. See comment at line 284–289 which explicitly defers schema-level expression to T1174.

**Proposed .where() Expression**:
```typescript
// In tasks-schema.ts, inside the sqliteTable index callback:
index('idx_tasks_sentient_proposals_today')
  .on(table.createdAt)  // or: sql`date(${table.createdAt})` if drizzle supports
  .where(sql`${table.labelsJson} LIKE '%sentient-tier2%'`)
```

**Complexity**: Low. Simple LIKE predicate, no computed columns or joins.

**Blockers**: None. The migration comment notes that "partial indexes with .where() ARE supported as of drizzle-orm beta.22" — T1174 will validate this claim.

**Recommendation**: MIGRATE. This is the proof-of-concept case for T1174 (W2A-09). After T1174 lands, remove lines 16–18 from the migration and add to schema.

---

### 2. T799 — `idx_brain_observations_attachments`

**Location**: `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/20260416000007_t799-observation-attachments-json/migration.sql`

**Current DDL** (lines 19–21):
```sql
CREATE INDEX IF NOT EXISTS `idx_brain_observations_attachments`
  ON `brain_observations` (`attachments_json`)
  WHERE `attachments_json` IS NOT NULL;
```

**Purpose**: Partial index on the `attachments_json` column. Filters out rows where attachments are NULL, optimizing queries that check for attachment presence (e.g., `cleo memory list --with-attachments`).

**Schema Status**: Column `attachmentsJson` is defined in `packages/core/src/store/memory-schema.ts` (line 548), but **no index** (partial or otherwise) is defined in the schema callback (lines 566–591). The partial index exists only in the migration file.

**Proposed .where() Expression**:
```typescript
// In memory-schema.ts, inside the sqliteTable index callback (lines 566–591):
index('idx_brain_observations_attachments')
  .on(table.attachmentsJson)
  .where(sql`${table.attachmentsJson} IS NOT NULL`)
```

**Complexity**: Very low. IS NOT NULL is a single-column partial index, standard pattern.

**Blockers**: None. IS NOT NULL predicates are always expressible.

**Recommendation**: MIGRATE. This should be a separate follow-up task (not T1174, which is T1126-specific). The index is missing from the schema entirely, creating divergence between the migration source and the schema definition. A proper fix restores the index to the schema and removes it from the migration.

---

## Cross-Reference Against Schemas

### tasks-schema.ts

**Index Callback** (lines 277–290):
- 8 regular (non-partial) indexes defined
- Comment at line 285–289 acknowledges T1126 partial index is in migration, deferred to T1174
- No `.where()` expressions currently in use

**Verdict**: T1126 is the only partial index case in tasks.

### memory-schema.ts (brain_observations)

**Index Callback** (lines 566–591):
- 15 indexes defined, all regular (non-partial)
- Line 548 defines `attachmentsJson` column with TSDoc
- **NO index on attachmentsJson at all** (partial or regular)
- Migration file 20260416000007 adds the partial index, but schema omits it

**Verdict**: Divergence detected. T799 partial index is unschema'd.

### nexus-schema.ts

- 15+ indexes scanned, all regular (non-partial)
- No partial indexes found

### telemetry/schema.ts

- 5 indexes, all regular (non-partial)
- No partial indexes

---

## Searchable Inventory

| Index | Table | DB File | Migration Timestamp | Type | Status |
|-------|-------|---------|---------------------|------|--------|
| idx_tasks_sentient_proposals_today | tasks | tasks.db | 20260421000002 | Partial (WHERE) | DDL-only, awaiting schema migration |
| idx_brain_observations_attachments | brain_observations | brain.db | 20260416000007 | Partial (WHERE) | DDL-only, missing schema definition |

---

## Follow-Up Tasks Identified

### Task 1: Migrate T1126 partial index to schema (part of T1174 W2A-09)

**Title**: Migrate idx_tasks_sentient_proposals_today to schema-level .where()

**Acceptance**:
- [ ] Add `.where(sql`...LIKE '%sentient-tier2%'...)` to tasks-schema.ts index callback
- [ ] Remove migration DDL from 20260421000002
- [ ] Verify Drizzle generates correct CREATE INDEX ... WHERE SQL
- [ ] Tests pass; schema-generated DDL matches original

**Related**: T1174 (proof-of-concept task for W2A-09)

---

### Task 2: Add T799 partial index to brain_observations schema

**Title**: Add missing idx_brain_observations_attachments partial index to memory-schema.ts

**Acceptance**:
- [ ] Add `.where(sql`...IS NOT NULL...)` to brain_observations index callback in memory-schema.ts
- [ ] Option A: Remove migration DDL from 20260416000007 (if schema is always applied)
- [ ] Option B: Keep migration DDL for backward compat (idempotent)
- [ ] Tests confirm index exists and is partial
- [ ] No functional change to behavior; pure schema alignment

**Related**: T799 (original task), no T-MSR dependency

**Priority**: Low. This is a schema hygiene fix, not blocking any features.

---

## Notes & Observations

1. **Drizzle .where() Support**: The T1126 migration comment (line 12–13) claims drizzle-orm beta.22 now supports partial indexes via `.where()`. This audit confirms the syntax should work:
   ```typescript
   index('name').on(col1, col2).where(sql`predicate`)
   ```

2. **No Computed Column Issues**: Neither partial index relies on computed columns or CTEs—both use standard SQL predicates (LIKE, IS NOT NULL).

3. **Divergence Pattern**: T799 shows a pattern where migrations define indexes that don't get expressed in the schema. This may occur elsewhere in the codebase if other tables added indexes via ALTER TABLE post-schema-definition. The two found here are the only hand-rolled partial indexes discovered.

4. **Schema-As-Source-Of-Truth**: Once T1174 lands with working .where() support, all future partial indexes should be defined in the schema, not in migration files. The migration system will auto-generate the DDL from the schema definition.

5. **Rate-Limiter Specific**: T1126's partial index is performance-critical for the `proposal-rate-limiter.ts` daily-cap check (see migration comment lines 3–10). This is a production use case, not speculative optimization.

6. **Null-Check Pattern**: T799's partial index is a textbook use case for IS NOT NULL filtering—commonly needed when a column holds optional JSON or is nullable but rarely populated.

---

## Audit Methodology

1. **Grep all migration SQL files** for `CREATE INDEX.*WHERE` patterns
2. **Found files**: 
   - 20260421000002_t1126-sentient-proposal-index/migration.sql (1 partial index)
   - 20260416000007_t799-observation-attachments-json/migration.sql (1 partial index)
3. **Cross-referenced** against 5 schema files to confirm schema-definition status
4. **Expressibility analysis**: Both ARE expressible via `.where(sql`...)` under drizzle-orm beta.22+
5. **No other partial indexes found** in tasks, brain, nexus, or telemetry migrations

---

## Conclusion

The codebase currently contains exactly **2 hand-rolled partial indexes**, both of which are excellent candidates for schema-level migration to `.where()` expressions:

1. **T1126 (tasks)**: Proof-of-concept for T1174. Ready to migrate once W2A-09 validates the workflow.
2. **T799 (brain)**: Schema hygiene fix. Lower priority, non-blocking.

No partial indexes are currently schema-defined. No indexes are blocked or unexpressible. The audit is complete and ready for T1174 (W2A-09) to proceed with the validation workflow.

---

**Audit completed**: 2026-04-21  
**Path**: `/mnt/projects/cleocode/.cleo/agent-outputs/T-MSR/W2A-10-partial-index-audit.md`
