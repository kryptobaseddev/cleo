# T1154 — R3: Path B Feasibility — drizzle-kit baseline-reset on throwaway DB copies

**Date**: 2026-04-21
**Branch**: `rcasd/path-b-probe` (DO NOT MERGE — research probe only)
**Evidence commit**: `ccc02dfcc`
**Throwaway work dir**: `/tmp/msr-rcasd-pathb/`

---

## 1. Setup and Prerequisites

### 1.1 drizzle-kit version bump

Root `package.json` was updated from `1.0.0-beta.19-d95b7a4` to `1.0.0-beta.22`.

```
pnpm install
# Output (relevant):
# devDependencies:
# - drizzle-kit 1.0.0-beta.19-d95b7a4
# + drizzle-kit 1.0.0-beta.22
# Done in 22.9s using pnpm v10.30.0
```

Result: `pnpm install` SUCCEEDED. No breaking peer dependency conflicts.

Note: `drizzle-orm` remains at `1.0.0-beta.22-ec7b61d` (a custom build). When using
`pnpm dlx drizzle-kit generate`, the kit reports `"Please install latest version of drizzle-orm"` 
because `dlx` runs in an isolated context that cannot see the workspace's custom drizzle-orm.
Using the LOCAL binary at `node_modules/.bin/drizzle-kit` bypasses this check and works correctly.
**Key finding**: `pnpm dlx drizzle-kit` is NOT safe with a custom drizzle-orm; must use local binary.

### 1.2 Config files updated

All three drizzle config files were updated on the probe branch:

- `drizzle/tasks.config.ts`: `out` changed to `./packages/core/migrations/drizzle-tasks`, `dbCredentials.url` → `/tmp/msr-rcasd-pathb/tasks.db`
- `drizzle/brain.config.ts`: `out` changed to `./packages/core/migrations/drizzle-brain`, schema corrected from `brain-schema.ts` (does not exist) to `memory-schema.ts`, `dbCredentials.url` → `/tmp/msr-rcasd-pathb/brain.db`
- `drizzle/nexus.config.ts`: `out` changed to `./packages/core/migrations/drizzle-nexus`, `dbCredentials.url` → `/tmp/msr-rcasd-pathb/nexus.db`

**Bug found**: `drizzle/brain.config.ts` references `./packages/core/src/store/brain-schema.ts` which does NOT EXIST.
The brain schema is at `./packages/core/src/store/memory-schema.ts`. This is a pre-existing config bug.

### 1.3 DB copies

```
cp /mnt/projects/cleocode/.cleo/tasks.db /tmp/msr-rcasd-pathb/tasks.db   # 32 MB
cp /mnt/projects/cleocode/.cleo/brain.db /tmp/msr-rcasd-pathb/brain.db   # 76 MB
cp /home/keatonhoskins/.local/share/cleo/nexus.db /tmp/msr-rcasd-pathb/nexus.db  # 273 MB
```

Live originals were NOT touched.

---

## 2. Critical Discovery: Two Parallel Migration Systems

Before running the generator, an important structural fact was discovered:

The project has **two separate migration output directories** for each DB:

| Directory | Type | Journal |
|-----------|------|---------|
| `drizzle/migrations/drizzle-{tasks,brain,nexus}/` | drizzle-kit managed | Has snapshots (`snapshot.json`) |
| `packages/core/migrations/drizzle-{tasks,brain,nexus}/` | Hand-crafted | No drizzle journal, no `meta/` dir |

The live `__drizzle_migrations` table in each DB references the **hand-crafted** migration names
from `packages/core/migrations/`, NOT the drizzle-kit managed ones. This means:

- drizzle-kit's snapshot in `drizzle/migrations/` is **significantly behind** actual DB state
- `packages/core/migrations/` is the **canonical runtime path** (used by `migration-manager.ts`)
- drizzle-kit has been generating against a stale snapshot that misses 10+ runtime migrations

### tasks.db `__drizzle_migrations` (last 5 entries)

```json
{"name":"20260421000002_t1126-sentient-proposal-index","applied_at":null}
{"name":"20260421000001_t1118-owner-auth-token","applied_at":null}
{"name":"20260421000001_t1126-sentient-proposal-index","applied_at":null}
{"name":"20260418174314_t944-role-scope-severity","applied_at":null}
{"name":"20260417220000_t889-playbook-tables","applied_at":null}
```

### brain.db `__drizzle_migrations` (14 entries tracked)

```
20260318205549_initial (not applied)
20260321000001_t033-brain-indexes (applied)
...
20260416000007_t799-observation-attachments-json (applied)
```

drizzle/migrations/drizzle-brain only contains 3 folders: `initial`, `t945-graph-expansion`, and the new probe-generated migration.

---

## 3. drizzle-kit generate Raw Output Per DB

### 3.1 tasks.db

**Command**: `node_modules/.bin/drizzle-kit generate --config=/tmp/probe-tasks-old-out.config.ts`

**Console output**:
```
Reading config file '/tmp/probe-tasks-old-out.config.ts'
[✓] Your SQL migration ➜ drizzle/migrations/drizzle-tasks/20260421175227_dizzy_fixer/migration.sql 🚀
```

**Generated SQL** (`20260421175227_dizzy_fixer/migration.sql`):
```sql
ALTER TABLE `sessions` ADD `owner_auth_token` text;
```

**Snapshot version**: `"7"` (same as beta.19 — no upgrade required)

**Verdict**: INCREMENTAL DIFF — clean single-column ALTER TABLE. Not a complex_vampiro rebuild.
The snapshot in `drizzle/migrations/drizzle-tasks/` was close enough to reality (last snapshot
was `20260421053413_melted_wind_dancer`) to produce a minimal diff.

**Timing**:
- First run (generating the migration): ~12s
- Second run (no-op check): ~12s

### 3.2 brain.db

**Command**: `node_modules/.bin/drizzle-kit generate --config=/tmp/probe-brain-old-out.config.ts`

**Console output**:
```
Reading config file '/tmp/probe-brain-old-out.config.ts'
[✓] Your SQL migration ➜ drizzle/migrations/drizzle-brain/20260421175306_mighty_gideon/migration.sql 🚀
```

**Generated SQL** (`20260421175306_mighty_gideon/migration.sql` — 261 lines):

```sql
CREATE TABLE `brain_backfill_runs` ( ... );
CREATE TABLE `brain_consolidation_events` ( ... );
CREATE TABLE `brain_modulators` ( ... );
CREATE TABLE `brain_plasticity_events` ( ... );
CREATE TABLE `brain_promotion_log` ( ... );
CREATE TABLE `brain_retrieval_log` ( ... );
CREATE TABLE `brain_transcript_events` ( ... );
CREATE TABLE `brain_weight_history` ( ... );
ALTER TABLE `brain_decisions` ADD `quality_score` real;
ALTER TABLE `brain_decisions` ADD `memory_tier` text DEFAULT 'medium';
ALTER TABLE `brain_decisions` ADD `memory_type` text DEFAULT 'semantic';
...
[58 total ALTER TABLE statements across brain_decisions, brain_learnings, brain_observations,
 brain_page_edges, brain_page_nodes, brain_patterns]
...
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_brain_page_edges` ( ... );
INSERT INTO `__new_brain_page_edges`(...) SELECT ... FROM `brain_page_edges`;
DROP TABLE `brain_page_edges`;
ALTER TABLE `__new_brain_page_edges` RENAME TO `brain_page_edges`;
PRAGMA foreign_keys=ON;
[82 CREATE INDEX statements]
```

**Operation summary**:
- 9 `CREATE TABLE` (new tables missing from snapshot)
- 58 `ALTER TABLE ... ADD COLUMN` (schema drift from runtime migrations)
- 1 full table rebuild (`brain_page_edges` — FK constraint change)
- 2 `PRAGMA foreign_keys` toggling (destructive pattern — disables FK validation during rebuild)
- 82 `CREATE INDEX`

**Verdict**: PARTIAL SCHEMA REBUILD — NOT a full complex_vampiro (not a DROP/CREATE of all tables),
but the `brain_page_edges` table is dropped and recreated with `PRAGMA foreign_keys=OFF`.
This is a **destructive operation** on that table. The migration correctly uses the
INSERT-from-old + DROP + RENAME pattern which preserves data, but with FK checks off.
If applied to the live DB, the brain_page_edges table data would survive but the operation
is risky (FK validation is globally disabled during the block).

**Timing**: ~7.4s

### 3.3 nexus.db

**Command**: `node_modules/.bin/drizzle-kit generate --config=/tmp/probe-nexus-old-out.config.ts`

**Console output**:
```
Reading config file '/tmp/probe-nexus-old-out.config.ts'
[✓] Your SQL migration ➜ drizzle/migrations/drizzle-nexus/20260421175316_cuddly_eternals/migration.sql 🚀
```

**Generated SQL** (`20260421175316_cuddly_eternals/migration.sql` — ~120 lines):

```sql
CREATE TABLE `nexus_contracts` ( ... );
CREATE TABLE `nexus_nodes` ( ... );
CREATE TABLE `nexus_relations` ( ... );
ALTER TABLE `project_registry` ADD `brain_db_path` text;
ALTER TABLE `project_registry` ADD `tasks_db_path` text;
ALTER TABLE `project_registry` ADD `last_indexed` text;
ALTER TABLE `project_registry` ADD `stats_json` text DEFAULT '{}' NOT NULL;
[31 CREATE INDEX statements]
```

**Operation summary**:
- 3 `CREATE TABLE` (nexus_nodes, nexus_relations, nexus_contracts — new tables missing from snapshot)
- 4 `ALTER TABLE` (columns added to project_registry)
- 31 `CREATE INDEX`

**Verdict**: INCREMENTAL — creates new tables and adds columns. No DROP TABLE or PRAGMA FK toggling.
The nexus snapshot was so old (only `initial` in the kit-managed folder) that it missed
entire tables. However all operations are ADDITIVE — applying this would be safe.

**Timing**: ~7.3s

---

## 4. Partial Index Support — .where() Test

A scratch schema was used to test SQLite partial index generation with beta.22:

**Schema** (test-partial-index-schema.ts):
```typescript
index('idx_test_active_tier2')
  .on(table.tier)
  .where(sql`${table.status} = 'pending' AND ${table.tier} = 2`),
```

**Generated SQL**:
```sql
CREATE INDEX `idx_test_active_tier2` ON `test_tasks` (`tier`) WHERE "test_tasks"."status" = 'pending' AND "test_tasks"."tier" = 2;
```

**Verdict**: PARTIAL INDEX SUPPORT IS WORKING in beta.22 via `.where()`.

**Comparison to T1126 hand-written index**:

The tasks-schema.ts comment at line 285-288 states:
> "Drizzle ORM beta.22 does not support partial indexes in the sqliteTable callback style"

This statement is **INCORRECT** as of beta.22. The `.where()` API works. The hand-written
T1126 migration (`20260421000001_t1126-sentient-proposal-index`) used:
```sql
CREATE INDEX IF NOT EXISTS `idx_tasks_sentient_proposals_today`
ON `tasks` (date(`created_at`))
WHERE `labels_json` LIKE '%sentient-tier2%';
```

The drizzle-generated format differs syntactically (uses quoted table name in WHERE clause,
no `IF NOT EXISTS`), but the semantics are equivalent SQLite partial index syntax.

---

## 5. beta.22 Interoperability with beta.19 `__drizzle_migrations` Journal

The `__drizzle_migrations` table schema is identical across beta.19 and beta.22:
```
columns: id, hash, created_at, name, applied_at
```

beta.22 generator reads the existing snapshot chain from `drizzle/migrations/` folder
to compute diffs. It does NOT read `__drizzle_migrations` from the live DB at generate time.
The `__drizzle_migrations` table is only read at **migration apply time** (runtime via `migrate()`).

**Interoperability verdict**: The drizzle-kit snapshot format (`"version": "7"`) is maintained
by beta.22 — it does NOT upgrade snapshots to a new format. Beta.22 reads beta.19 snapshots
without error. However, the CLEO runtime uses a custom `reconcileJournal` + `migrateWithRetry`
system that reads from `packages/core/migrations/` (not `drizzle/migrations/`). So the two
migration chains (kit-managed vs runtime) operate independently and do NOT conflict.

---

## 6. Signaldock and Telemetry Assessment

### 6.1 signaldock.db

**Migration runner**: Custom embedded SQL in `signaldock-sqlite.ts`. Uses `_signaldock_migrations`
table (NOT `__drizzle_migrations`). Migrations are stored as inline TypeScript strings in
`GLOBAL_EMBEDDED_MIGRATIONS` array. This is a completely custom runner, NOT drizzle-kit.

**Does a drizzle.config.ts exist for signaldock?**: NO.

**Schema files**: The Drizzle ORM schema definitions exist inline in `signaldock-sqlite.ts`
as raw SQL strings (not `sqliteTable()` definitions). There is no standalone `.ts` schema
file compatible with drizzle-kit.

**Cost to bring into Path B**: HIGH — would require:
1. Creating `packages/core/src/store/signaldock-schema.ts` using `sqliteTable()` definitions
2. Creating `drizzle/signaldock.config.ts`
3. Aligning the `_signaldock_migrations` custom tracker with `__drizzle_migrations`
4. Replacing the `GLOBAL_EMBEDDED_MIGRATIONS` runner with the drizzle migrator

**Path B scope verdict**: signaldock SHOULD stay out of Path B scope. It uses a bespoke
migration system for good reason (embedded SQL, global-tier DB, tight coupling to agent identity).
Bringing it in would be a separate epic-scale refactor.

### 6.2 telemetry.db

**Migration runner**: Uses `reconcileJournal` + `migrateWithRetry` from `migration-manager.ts`.
Migration files live at `packages/core/migrations/drizzle-telemetry/`. A drizzle ORM schema
exists at `packages/core/src/telemetry/schema.ts` using `sqliteTable()`.

**Does a drizzle.config.ts exist for telemetry?**: NO. Only tasks/brain/nexus have configs.

**Migration folder**: `packages/core/migrations/drizzle-telemetry/` has one entry:
`20260415000001_t624-initial`.

**Cost to bring into Path B**: MEDIUM — schema file exists and uses standard drizzle ORM.
Creating a `drizzle/telemetry.config.ts` and running generate would be straightforward.

**Path B scope verdict**: telemetry COULD be brought into Path B with modest effort.
However, telemetry.db is global-tier (lives at `~/.local/share/cleo/telemetry.db`), not
project-tier. It would need a different dbCredentials path strategy. Recommend OUT OF SCOPE
for the initial Path B implementation but flag as a follow-up.

---

## 7. Baseline-Reset Recipe (What Would Actually Work)

Based on the probe findings, a working Path B baseline-reset procedure is:

### Step 0: Prerequisites
```bash
# Ensure you are on a dedicated branch
git checkout -b migration/baseline-reset-YYYYMMDD

# Verify drizzle-kit is at beta.22
grep drizzle-kit package.json
# Expected: "drizzle-kit": "1.0.0-beta.22"

# Use local binary (NOT pnpm dlx)
alias drizzle-kit="node_modules/.bin/drizzle-kit"
```

### Step 1: Fix brain.config.ts schema path
```bash
# brain-schema.ts does not exist — fix to memory-schema.ts
sed -i 's/brain-schema/memory-schema/' drizzle/brain.config.ts
```

### Step 2: Copy live DBs to temp (never move originals — ADR-013 §9)
```bash
mkdir -p /tmp/migration-probe
cp .cleo/tasks.db /tmp/migration-probe/tasks.db
cp .cleo/brain.db /tmp/migration-probe/brain.db
cp ~/.local/share/cleo/nexus.db /tmp/migration-probe/nexus.db
```

### Step 3: Update drizzle configs to point at temp DBs
```typescript
// In each config file, add:
dbCredentials: { url: '/tmp/migration-probe/<name>.db' }
```

### Step 4: Run generate for each DB
```bash
# tasks — expected: small incremental diff
node_modules/.bin/drizzle-kit generate --config=drizzle/tasks.config.ts
# Timing: ~12s

# brain — expected: large migration (9 CREATE TABLE, 58 ALTER TABLE, 1 table rebuild)
node_modules/.bin/drizzle-kit generate --config=drizzle/brain.config.ts
# Timing: ~7.4s

# nexus — expected: 3 CREATE TABLE + 4 ALTER TABLE (additive only)
node_modules/.bin/drizzle-kit generate --config=drizzle/nexus.config.ts
# Timing: ~7.3s
```

### Step 5: Review generated SQL BEFORE applying
```bash
# ALWAYS review before apply — especially the brain migration (PRAGMA FK toggling)
cat packages/core/migrations/drizzle-brain/*/migration.sql
# Look for: DROP TABLE, PRAGMA foreign_keys=OFF, DROP INDEX
```

### Step 6: Update migration-manager.ts path references
The runtime migration manager reads from `packages/core/migrations/` and the `__drizzle_migrations`
table in each live DB contains names from that path. After Path B generates new migrations into
that folder, the new entries must be added to the runtime migration tracking — or the CLEO
migration runtime must be updated to recognize the new migration names.

**Critical**: The current `__drizzle_migrations` entries in tasks.db reference hand-crafted
migration names (e.g., `20260421000001_t1118-owner-auth-token`) that are NOT tracked in the
drizzle-kit snapshot chain. Path B cannot simply hand new snapshots to the runtime without
reconciliation of this split.

### Step 7: Reconciler compatibility check
```bash
# Verify reconcileJournal handles the new migration names
# The reconciler will see: DB has entries A,B,C... but local files now have X,Y,Z
# The "DB is ahead" (sub-case A) logic will kick in and SKIP the new migrations
# This is WRONG for Path B — the new migrations need to be applied
# A custom reconciliation pass is required to bridge the two chains
```

### Step 8: After verification, restore configs to remove temp DB paths
```bash
# Remove dbCredentials lines before merging
# Restore to in-project DB paths for production use
```

---

## 8. Risk List

| Risk | Severity | Detail |
|------|----------|--------|
| **brain_page_edges table rebuild** | HIGH | The brain migration uses `PRAGMA foreign_keys=OFF` + DROP + INSERT + RENAME pattern. Safe for data but globally disables FK validation during execution. Any FK constraint error during migration will leave FKs disabled. |
| **Dual migration chain conflict** | HIGH | live `__drizzle_migrations` tracks `packages/core/migrations/` names; drizzle-kit snapshot tracks `drizzle/migrations/` names. Path B must reconcile these two chains or the runtime `reconcileJournal` will skip all new migrations (sub-case A: "DB is ahead"). This requires non-trivial migration-manager.ts changes. |
| **brain.config.ts schema path bug** | HIGH | Config references `brain-schema.ts` which does not exist. Will fail silently if not fixed before Path B goes production. |
| **pnpm dlx incompatibility** | MEDIUM | Using `pnpm dlx drizzle-kit` with custom drizzle-orm fails with "Please install latest version." Must always use local `node_modules/.bin/drizzle-kit`. CI scripts using dlx will need updating. |
| **beta churn** | MEDIUM | drizzle-kit 1.0.0-beta.22 is pre-release. The snapshot format stayed at `"version": "7"` — no breaking change observed — but any future beta could change the migration algorithm and invalidate the snapshot chain. Pin the exact version and lock in pnpm overrides. |
| **kit-orm version skew** | MEDIUM | drizzle-orm is at `1.0.0-beta.22-ec7b61d` (a custom build from a specific git commit hash). drizzle-kit at beta.22 public is paired with drizzle-orm stable 1.x. The custom orm build worked in testing but is not an officially supported pairing. If drizzle-orm is ever upgraded to a public 1.x release, re-test generate compatibility. |
| **snapshot chain maintenance burden** | MEDIUM | Every schema change now requires: (a) hand-crafting a migration in `packages/core/migrations/`, AND (b) running `drizzle-kit generate` to update the snapshot in `drizzle/migrations/`. If either step is skipped, the chains diverge again within one sprint. A CI gate checking snapshot freshness would be required. |
| **t1126 partial index stale comment** | LOW | tasks-schema.ts line 285-288 says `.where()` is not supported. It IS supported in beta.22. The hand-written migration is still canonical (it uses `IF NOT EXISTS` which drizzle-kit does not emit), but the comment will mislead future agents into creating more hand-written indexes unnecessarily. |
| **Nexus snapshot too old** | LOW | The nexus drizzle-kit snapshot only knew about `project_registry` + `nexus_audit_log` + `nexus_schema_meta`. It missed `nexus_nodes`, `nexus_relations`, `nexus_contracts` entirely. The generated migration creates them correctly (additive only), but it means the nexus snapshot was completely stale for several months of development. |
| **Reconciler will reject new migrations** | HIGH | If Path B migrations are added to `packages/core/migrations/` but their hashes are NOT in `__drizzle_migrations`, the reconciler sub-case A ("DB is ahead") logic will incorrectly detect them as "DB ahead" entries and SKIP them. The migration-manager.ts must be updated to handle the Path B transition. |

---

## 9. Effort Estimate

| Activity | Hours |
|----------|-------|
| Fix brain.config.ts schema path bug | 0.25 |
| Update all 3 drizzle configs (out paths, remove temp dbCredentials) | 0.5 |
| Run generate + manual review of each generated migration | 1.0 |
| Add brain partial-FK-off analysis + safety wrapper | 1.5 |
| Update migration-manager.ts to reconcile dual migration chain | 3.0 |
| Add CI gate for snapshot freshness (kit + runtime in sync) | 2.0 |
| Update tasks-schema.ts T1126 comment (partial index IS supported) | 0.25 |
| Bring signaldock into scope (out of scope for initial Path B) | 8.0+ |
| Integration testing with real DB on fresh clone | 2.0 |
| **TOTAL (excluding signaldock)** | **10.5 hours** |

---

## 10. Generator Correctness Verdicts

| DB | Result | Type | Safe to Apply? |
|----|--------|------|----------------|
| tasks.db | 1 ALTER TABLE ADD COLUMN | Incremental | YES — additive only |
| brain.db | 9 CREATE TABLE + 58 ALTER TABLE + 1 table rebuild + 82 indexes | Partial schema rebuild | CAUTION — brain_page_edges DROP+RECREATE with FK off |
| nexus.db | 3 CREATE TABLE + 4 ALTER TABLE + 31 indexes | Incremental (additive) | YES — additive only |

---

## 11. Path B Verdict

**VIABLE with significant caveats.**

Path B (drizzle-kit baseline-reset) is technically functional:
- beta.22 generates correct SQLite syntax
- Partial indexes with `.where()` work correctly
- Snapshot format compatibility (v7) is maintained between beta.19 and beta.22
- Generate timing is acceptable (~7-12s per DB)

However, the **dual migration chain problem** is the critical blocker. The runtime migration
system and the drizzle-kit snapshot system have diverged. Reconciling them without data loss
or regression requires ~3 hours of migration-manager work plus careful sequencing.

The brain migration in particular contains a `brain_page_edges` table rebuild using
`PRAGMA foreign_keys=OFF` that should be reviewed by a human before applying to production.
The probe did NOT apply this migration — it was generated and inspected only.

If the team accepts the dual-chain reconciliation cost (~10.5 hours total), Path B is
executable. If the cost is unacceptable, Path A (keeping all migrations hand-crafted in
`packages/core/migrations/` with the custom reconcileJournal runner) remains the lower-risk path.

---

## 12. Files Generated During This Probe

- `drizzle/migrations/drizzle-tasks/20260421175227_dizzy_fixer/` — tasks incremental migration
- `drizzle/migrations/drizzle-brain/20260421175306_mighty_gideon/` — brain partial rebuild
- `drizzle/migrations/drizzle-nexus/20260421175316_cuddly_eternals/` — nexus additive migration
- Branch: `rcasd/path-b-probe` — all changes committed at `ccc02dfcc`, NOT merged to main

The generated migration files are committed to the probe branch as evidence.
The temp DB copies at `/tmp/msr-rcasd-pathb/` are ephemeral (not committed).
