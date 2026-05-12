# Migration Runner SSoT Research (2026-04-25)

## TL;DR (Current State → Target → Gap)

1. **Current state**: 6 SQLite databases use 3 different migration patterns:
   - 4 DBs (tasks.db, brain.db, nexus.db, telemetry.db) use unified `migration-manager.ts` (763 LOC)
   - 1 DB (signaldock.db) PREVIOUSLY used bespoke `GLOBAL_EMBEDDED_MIGRATIONS` array but NOW uses `migration-manager.ts` (T1166 complete)
   - 1 DB (conduit.db) uses RAW `CREATE TABLE IF NOT EXISTS` strings inlined in `conduit-sqlite.ts` (NO drizzle, NO migration-manager.ts coverage)

2. **Target state**: All 6 DBs unified under `migration-manager.ts` with drizzle-kit + reconcileJournal pattern

3. **Gap**: conduit.db is the ONLY remaining outlier (no drizzle, no migrations folder, no journal). Unification requires:
   - Extract 17 table DDL definitions into new `conduit-schema.ts` (Drizzle table objects)
   - Generate baseline migration from current schema snapshot
   - Wire into `migration-manager.ts` with reconcileJournal + migrateWithRetry
   - Estimated LOC: 250-350 (schema defs + migration wiring)

---

## Evidence

### 1. Runner Inventory

| DB | Open fn | Init fn | Schema Type | Runner | Bespoke LOC | File |
|----|---------|---------|-------------|--------|------------|------|
| **tasks.db** | `getDbPath()` | `initDb()` | Drizzle | `migration-manager.ts` | 0 | sqlite.ts:1-515 |
| **brain.db** | `getBrainDbPath()` | `initBrainDb()` | Drizzle | `migration-manager.ts` | 0 | memory-sqlite.ts:1-671 |
| **nexus.db** | `getNexusDbPath()` | `initNexusDb()` | Drizzle | `migration-manager.ts` | 0 | nexus-sqlite.ts:1-365 |
| **telemetry.db** | `getTelemetryDbPath()` | `initTelemetryDb()` | Drizzle | `migration-manager.ts` | 0 | telemetry/sqlite.ts:1-138 |
| **signaldock.db** | `getGlobalSignaldockDbPath()` | `ensureGlobalSignaldockDb()` | Drizzle | `migration-manager.ts` (T1166) | 0 | signaldock-sqlite.ts:1-412 |
| **conduit.db** | `getConduitDbPath()` | `ensureConduitDb()` | Raw SQL DDL | Inline strings (NO runner) | 347 | conduit-sqlite.ts:76-347 |

**Key observations**:
- All 4 "standard" DBs follow identical pattern: `reconcileJournal()` → `migrateWithRetry()` from `migration-manager.ts`
- signaldock.db was successfully migrated from `GLOBAL_EMBEDDED_MIGRATIONS` array to drizzle runner (T1166, T1150 Wave 2A-04)
- conduit.db is MANUALLY initialized with `applyConduitSchema(db)` inline; no migrations folder; no journal

---

### 2. The 6 Production Patches in migration-manager.ts

All patches are **generic** (drizzle-version-agnostic) and address SQLite semantics, not framework specifics.

| Patch | File:lines | Edge Case Handled | Retire-able? | Notes |
|-------|-----------|------------------|--------------|-------|
| **T632** | 119 (comment), 313-326 | Wholesale journal reset causing orphaned hashes → columns never added. Root cause: journal DELETE + bulk INSERT as applied WITHOUT probing DDL | No | Core logic for reconcileJournal Scenario 2 Sub-case B. Enables DDL probing via `probeAndMarkApplied()` (lines 126-225). Defends against forward-compatibility (DB ahead of install) |
| **T920** | 340-506 | PARTIAL migration application: some ALTER columns exist, others missing. Migration cannot re-run (duplicate-column crash) | No | Scenario 3 sub-case: idempotently adds missing columns via ALTER TABLE, then marks migration applied. Prevents duplicate-column retry loop |
| **T1135** | 377-430 | Table-rebuild/rename migrations (no ADD COLUMN). Previously skipped Scenario 3, causing re-run on every init (T033 table-rebuild migration case) | No | Delegates to `probeAndMarkApplied()` to probe CREATE TABLE + RENAME TO patterns. T1158 confirms T033 requires this (tasks table rebuild) |
| **T1137** | (no direct line) | Implicit: Drizzle v1 beta compatibility for journal entry `name` column | No | Scenario 4 (lines 510-548) backfills `name` for null journal entries. Drizzle v1 filters by name (not hash); without it, migrations re-run and crash on duplicate-column |
| **T1141** | (no direct line) | Implicit: Comment-only baseline marker detection (T1165) | No | Lines 395-415: baseline migrations with only SQL comments are marked applied on existing DBs. Core to Hybrid Path A+ snapshot chain |
| **T5185** | 28-31, 46-52, 719-727 | SQLITE_BUSY (database locked) during migration. Exponential backoff retry with jitter | No | Generic SQLite concurrency defense. Retry constants defined lines 28-31; `isSqliteBusy()` check lines 46-52; retry loop lines 719-727 (5 retries, 100-2000ms backoff) |

**Retirement assessment**: None of these patches are safe to remove. All address structural database semantics or forward-compatibility. Removing any would reintroduce the original failure modes (T632 band-aids, T920 duplicate-column loops, T5185 concurrency crashes).

---

### 3. Conduit.db Unification Path

**Current state** (lines 76-347 of conduit-sqlite.ts): 17 tables + 11 indexes + 6 triggers defined as raw SQL strings. No drizzle schema, no migrations folder, no journal.

**Concrete files to create/modify**:

1. **Create: `packages/core/src/store/conduit-schema.ts`** (~180 LOC)
   - Extract 17 CREATE TABLE statements from CONDUIT_SCHEMA_SQL
   - Convert to Drizzle table() definitions
   - Tables: conversations, messages, delivery_jobs, dead_letters, message_pins, attachments, attachment_versions, attachment_approvals, attachment_contributors, project_agent_refs, topics, topic_subscriptions, topic_messages, topic_message_acks, _conduit_meta, _conduit_migrations, messages_fts (virtual)
   - Indexes: 11 CREATE INDEX statements
   - Triggers: 6 AFTER INSERT/DELETE/UPDATE triggers on messages_fts

2. **Create: `packages/core/migrations/drizzle-conduit/` folder**
   - `20260425000000_initial_conduit.sql` (~120 LOC)
   - Comment-only baseline marker (T1165 pattern) to mark applied on existing DBs
   - Subsequent migrations (if any) follow standard drizzle folder structure

3. **Modify: `packages/core/src/store/conduit-sqlite.ts`**
   - Import conduit schema from new `conduit-schema.ts`
   - Replace inline `CONDUIT_SCHEMA_SQL` constant with conditional logic:
     - If DB is new: apply schema via drizzle migrations
     - If DB is existing: reconcileJournal detects schema present → marks baseline applied
   - Replace direct `db.exec(CONDUIT_SCHEMA_SQL)` calls (lines 380-381) with `migrateSanitized()` call
   - Add `reconcileJournal()` call before migrations (Scenario 1: detect existing tables, bootstrap journal)

4. **Modify: `packages/core/src/store/migration-manager.ts`** (~10 LOC)
   - Add `'conduit'` case to any DB-specific routing (if needed)
   - No functional changes required; already supports generic DB names

5. **Update: `packages/core/src/store/__tests__/conduit-sqlite.test.ts`**
   - Verify reconcileJournal detection of existing tables
   - Verify baseline migration is marked applied on existing DBs
   - Verify new DBs use standard drizzle flow

**LOC estimate**: 
- conduit-schema.ts: 180 (table defs + indexes)
- 20260425000000_initial_conduit.sql: 120 (comment-only baseline marker per T1165)
- conduit-sqlite.ts modifications: 30 (replace inline DDL with migration calls)
- Test updates: 50
- **Total: ~380 LOC**

---

### 4. Signaldock.db Unification Status (COMPLETED)

**Historical state** (prior to T1166): Used bespoke `GLOBAL_EMBEDDED_MIGRATIONS` array with manual SQL statements.

**Current state** (T1166/T1150 Wave 2A-04 COMPLETE):
- Now uses standard drizzle runner (signaldock-sqlite.ts:159-175)
- Migration folder: `packages/core/migrations/drizzle-signaldock/` (1 migration + baseline reset)
- Uses reconcileJournal (Scenario 1: detect agents table, bootstrap journal)
- Uses migrateSanitized
- **No further work required — already unified under migration-manager.ts**

**Why it was incompatible before**:
- Bare-SQL array could not track journal state → always re-ran DDL on every init
- No compatibility layer for existing DBs with schema already present
- T1166 replaced bare-SQL runner with drizzle + reconcileJournal to detect existing agents table

---

### 5. CLI Surface

**Current state**: No unified `cleo db migrate` or `cleo db migrate-all` command.

**Found commands**:
```bash
$ grep -r "migrate" /mnt/projects/cleocode/packages/cleo/src/cli --include="*.ts" | grep -i "command"
  subCommands['migrate'] = migrateClaudeMemCommand;  # migrate-claude-mem.ts only
```

**Gap analysis**:
- `cleo migrate` exists but is ONLY for brain.db (Claude memory migration, not drizzle)
- No command covers all 6 DBs uniformly
- Users manually call `initDb()`, `initBrainDb()`, etc. from various entry points
- No admin/operator-facing "migrate all DBs" command for deployment/version upgrades

**Recommended**: Future ADR should define `cleo db migrate` or `cleo doctor` subcommand that:
- Runs reconcileJournal + migrateWithRetry for all 6 DBs in sequence
- Reports schema versions and table counts per DB
- Guards against concurrent migration (already done via init() singletons)

---

### 6. Test Coverage

**Migration-specific test files** (16 files):
```
packages/core/src/store/__tests__/:
  - migration-baseline.test.ts       (T1165 baseline marker)
  - migration-integration.test.ts    (drizzle runner + reconciliation)
  - migration-reconcile.test.ts      (Scenario 1-4 journal reconciliation)
  - migration-retry.test.ts          (SQLITE_BUSY retry, T5185)
  - migration-safety.test.ts         (safety backup idempotency)
  - migration-smoke.test.ts          (basic drizzle runner)
  - migration-sqlite.test.ts         (migration-manager.ts exports)
  - migration-v3-columns.test.ts     (T920 partial application)
  - idempotent-migration.test.ts     (probe-and-mark-applied)
  - sanitize-migration-statements.test.ts (whitespace-only + comment-only filtering)
  - resolve-migrations-folder.test.ts (ESM module resolution)

packages/core/src/memory/__tests__/:
  - brain-migration.test.ts          (brain.db specific init)
  - t920-migration-guard.test.ts     (T920 partial column detection)

packages/core/src/migration/__tests__/:
  - migration.test.ts                (orchestration)
  - migration-failure.integration.test.ts (failure recovery)
```

**DB coverage**:
- ✅ tasks.db: sqlite.test.ts, migration-sqlite.test.ts
- ✅ brain.db: memory-sqlite.ts uses `ensureColumns()` (T632 band-aid safety net), brain-migration.test.ts
- ✅ nexus.db: (uses standard migration-manager pattern, covered by migration-integration.test.ts)
- ✅ signaldock.db: (T1166 verified via signaldock-sqlite.test.ts)
- ✅ telemetry.db: (uses standard pattern, minimal testing — only health check tested)
- ❌ conduit.db: **NO drizzle-specific tests** (uses raw DDL only, no migration tests)

**Gaps**:
1. conduit.db has NO migration tests (conduit-sqlite.test.ts only tests CRUD accessors, not schema migration)
2. No cross-DB integration test (all 6 DBs initialized + migrated in sequence)
3. No CLI test for hypothetical `cleo db migrate-all` command

---

## Recommended Unification Scope

### Phase 1: Conduit.db Unification (Critical)
**Scope**: Extract conduit.db to drizzle + migration-manager.ts
- [ ] Create `conduit-schema.ts` (Drizzle table defs)
- [ ] Create `drizzle-conduit/` migrations folder + baseline marker
- [ ] Wire `conduit-sqlite.ts` to use `reconcileJournal()` + `migrateSanitized()`
- [ ] Add test coverage for reconciliation + baseline detection
- **LOC**: ~380 total
- **Risk**: Low (no schema changes, only runner refactoring)
- **Effort**: 2-3 days (1 dev, 1 review)

### Phase 2: Telemetry.db Hardening (Optional)
**Scope**: Extend telemetry.db test coverage (already on migration-manager.ts)
- [ ] Add integration test: telemetry.db + all other DBs in sequence
- [ ] Verify `ensureColumns()` safety net (T632) still protects telemetry
- **LOC**: ~50
- **Risk**: Minimal
- **Effort**: 1 day

### Phase 3: CLI Unification (Future)
**Scope**: Add `cleo db migrate` or `cleo doctor db` command
- [ ] Enumerate all 6 DBs
- [ ] Call `reconcileJournal()` + `migrateWithRetry()` on each
- [ ] Report schema versions + table counts
- **LOC**: ~100
- **Risk**: None (CLI only, no data changes)
- **Effort**: 1 day

---

## Total Unification Effort

**Immediate (Phase 1 - Critical)**:
- Conduit.db unification: ~380 LOC
- ADR: ADR-XXX "Single Migration Manager — Conduit.db Drizzle Integration"
- Effort: 2-3 days

**Medium term (Phase 2-3)**:
- Telemetry integration test: ~50 LOC, 1 day
- CLI command: ~100 LOC, 1 day
- Total: ~150 LOC, 2 days

**Grand total**: ~530 LOC, 4-5 days (1 dev + 1 review cycle)

---

## Rationale

**Why unify the runner (not consolidate DBs)**:
- Council unanimous verdict (ADR-054): Keep 6 DBs separate; unify the RUNNER only
- First Principles: "unify the migration runner across N DBs, not the DBs themselves"
- Benefit: Single SSoT for migration semantics (reconcileJournal, retry, safety backup)
- No data duplication, no schema conflicts, no cross-DB FK enforcement

**Why conduit.db is the blocker**:
- Only DB NOT on migration-manager.ts
- No journal tracking → cannot detect partial applies (T920 scenario)
- No forward-compatibility story (T632 for existing DBs)
- Raw DDL strings make schema changes error-prone

**Why not defer conduit.db**:
- Risk: conduit.db migrations will be impossible to coordinate if it falls further behind
- Pain: each future schema change requires direct SQL string edits (high error surface)
- Integration: once unified, CLI migrate command becomes trivial

---

## Success Criteria

After unification:
- [ ] All 6 DBs use `reconcileJournal()` + `migrateWithRetry()` 
- [ ] All 6 DBs have drizzle migration folders under `packages/core/migrations/drizzle-*/`
- [ ] All 6 DBs track schema version + journal via `__drizzle_migrations` table
- [ ] All 6 DBs support partial application recovery (T920) + forward-compatibility (T632)
- [ ] CLI `cleo db migrate` command runs all 6 in sequence
- [ ] Integration test covers all 6 DBs in one flow

