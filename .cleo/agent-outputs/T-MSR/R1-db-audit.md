# T1152 R1: Database Migration Audit (v2026.4.107)

**Date**: 2026-04-21  
**Scope**: READ-ONLY audit across all 5 DBs + reconciler edge-case inventory  
**Evidence Ground Truth**: For Path A vs Path B RCASD decision in T1150

---

## Executive Summary

- **5 DB sets** audited: tasks, brain, nexus, signaldock, telemetry
- **Critical findings**: 1 timestamp collision in drizzle-tasks (20260421000001), 1 statement-breakpoint malformation (t1118), signaldock uses non-standard folder-less structure
- **Reconciler patches**: 5 identified (T632, T920, T1135, T1137, T1141) — all still necessary; underlying causes NOT yet fixed
- **Telemetry DB**: Newly added in T624, opt-in command telemetry store, uses shared reconciliation infrastructure
- **Parallel folders**: Significant divergence — `packages/cleo/migrations/` = `packages/core/migrations/` (perfect sync); `drizzle/migrations/` severely out-of-date (scratchpad artifact)

---

## 1. Migration Folder Enumeration & Status

### drizzle-tasks

| Migration Name | Timestamp | Snapshot? | Malformation? | Notes |
|---|---|---|---|---|
| 20260318205539_initial | YYYYMMDDhhmmss | YES | — | Baseline schema |
| 20260320013731_wave0-schema-hardening | YYYYMMDDhhmmss | YES | — | Rename/drop+create pattern |
| 20260320020000_agent-dimension | YYYYMMDDhhmmss | YES | — | — |
| 20260321000000_t033-connection-health | YYYYMMDDhhmmss | YES | — | Rename/drop+create pattern |
| 20260321000002_t060-pipeline-stage-binding | YYYYMMDDhhmmss | YES | — | Rename/drop+create pattern |
| 20260324000000_assignee-column | YYYYMMDDhhmmss | YES | — | Last snapshot migration |
| 20260327000000_agent-credentials | YYYYMMDDhhmmss | NO | — | First non-snapshot migration |
| 20260416000000_t796-attachments | YYYYMMDDhhmmss | NO | — | — |
| 20260416000001_t811-ivtr-state | YYYYMMDDhhmmss | NO | — | — |
| 20260417000000_t877-pipeline-stage-invariants | YYYYMMDDhhmmss | NO | — | — |
| 20260417220000_t889-playbook-tables | YYYYMMDDhhmmss | NO | — | — |
| 20260418174314_t944-role-scope-severity | YYYYMMDDhhmmss | NO | — | — |
| **20260421000001_t1118-owner-auth-token** | **COLLISION** | NO | **YES** | Trailing `→ statement-breakpoint` in migration.sql (line: `ALTER TABLE ... ADD COLUMN owner_auth_token TEXT;--> statement-breakpoint`) |
| **20260421000001_t1126-sentient-proposal-index** | **COLLISION** | NO | — | **DUPLICATE TIMESTAMP** — same as t1118 |
| 20260421000002_t1126-sentient-proposal-index | YYYYMMDDhhmmss | NO | — | Corrected increment after collision |

**Summary**: 15 total | 6 with snapshot | 9 without | **1 timestamp collision (CRITICAL)** | **1 statement-breakpoint malformation (MINOR)** | 3 rename/drop+create patterns

**File paths**:
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-tasks/` (source of truth)
- Last snapshot folder: `packages/core/migrations/drizzle-tasks/20260324000000_assignee-column/snapshot.json`

---

### drizzle-brain

| Migration Name | Snapshot? | Malformation? | Notes |
|---|---|---|---|
| 20260318205549_initial | YES | — | Baseline schema |
| 20260321000001_t033-brain-indexes | YES | — | — |
| 20260408000001_t417-agent-field | YES | — | Last snapshot migration |
| 20260411000001_t528-graph-schema-expansion | NO | — | **T920 fix**: drop+create pattern; partial application handling required |
| 20260412000001_t531-quality-score-typed-tables | NO | — | — |
| 20260413000001_t549-tiered-typed-memory | NO | — | — |
| 20260415000001_t626-normalize-co-retrieved-edge-type | NO | — | — |
| 20260416000001_t673-retrieval-log-plasticity-columns | NO | — | — |
| 20260416000002_t673-plasticity-events-expand | NO | — | — |
| 20260416000003_t673-page-edges-plasticity-columns | NO | — | — |
| 20260416000004_t673-new-plasticity-tables | NO | — | — |
| 20260416000005_t726-dedup-tier-columns | NO | — | — |
| 20260416000006_t790-hebbian-prune | NO | — | — |
| 20260416000007_t799-observation-attachments-json | NO | — | — |

**Summary**: 14 total | 3 with snapshot | 11 without | No collisions | No breakpoint malformations

**File path**: `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/`

---

### drizzle-nexus

| Migration Name | Snapshot? | Malformation? | Notes |
|---|---|---|---|
| 20260318205558_initial | YES | — | Baseline schema |
| 20260412000001_t529-nexus-graph-tables | NO | — | First non-snapshot migration |
| 20260415000001_t622-project-registry-paths | NO | — | — |
| 20260419000001_t998-nexus-plasticity | NO | — | — |

**Summary**: 4 total | 1 with snapshot | 3 without | No collisions | No breakpoint malformations

**File path**: `/mnt/projects/cleocode/packages/core/migrations/drizzle-nexus/`

---

### drizzle-signaldock

**CRITICAL STRUCTURAL ANOMALY**: Signaldock does NOT use versioned folders.

| File Name | Type | Snapshot? | Malformation? | Notes |
|---|---|---|---|---|
| 2026-04-17-213120_T897_agent_registry_v3.sql | **Loose SQL file** | NO | — | **Non-folder structure** — different timestamp format (ISO-like) — 2548 bytes |

**Location**: `/mnt/projects/cleocode/packages/core/migrations/drizzle-signaldock/2026-04-17-213120_T897_agent_registry_v3.sql` (file, not folder)

**Issue**: Drizzle's `readMigrationFiles()` expects versioned folders with `migration.sql` inside. This loose file will **NOT be picked up by the standard reconciliation flow** (migration-manager.ts). This is a bootstrap/initialization issue for signaldock.db.

**Summary**: 1 file | Non-standard structure | High risk of being ignored by migration runner

---

### drizzle-telemetry

| Migration Name | Snapshot? | Malformation? | Notes |
|---|---|---|---|
| 20260415000001_t624-initial | YES | — | Only migration; creates telemetry_events + telemetry_schema_meta tables |

**Summary**: 1 total | 1 with snapshot | 0 without | No collisions | No breakpoint malformations

**Purpose**: Opt-in command telemetry database (T624). Stores:
- `telemetry_events`: command invocations, duration, exit code, error codes (per `schema.ts:24-55`)
- `telemetry_schema_meta`: config key-value store (per `schema.ts:63-68`)

**Writers**: `recordTelemetryEvent()` in `packages/core/src/telemetry/index.ts:155-180` — fire-and-forget, disabled by default

**Readers**: `buildDiagnosticsReport()` in `packages/core/src/telemetry/index.ts:197-306` — aggregates failure rates, slowness, rare commands

**Migration runner**: `packages/core/src/telemetry/sqlite.ts:59-84` — uses shared `migration-manager.ts` functions (reconcileJournal, migrateWithRetry, ensureColumns)

**File path**: `/mnt/projects/cleocode/packages/core/migrations/drizzle-telemetry/20260415000001_t624-initial/`

---

## 2. Reconciler Patch Inventory

All patches located in `/mnt/projects/cleocode/packages/core/src/store/migration-manager.ts` (663 lines).

### T632: Root Cause — Wholesale "Mark Applied" without DDL Probe

**Location**: migration-manager.ts:313-331 (Scenario 2B discussion); fix implemented as `probeAndMarkApplied()` (lines 126-225)

**Edge case absorbed**: When migrating to a new CLEO version, the DB's `__drizzle_migrations` journal had stale hashes from an older CLEO version that used a different checksum algorithm. The old code would DELETE all journal entries and INSERT all local migrations as "applied" WITHOUT verifying their DDL had actually been applied. This caused ALTER TABLE migrations to be marked applied but their columns never added.

**Root cause**: Drizzle v1 beta's checksum algorithm changed; older CLEO instances generated different hashes for identical migration files.

**Still necessary?** **YES** — if users have DBs with old journal entries, they need to be cleared. However, the NEW code (probeAndMarkApplied) is more robust: it actually checks if the DDL targets exist before marking applied.

**Could be removed if**: All DBs were re-bootstrapped from scratch (unlikely for production instances).

**Code evidence**: migration-manager.ts lines 313-331, especially line 327 (`DELETE FROM "__drizzle_migrations"`) and the probe loop (lines 328-330).

---

### T920: Partial Application Handling

**Location**: migration-manager.ts:335-462 (Scenario 3, Case B)

**Edge case absorbed**: Migration 20260411000001_t528-graph-schema-expansion (drizzle-brain) contains multiple ALTER TABLE statements. If the process crashes after adding brain_page_nodes.provenance but before brain_page_edges.provenance, Drizzle cannot re-run the migration (the existing column causes "duplicate column name"). The fix idempotently adds missing columns and marks applied.

**Root cause**: Migrations that bundle multiple ALTER TABLE + DROP TABLE + CREATE TABLE are not atomic at the journal level. A crash mid-execution leaves the DB partially applied.

**Still necessary?** **YES** — production DBs may have partial applications from prior crashes or interrupted migrations. Removing this would cause hard failures on `migrate()`.

**Could be removed if**: All migrations use single DDL statements per file, AND all production DBs have clean journals.

**Code evidence**: migration-manager.ts lines 429-462, especially lines 442-449 where missing columns are added.

---

### T1135: Rename-via-Drop+Create Pattern Handling

**Location**: migration-manager.ts:381-388 (Scenario 3, missing-ALTER case delegation to probeAndMarkApplied)

**Edge case absorbed**: Migrations like 20260320013731_wave0-schema-hardening use the idiom:
```sql
CREATE TABLE x_new (...)
DROP TABLE x
ALTER TABLE x_new RENAME TO x
```
These migrations have NO ALTER TABLE ADD COLUMN, so Scenario 3's main loop (which looks for alterMatches.length > 0) would skip them. They'd remain unjournaled and re-run destructively on every init. T1135 extends the check to detect RENAME TO patterns and delegate to probeAndMarkApplied.

**Root cause**: The reconciliation loop was only looking for ALTER TABLE ADD COLUMN; RENAME migrations flew under the radar.

**Still necessary?** **YES** — the 3 rename migrations in drizzle-tasks (see section 1 summary) would fail on every DB open without this.

**Could be removed if**: Rename idiom is never used again; however, it's a safe pattern for column constraints that cannot be changed via ALTER TABLE ADD COLUMN (e.g., NOT NULL without default).

**Code evidence**: migration-manager.ts lines 381-388.

---

### T1137: Scenario 4 — Backfill Missing `name` Column

**Location**: migration-manager.ts:466-504 (Scenario 4)

**Edge case absorbed**: Drizzle v1 beta changed migration detection to filter by `name` column instead of hash. Journal entries inserted by older CLEO code (pre-v1 beta upgrade) have `name = null`, making Drizzle re-run them. This scenario backfills the name from the local migration file.

**Root cause**: Drizzle v1 beta schema change; pre-beta code didn't write the `name` field.

**Still necessary?** **YES** — for 1-2 more releases while users upgrade from pre-v1-beta installs. After that, all DBs will have names backfilled.

**Could be removed if**: Minimum CLEO version is bumped to v2026.4.X where all DBs have been migrated (requires 1-2 release cycles).

**Code evidence**: migration-manager.ts lines 487-503, especially the `WHERE name IS NULL` query and the UPDATE statement.

---

### T1141: Scenario 1 — Bootstrap Baseline on Orphaned Tables

**Location**: migration-manager.ts:254-270 (Scenario 1)

**Edge case absorbed**: If tables exist (e.g., tasks, brain_decisions) but `__drizzle_migrations` journal does not, bootstrap the journal by marking the baseline migration (first in the folder) as applied. This prevents Drizzle from re-running the baseline on fresh or migrated DBs.

**Root cause**: Migrating from a system WITHOUT Drizzle (or with incomplete journal) to Drizzle-managed state requires baseline detection.

**Still necessary?** **YES** — used on every `getTelemetryDb()` call (if telemetry.db was created outside Drizzle), and on recovery from journal corruption.

**Could be removed if**: All DB creation goes through Drizzle from the start (no legacy bootstrap).

**Code evidence**: migration-manager.ts lines 255-269.

---

### T5185: SQLITE_BUSY Retry with Exponential Backoff

**Location**: migration-manager.ts:28-31 (constants), 48-52 (isSqliteBusy check), 564-571 (retry loop in migrateWithRetry)

**Edge case absorbed**: When multiple processes try to migrate the same DB simultaneously (e.g., parallel CLI invocations), SQLite throws SQLITE_BUSY. The fix retries with exponential backoff (100ms → 200ms → 400ms → 800ms → 2000ms) up to 5 times.

**Root cause**: SQLite has a global write lock; concurrent migrations race.

**Still necessary?** **YES** — CLEO supports worktree parallelism; concurrent session.ts runs on the same tasks.db are possible.

**Could be removed if**: CLEO enforces single-writer semantics (file lock on .cleo/tasks.db).

**Code evidence**: migration-manager.ts lines 28-31, 48-52, 543-573.

---

## 3. Reconciler Direct Journal Intrusions

The following code paths touch `__drizzle_migrations` directly (bypassing Drizzle):

| Function | File | Lines | Purpose | Risk |
|---|---|---|---|---|
| `reconcileJournal()` | migration-manager.ts | 248-505 | Insert/delete/update journal entries; probe DDL | Medium (controlled writes) |
| `insertJournalEntry()` | migration-manager.ts | 76-99 | INSERT OR IGNORE; backfill name column | Low (idempotent inserts) |
| `probeAndMarkApplied()` | migration-manager.ts | 126-225 | Calls insertJournalEntry; PRAGMA queries | Low (read-only introspection) |
| `migrateWithRetry()` | migration-manager.ts | 533-574 | Calls reconcileJournal on duplicate-column error | Medium (conditional reconciliation) |
| backup/restore logic | backup-pack.ts, backup-unpack.ts | — | Snapshot journal during backup/restore | Low (read-only during backup) |
| `upgradeSyncIfNeeded()` | upgrade.ts | — | Ensure `name` + `applied_at` columns exist | Medium (schema mutations) |
| `project-health.ts` | system/project-health.ts | — | Audit journal consistency for health checks | Low (read-only) |

**Risk assessment**: All intrusions are justified and necessary. The journal structure is complex enough that Drizzle alone cannot handle the reconciliation scenarios.

---

## 4. Parallel Migration Folders — Content Delta Analysis

### Folder Structure

```
packages/core/migrations/drizzle-{tasks,brain,nexus,signaldock,telemetry}  [SOURCE OF TRUTH]
packages/cleo/migrations/drizzle-{tasks,brain,nexus}                        [SYNC COPY]
drizzle/migrations/drizzle-{tasks,brain,nexus}                              [SCRATCHPAD - STALE]
```

### Migration Count Divergence

| DB | core/ | cleo/ | drizzle/ | Status |
|---|---|---|---|---|
| drizzle-tasks | 15 | 15 | 6 | **cleo/ = core/ ✓ | drizzle/ out of sync (-9)** |
| drizzle-brain | 14 | 14 | 2 | **cleo/ = core/ ✓ | drizzle/ out of sync (-12)** |
| drizzle-nexus | 4 | 4 | 1 | **cleo/ = core/ ✓ | drizzle/ out of sync (-3)** |
| drizzle-signaldock | 1 (loose file) | 0 | 0 | **Structural anomaly** |
| drizzle-telemetry | 1 | 0 | 0 | **Not in cleo/ (expected)** |

### Last Migration Timestamps

**drizzle-tasks**:
- core: `20260421000002_t1126-sentient-proposal-index`
- cleo: `20260421000002_t1126-sentient-proposal-index`
- drizzle: `20260421053413_melted_wind_dancer` (stale; not a real migration name)

**drizzle-brain**:
- core: `20260416000007_t799-observation-attachments-json`
- cleo: `20260416000007_t799-observation-attachments-json`
- drizzle: `20260419000001_t998-nexus-plasticity` (misplaced; belongs in nexus)

**drizzle-nexus**:
- core: `20260419000001_t998-nexus-plasticity`
- cleo: `20260419000001_t998-nexus-plasticity`
- drizzle: `20260420000000_test_runner` (orphaned; not a real migration)

### Interpretation

- **packages/cleo/migrations/** is a **perfect copy** of packages/core/migrations/ (synchronized, likely by build process or deployment)
- **drizzle/migrations/** is a **scratchpad folder** used during local drizzle-kit development; contains hand-edited, test, and obsolete migration names; **should NOT be the source of truth**
- **signaldock structural issue**: One loose SQL file instead of versioned folder; indicates signaldock.db may need special handling during bootstrap

---

## 5. Edge-Case Patches: Necessity Assessment

| Patch | Underlying Issue Fixed? | Still Necessary? | Removal Impact | Release Timeline |
|---|---|---|---|---|
| **T632** | Hash collision from Drizzle v0 → v1 | ❌ NO — new code uses better approach (probeAndMarkApplied) but the DELETE/re-seed still needed for legacy DBs | **HIGH** — older DBs would regress to unmarked migrations | Keep until v2026.5.0 |
| **T920** | Incomplete atomicity of multi-statement migrations | ❌ NO — cannot be fixed without changing migration structure | **CRITICAL** — partial applications would cause hard crashes on re-run | Keep indefinitely (part of recovery) |
| **T1135** | Rename idiom not detected by Scenario 3 | ✅ YES — idiom still used (wave0, t033, t060) | **HIGH** — rename migrations would re-run destructively | Keep indefinitely |
| **T1137** | Drizzle v1 beta name-based detection | ❌ NO — v1 beta schema permanent | **MEDIUM** — old DBs with null names would re-run migrations | Keep 1-2 releases; remove in v2026.6.0 |
| **T1141** | Journal bootstrap for tables without journal | ❌ NO — needed for fresh init and recovery | **MEDIUM** — telemetry.db and recovery paths would fail | Keep indefinitely |
| **T5185** | SQLITE_BUSY race on concurrent migrations | ❌ NO — still valid with worktree parallelism | **MEDIUM** — CLI would hang or crash on lock contention | Keep indefinitely |

**Recommendation**: All 6 patches are **still necessary** for production safety. T1137 can be deprecated in 2026.6.0, but others must remain indefinitely.

---

## Acceptance Checklist

- [x] For each of 5 DBs: migration folder path ✓
- [x] Latest migration name ✓
- [x] Last snapshot.json migration ✓
- [x] Count of snapshots vs migrations ✓
- [x] Any trailing-breakpoint malformations (od -c verified) ✓ **Found 1: t1118**
- [x] Any timestamp collisions ✓ **Found 1: 20260421000001 (t1118 + t1126 collision)**
- [x] Any rename-via-drop-create patterns ✓ **Found 3: wave0, t033, t060 in drizzle-tasks**
- [x] Purpose of drizzle-telemetry documented (what data, who writes/reads) ✓
- [x] Full inventory of reconciler patches (T632 T920 T1135 T1137 T1141 T5185) with edge cases ✓
- [x] Output at .cleo/agent-outputs/T-MSR/R1-db-audit.md with cited file paths + line numbers ✓
- [x] Manifest entry with key_findings ✓

---

## Critical Findings Summary

1. **TIMESTAMP COLLISION**: Two migrations with `20260421000001` timestamp in drizzle-tasks — only 1 incremented correctly to 20260421000002. Drizzle may process out-of-order; recommend timestamp review before next release.

2. **STATEMENT-BREAKPOINT MALFORMATION**: Migration `20260421000001_t1118-owner-auth-token` has trailing `→ statement-breakpoint` marker on the ALTER TABLE statement (line: `ALTER TABLE ... ADD COLUMN owner_auth_token TEXT;--> statement-breakpoint`). Drizzle should strip these; verify no execution issues.

3. **SIGNALDOCK BOOTSTRAP ISSUE**: Signaldock uses a loose SQL file instead of versioned folder. The standard `readMigrationFiles()` in migration-manager.ts will NOT pick it up. This is a high-risk initialization bug if signaldock migrations ever need to be reconciled.

4. **DRIZZLE/ FOLDER IS STALE**: The `/drizzle/migrations/` folder is 9-12 migrations behind source of truth. It's a local scratchpad and should never be committed or used as canonical. Build/deployment should NOT reference this folder.

5. **ALL RECONCILER PATCHES REMAIN NECESSARY**: 6 edge-case patches (T632, T920, T1135, T1137, T1141, T5185) are still required for production DBs. Removing any would cause hard failures on existing installations. Only T1137 can be deprecated after 1-2 release cycles.

6. **TELEMETRY SCHEMA VERSION**: Drizzle-telemetry uses v1.0.0 schema and is the most recent addition (T624, v2026.4.15). Uses shared reconciliation infrastructure successfully.

---

## Path A vs Path B Implications

- **Path A (Status Quo)**: Keep all reconciler patches; live with timestamp collisions and statement-breakpoint artifacts. Works but accumulates technical debt.
- **Path B (Remediation)**: Fix timestamp collision (t1118 + t1126), clean signaldock bootstrap, remove stale drizzle/ folder, plan migration structure simplification to eliminate T920 + T1135 patches in v2026.6.0.

**Recommendation**: Path B is safer long-term. The collision and signaldock issue are low-risk in isolation but indicate the migration system is drift-prone.
