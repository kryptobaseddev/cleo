# ADR-027: Manifest SQLite Migration

**Status**: Accepted
**Date**: 2026-03-06
**Task**: T5577
**Epic**: T5576
**Related ADRs**: ADR-006, ADR-021, ADR-026

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

Two JSONL files in the repository currently act as append-only ledgers outside of `tasks.db`:

1. **`MANIFEST.jsonl`** (per-project, at `.cleo/agent-outputs/MANIFEST.jsonl`) — written by subagents to record research artifacts, implementation outputs, and agent deliverables. 14 CRUD functions live in `src/core/memory/pipeline-manifest-compat.ts`.

2. **`releases.json`** (at `.cleo/releases.json`) — managed by `src/core/release/release-manifest.ts` (10 functions). Stores per-release metadata including version, status, commitSha, gitTag, npmDistTag.

ADR-006 established SQLite (`tasks.db`) as the single source of truth for all structured CLEO data. Both JSONL files violate this mandate: they are file-based, non-transactional, and require bespoke CRUD implementations outside the store layer.

`pipeline-manifest-compat.ts` is named `compat` because it was introduced as a compatibility shim during the ADR-021 memory domain refactor, with a pending migration to SQLite noted at that time.

---

## 2. Decision

### 2.1 MANIFEST.jsonl Retirement

**`MANIFEST.jsonl` is retired.** All pipeline manifest data MUST be stored in a new `pipeline_manifest` table in `tasks.db`.

**`pipeline-manifest-compat.ts` MUST be deleted** and replaced by `pipeline-manifest-sqlite.ts`. All 14 manifest operations MUST be reimplemented as Drizzle ORM queries. The function signatures and `EngineResult` return types MUST be preserved so that callers in `src/dispatch/engines/` require no changes beyond swapping the import.

### 2.2 releases.json Retirement

**`releases.json` is retired.** All release manifest data MUST be stored in a new `release_manifests` table in `tasks.db`.

`src/core/release/release-manifest.ts` MUST be updated to use Drizzle queries against `release_manifests` instead of reading/writing `.cleo/releases.json`.

### 2.3 Schema: pipeline_manifest Table

```sql
CREATE TABLE pipeline_manifest (
  id            text PRIMARY KEY NOT NULL,
  session_id    text,
  task_id       text,
  epic_id       text,
  type          text NOT NULL,
  content       text NOT NULL,
  content_hash  text,
  status        text NOT NULL DEFAULT 'active',
  distilled     integer NOT NULL DEFAULT 0,
  brain_obs_id  text,
  source_file   text,
  metadata_json text,
  created_at    text NOT NULL DEFAULT (datetime('now')),
  archived_at   text
);
```

Indexes (5 total):

```sql
CREATE INDEX idx_pm_task_id       ON pipeline_manifest(task_id);
CREATE INDEX idx_pm_session_id    ON pipeline_manifest(session_id);
CREATE INDEX idx_pm_distilled     ON pipeline_manifest(distilled);
CREATE INDEX idx_pm_status        ON pipeline_manifest(status);
CREATE INDEX idx_pm_content_hash  ON pipeline_manifest(content_hash);
```

The `distilled` column and `brain_obs_id` column are reserved for Phase 3 (T5152) brain.db distillation. They MUST be present in the schema from creation but MUST NOT be populated by Phase 2 logic.

### 2.4 Schema: release_manifests Table

```sql
CREATE TABLE release_manifests (
  id             text PRIMARY KEY NOT NULL,
  version        text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  pipeline_id    text,
  commit_sha     text,
  git_tag        text,
  npm_dist_tag   text,
  published_at   text,
  changelog_text text,
  metadata_json  text,
  created_at     text NOT NULL DEFAULT (datetime('now')),
  updated_at     text
);
```

Indexes (2 total):

```sql
CREATE INDEX idx_rm_version    ON release_manifests(version);
CREATE INDEX idx_rm_status     ON release_manifests(status);
```

### 2.5 One-Time Migration

A one-time migration function MUST be provided:

- **`migrateManifestJsonl()`** — reads each line of `.cleo/agent-outputs/MANIFEST.jsonl`, parses the JSON, and inserts a row into `pipeline_manifest`. Duplicate `id` values (by primary key conflict) MUST be skipped with `OR IGNORE`. After successful migration, MANIFEST.jsonl is renamed to `MANIFEST.jsonl.migrated` (not deleted) for one release cycle.

- **`migrateReleasesJson()`** — reads `.cleo/releases.json`, iterates the releases array, and inserts each entry into `release_manifests` using the same conflict-skip strategy. After migration, `releases.json` is renamed `releases.json.migrated`.

Both functions MUST be idempotent: calling them on an already-migrated dataset MUST succeed without duplicating data.

### 2.6 Drizzle Migration

Both tables MUST be added via `drizzle-kit generate` following the workflow established in CLAUDE.md. The migration SQL and snapshot MUST be committed together. The migration MUST be additive — no existing tables are modified.

### 2.7 Distillation to brain.db (Deferred)

Distillation of pipeline manifest entries to brain.db observations is **deferred to Phase 3 (T5152)**. The `distilled` and `brain_obs_id` columns in `pipeline_manifest` are schema placeholders only. No distillation logic is implemented in this ADR's scope.

---

## 3. Consequences

### Positive

- ADR-006 SQLite SSoT mandate satisfied for all structured CLEO data
- Transactional writes: no more partial JSONL appends on crash
- Unified query surface: manifest data queryable with the same Drizzle patterns as tasks/sessions
- `content_hash` index enables fast deduplication without full-table scans
- `distilled`/`brain_obs_id` schema placeholders enable Phase 3 without a schema migration

### Negative

- `pipeline-manifest-compat.ts` deletion is a breaking change at the import level; callers in `src/dispatch/engines/` MUST update their imports
- One-time migration adds startup-path complexity; MUST be guarded with a migration version check

### Neutral

- MANIFEST.jsonl and releases.json retained as `.migrated` files for one release cycle
- `EngineResult` return types preserved across old and new implementations

---

## 4. Migration Path

1. Add `pipeline_manifest` and `release_manifests` tables via `drizzle-kit generate`
2. Write `pipeline-manifest-sqlite.ts` with all 14 manifest operations
3. Update `release-manifest.ts` to use `release_manifests` table
4. Write `migrateManifestJsonl()` and `migrateReleasesJson()` one-time migration functions
5. Wire migration functions into the store initialization path, guarded by a migration version flag
6. Delete `pipeline-manifest-compat.ts`
7. Update imports in `src/dispatch/engines/` and `src/dispatch/domains/`
8. Run `npm test` to confirm all manifest operations pass
9. Rename source JSONL files to `.migrated` after successful migration in CI

---

## 5. References

- ADR-006: SQLite as Single Source of Truth
- ADR-021: Memory Domain Refactor (introduced pipeline-manifest-compat.ts as temporary shim)
- ADR-026: Release System Consolidation (release_manifests provenance columns)
- T5149: BRAIN Database & Cognitive Infrastructure (Phase 3: distillation deferred here)
- T5152: SQLite-vec & PageIndex (distillation target phase)
- T5576: LOOM Release Pipeline Remediation (epic)
- T5577: Release System Consolidation documentation task
- `docs/specs/CLEO-MANIFEST-SCHEMA-SPEC.md`
- `src/core/memory/pipeline-manifest-compat.ts` (to be deleted)
- `src/core/release/release-manifest.ts` (to be updated)

---

**END OF ADR-027**
