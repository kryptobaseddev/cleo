# T1174: Adopt Schema-Level .where() for T1126 Partial Index

**Task**: T1174 (T-MSR-W2A-09)
**Status**: DONE
**Commit**: da408cd101b888ed6ee3453e8c50fed694178b11

---

## Summary

Proves the Hybrid Path A+ (ADR-054) workflow end-to-end by converting the existing hand-rolled
partial index `idx_tasks_sentient_proposals_today` from a DDL-only migration to a schema-level
`.where()` expression in `tasks-schema.ts`.

---

## Changes

### 1. tasks-schema.ts (schema change)

Replaced the stale comment block at lines 284-289 with an actual `.where()` expression:

```ts
index('idx_tasks_sentient_proposals_today')
  .on(sql`date(${table.createdAt})`)
  .where(sql`${table.labelsJson} LIKE '%sentient-tier2%'`),
```

### 2. Migration folder: 20260422004703_t1174-adopt-partial-index-where/

- **migration.sql**: Comment-only no-op marker (see "Generator Behavior" below)
- **snapshot.json**: Full drizzle-kit anchor — includes the partial index with
  `"where": "\"tasks\".\"labels_json\" LIKE '%sentient-tier2%'"` in the DDL array

### 3. migration-smoke.test.ts (Test 5 added)

Two new regression tests:
- Fresh install: full chain leaves `idx_tasks_sentient_proposals_today` in `sqlite_master` with correct WHERE clause
- Existing install: T1174 comment marker runs as no-op without throwing on a DB that already has the T1126 index

---

## Generator Behavior (Key Finding)

When `pnpm db:new -- --db tasks --task T1174 --name adopt-partial-index-where` was run:

- drizzle-kit **correctly recognized** the `.where()` expression in the schema
- The baseline snapshot (T1165) did NOT include `idx_tasks_sentient_proposals_today`
- drizzle-kit emitted: `CREATE INDEX \`idx_tasks_sentient_proposals_today\` ON \`tasks\` (date("created_at")) WHERE "tasks"."labels_json" LIKE '%sentient-tier2%';`
- **Without `IF NOT EXISTS`** — this would fail on any DB that already has the T1126 migration applied

**Resolution**: Per task spec, the generated `migration.sql` was converted to a comment-only no-op marker. The `snapshot.json` remains as the canonical drizzle-kit anchor (reflects schema-level partial index expression).

**Idempotency mechanism**: `reconcileJournal` > `probeAndMarkApplied` detects that `idx_tasks_sentient_proposals_today` already exists in `sqlite_master` on existing DBs and marks the T1174 migration journal entry as applied without running DDL.

---

## Semantic Comparison: T1126 vs T1174

| | T1126 (hand-rolled) | T1174 (schema-generated) |
|---|---|---|
| Index name | idx_tasks_sentient_proposals_today | idx_tasks_sentient_proposals_today |
| Table | tasks | tasks |
| Column | date(`created_at`) | date("created_at") |
| WHERE | `labels_json` LIKE '%sentient-tier2%' | "tasks"."labels_json" LIKE '%sentient-tier2%' |
| IF NOT EXISTS | YES | NO (mitigated by comment-marker pattern) |
| Source | DDL-only migration | schema-level .where() |

Semantically equivalent. Quoting style differs (backtick vs double-quote) but behavior is identical.

---

## Validation Results

- `pnpm db:check`: All 5 DBs PASS
- `pnpm biome check --write .`: 0 errors, 1 pre-existing warning (broken symlink)
- `pnpm run build`: Build complete
- `vitest run src/store/__tests__/migration-smoke.test.ts`: 19 passed (all 19 tests including 2 new T5 tests)
- `node scripts/lint-migrations.mjs`: 0 ERRORs, 33 pre-existing WARN (RULE-3 snapshot chain — not introduced by T1174)

---

## Pattern for Future Partial Indexes (ADR-054 Hybrid Path A+)

1. Define the index in schema with `.where(sql\`predicate\`)`
2. Run `pnpm db:new -- --db <db> --task <TXXXX> --name <slug>`
3. If drizzle-kit emits `CREATE INDEX` without `IF NOT EXISTS` for an existing index:
   - Convert `migration.sql` to comment-only marker (no DDL)
   - Keep `snapshot.json` as the canonical anchor
   - `probeAndMarkApplied` handles idempotency on existing DBs
4. Add regression test verifying index exists with correct WHERE clause

---

**Output written**: 2026-04-22
