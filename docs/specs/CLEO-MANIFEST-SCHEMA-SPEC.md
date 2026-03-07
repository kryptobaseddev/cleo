# CLEO Manifest Schema Specification

**Version**: 2026.3.6
**Status**: APPROVED
**Date**: 2026-03-06
**Task**: T5577
**Epic**: T5576
**Authors**: CLEO Agent Team

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Overview

This specification defines the schema for the `pipeline_manifest` table in `tasks.db`, the migration protocol from `MANIFEST.jsonl`, and the distillation lifecycle for pipeline manifest entries.

The `pipeline_manifest` table is the authoritative store for all agent output artifacts, research deliverables, and implementation records written during CLEO sessions. It supersedes `MANIFEST.jsonl` per ADR-027.

---

## 2. Terminology

| Term | Definition |
|------|------------|
| **pipeline_manifest** | SQLite table in `tasks.db` storing agent artifact metadata |
| **MANIFEST.jsonl** | Legacy append-only JSONL file being retired by this spec |
| **entry** | One row in `pipeline_manifest` |
| **distillation** | Process of summarizing an active entry into brain.db as an observation |
| **active** | Entry status: in use, not yet archived or distilled |
| **distilled** | Entry status: content has been summarized to brain.db |
| **archived** | Entry status: retained for history, excluded from active queries |
| **brain_obs_id** | ID of the brain.db observation created during distillation |
| **content_hash** | SHA-256 hex digest of the `content` field, used for deduplication |

---

## 3. Table Schema

### 3.1 pipeline_manifest

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

### 3.2 Column Definitions

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | text | NOT NULL | Primary key. Format: `{TASK_ID}-{slug}` (e.g., `T5577-release-adr`). MUST be globally unique across all projects sharing a `tasks.db`. |
| `session_id` | text | NULL | CLEO session ID that created this entry. NULL for entries created outside a session. |
| `task_id` | text | NULL | CLEO task ID this entry is associated with (e.g., `T5577`). |
| `epic_id` | text | NULL | CLEO epic ID this entry is associated with (e.g., `T5576`). |
| `type` | text | NOT NULL | Entry type. See §3.3 for valid values. |
| `content` | text | NOT NULL | Full entry content as a string. MUST be UTF-8. No length limit enforced at DB level. |
| `content_hash` | text | NULL | SHA-256 hex digest of `content`. SHOULD be populated on insert for deduplication. |
| `status` | text | NOT NULL | Lifecycle status. See §4 for valid values. Default: `active`. |
| `distilled` | integer | NOT NULL | Boolean flag (0 or 1). 1 = content has been distilled to brain.db. Default: 0. |
| `brain_obs_id` | text | NULL | ID of the brain.db observation created during distillation. NULL until distilled. |
| `source_file` | text | NULL | Relative path of the source file (e.g., `claudedocs/agent-outputs/T5577-adr.md`). |
| `metadata_json` | text | NULL | JSON object with additional key/value metadata. No fixed schema. |
| `created_at` | text | NOT NULL | ISO-8601 UTC timestamp. Default: `datetime('now')`. |
| `archived_at` | text | NULL | ISO-8601 UTC timestamp set when status transitions to `archived`. |

### 3.3 Type Values

| Type | Description |
|------|-------------|
| `research` | Research output from a Research subagent |
| `implementation` | Implementation artifact from a code-writing subagent |
| `specification` | Formal spec or design document |
| `design` | Architecture or design artifact |
| `analysis` | Analysis or audit output |
| `decision` | Decision record or ADR content |
| `note` | General session note or observation |

The `type` column MUST contain one of the values above. New types MAY be added via a future ADR without a table migration (CHECK constraint is not enforced at DB level to allow forward compatibility).

---

## 4. Distillation Lifecycle

Entries progress through the following status values:

```
active ──► archived
  │
  └──► distilled ──► archived
```

| Status | `distilled` | `brain_obs_id` | `archived_at` | Description |
|--------|-------------|----------------|---------------|-------------|
| `active` | 0 | NULL | NULL | Normal operating state |
| `distilled` | 1 | set | NULL | Content summarized to brain.db |
| `archived` | 0 or 1 | NULL or set | set | Retained for history only |

**Transition rules**:

1. `active` → `archived`: Set `archived_at = datetime('now')`, `status = 'archived'`. MUST NOT clear `content`.
2. `active` → `distilled`: Set `distilled = 1`, `brain_obs_id = {id}`, `status = 'distilled'`. Content MUST be preserved.
3. `distilled` → `archived`: Set `archived_at = datetime('now')`, `status = 'archived'`. `distilled` and `brain_obs_id` MUST remain set.

**Phase 3 note**: Distillation logic (transitions to `distilled` status) is deferred to Phase 3 (T5152). In Phase 2, all entries remain `active` or move directly to `archived`. The `distilled` and `brain_obs_id` columns MUST be present in the schema but MUST NOT be written by Phase 2 code.

---

## 5. Indexes

Five indexes MUST exist on `pipeline_manifest`:

```sql
CREATE INDEX idx_pm_task_id      ON pipeline_manifest(task_id);
CREATE INDEX idx_pm_session_id   ON pipeline_manifest(session_id);
CREATE INDEX idx_pm_distilled    ON pipeline_manifest(distilled);
CREATE INDEX idx_pm_status       ON pipeline_manifest(status);
CREATE INDEX idx_pm_content_hash ON pipeline_manifest(content_hash);
```

**Rationale**:
- `task_id`: Most manifest queries filter by task — this is the most frequent access pattern
- `session_id`: Session-scoped queries (e.g., "what did this session produce?")
- `distilled`: Phase 3 distillation worker queries all undistilled entries in bulk
- `status`: Active-entry queries exclude archived entries
- `content_hash`: Deduplication checks on insert

---

## 6. Migration from MANIFEST.jsonl

### 6.1 Migration Function Contract

A one-time migration function `migrateManifestJsonl(db, jsonlPath)` MUST be provided:

**Inputs**:
- `db`: Drizzle database instance (tasks.db)
- `jsonlPath`: absolute path to `MANIFEST.jsonl`

**Algorithm**:
1. Check if `jsonlPath` exists; if absent, return `{ migrated: 0, skipped: 0 }` (no-op)
2. Read file line by line, skipping blank lines and lines that fail JSON parse
3. For each valid JSON object, map legacy fields to `pipeline_manifest` columns:

| MANIFEST.jsonl field | pipeline_manifest column | Notes |
|----------------------|-------------------------|-------|
| `id` | `id` | Direct mapping |
| `file` | `source_file` | Direct mapping |
| `title` | stored in `metadata_json.title` | |
| `date` | `created_at` | Convert to ISO-8601 if not already |
| `status` | `status` | Map `complete` → `active`, `partial` → `active`, `blocked` → `archived` |
| `agent_type` | `type` | Direct mapping |
| `topics` | stored in `metadata_json.topics` | JSON array |
| `key_findings` | stored in `metadata_json.key_findings` | JSON array |
| `actionable` | stored in `metadata_json.actionable` | |
| `needs_followup` | stored in `metadata_json.needs_followup` | |
| `linked_tasks` | `task_id` (first element), remaining in `metadata_json.linked_tasks` | |
| *(all fields)* | `content` | Full JSON object serialized as string |

4. Insert each row using `INSERT OR IGNORE` (conflict on `id` → skip)
5. Return `{ migrated: N, skipped: M }`

**Idempotency**: The function MUST be safe to call multiple times. Duplicate `id` values are silently skipped.

### 6.2 Post-Migration File Handling

After a successful migration call:
1. Rename `MANIFEST.jsonl` to `MANIFEST.jsonl.migrated`
2. Do NOT delete the original file; retain for one release cycle as a rollback reference
3. Do NOT write new entries to `MANIFEST.jsonl.migrated`

The `.migrated` file MAY be deleted after the first stable release that ships with `pipeline_manifest` support.

### 6.3 Migration Guard

The migration function MUST be called during store initialization, guarded by a migration version flag. The guard pattern (pseudocode):

```typescript
const MANIFEST_MIGRATION_VERSION = 1;
const current = await getMigrationFlag('manifest_jsonl_migration');
if (current < MANIFEST_MIGRATION_VERSION) {
  await migrateManifestJsonl(db, manifestPath);
  await setMigrationFlag('manifest_jsonl_migration', MANIFEST_MIGRATION_VERSION);
}
```

---

## 7. Operation Contract

The `pipeline-manifest-sqlite.ts` module MUST implement the following 14 operations. All functions MUST return `EngineResult<T>` matching the signatures in the deleted `pipeline-manifest-compat.ts`.

### 7.1 Query Operations (7)

| Operation | Function | Description | Required Params |
|-----------|----------|-------------|-----------------|
| `manifest.show` | `manifestShow(id)` | Get single entry by ID | `id` |
| `manifest.list` | `manifestList(filters?)` | List entries with optional filters | — |
| `manifest.find` | `manifestFind(query)` | FTS search across id, content, metadata | `query` |
| `manifest.pending` | `manifestPending()` | Get active entries with `actionable=true` in metadata | — |
| `manifest.stats` | `manifestStats()` | Aggregate counts by type, status, distilled | — |
| `manifest.by-task` | `manifestByTask(taskId)` | All entries for a given task ID | `taskId` |
| `manifest.by-session` | `manifestBySession(sessionId)` | All entries for a given session ID | `sessionId` |

### 7.2 Mutate Operations (7)

| Operation | Function | Description | Required Params |
|-----------|----------|-------------|-----------------|
| `manifest.append` | `manifestAppend(entry)` | Insert new entry | `entry` object |
| `manifest.archive` | `manifestArchive(id)` | Set status = archived, archived_at = now | `id` |
| `manifest.archive-before` | `manifestArchiveBefore(date)` | Archive all active entries created before date | `date` |
| `manifest.update` | `manifestUpdate(id, fields)` | Update mutable fields | `id`, `fields` |
| `manifest.distill` | `manifestDistill(id, brainObsId)` | Set distilled=1, brain_obs_id (Phase 3) | `id`, `brainObsId` |
| `manifest.delete` | `manifestDelete(id)` | Hard delete (admin use only) | `id` |
| `manifest.migrate` | `manifestMigrate(jsonlPath)` | Run one-time JSONL migration | `jsonlPath` |

**Note**: `manifest.distill` MUST be implemented in the module but MUST return `E_NOT_IMPLEMENTED` until Phase 3 (T5152) activates it.

---

## 8. Content Hash Computation

When inserting a new entry, `content_hash` MUST be computed as:

```
SHA-256(content as UTF-8 string) → lowercase hex string
```

The hash is used for deduplication in `manifest.append`: if an entry with the same `content_hash` already exists with status `active`, the insert MUST return the existing entry ID rather than creating a duplicate. Entries with `archived` status MAY be re-inserted (a new row is created).

---

## 9. Metadata JSON Structure

The `metadata_json` column stores a JSON object with no fixed schema. The following keys are RECOMMENDED for compatibility with the legacy JSONL format:

```json
{
  "title": "Human-readable title",
  "topics": ["topic1", "topic2"],
  "key_findings": ["Finding one.", "Finding two."],
  "actionable": true,
  "needs_followup": ["T5580", "T5581"],
  "linked_tasks": ["T5576", "T5577"]
}
```

The `metadata_json` field MUST be valid JSON when non-NULL. A NULL value is permitted and means no additional metadata.

---

## 10. References

- ADR-006: SQLite as Single Source of Truth
- ADR-021: Memory Domain Refactor (introduced pipeline-manifest-compat.ts)
- ADR-027: Manifest SQLite Migration (normative decision backing this spec)
- ADR-028: CHANGELOG Generation Model
- `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md`
- `src/core/memory/pipeline-manifest-compat.ts` (to be deleted; this spec defines its replacement)
- `src/store/schema.ts` (Drizzle schema source of truth)
- T5149: BRAIN Database & Cognitive Infrastructure (Phase 3: distillation)
- T5152: SQLite-vec & PageIndex (distillation target)
- T5576: LOOM Release Pipeline Remediation (epic)
- T5577: Release System Consolidation documentation task
