# T030 — Soft FK Audit and Remediation Plan

**Epic:** T029 (Schema Architecture Review)
**Date:** 2026-03-21
**Status:** Complete
**Scope:** tasks.db and brain.db (cross-DB references included)

---

## Executive Summary

A full audit of both SQLite databases identified **18 distinct soft foreign key relationships** — columns that reference rows in another table (or another database entirely) but carry no `FOREIGN KEY` constraint at the DB level. Of these:

- **2 are intentional by design** and should remain soft FKs (audit log survival, cross-DB isolation)
- **7 are cross-database** (brain.db → tasks.db/sessions) and cannot be enforced with native SQLite FKs; they require application-level guards or a migration to co-locate
- **9 are intra-database** and are candidates for hardening with `FOREIGN KEY` constraints

One existing orphan class was found: `audit_log.task_id = 'system'` (30 rows), which is a sentinel value used by the dispatch layer and is intentional.

`PRAGMA foreign_keys` is currently **OFF** (value `0`) on both databases, meaning even the hard FKs declared in the schema are not enforced at runtime. This is a compounding risk.

---

## Database Inventory

| Database | File | Tables Audited |
|----------|------|---------------|
| tasks.db | `.cleo/tasks.db` | tasks, sessions, audit_log, token_usage, pipeline_manifest, adr_task_links, lifecycle_transitions, architecture_decisions, release_manifests, warp_chain_instances, agent_instances, agent_error_log, task_work_history |
| brain.db | `.cleo/brain.db` | brain_decisions, brain_memory_links, brain_observations, brain_page_nodes, brain_page_edges |

---

## Part 1: Intra-Database Soft FKs (tasks.db)

These columns reference other tables within tasks.db but lack `FOREIGN KEY` constraints in the DDL.

### SFK-001: `adr_task_links.task_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `adr_task_links.task_id TEXT NOT NULL` |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | No |
| Existing rows | 0 |
| Orphans found | 0 |
| Comment in schema | "soft FK — tasks can be purged" |
| Recommended ON DELETE | `SET NULL` — not possible since column is NOT NULL; use `CASCADE` |
| Rationale | An ADR-to-task link with no task has no meaning. If the task is deleted, remove the link row. |

**Recommended behavior:** `ON DELETE CASCADE`

---

### SFK-002: `pipeline_manifest.task_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `pipeline_manifest.task_id TEXT` (nullable) |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

Rationale: pipeline manifest entries are provenance records. A task being deleted should not erase the manifest entry — it becomes context-free but remains part of the audit trail.

---

### SFK-003: `pipeline_manifest.session_id` → `sessions.id`

| Field | Value |
|-------|-------|
| Source | `pipeline_manifest.session_id TEXT` (nullable) |
| Target | `sessions.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

Rationale: same as SFK-002 — provenance should survive session deletion.

---

### SFK-004: `pipeline_manifest.epic_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `pipeline_manifest.epic_id TEXT` (nullable) |
| Target | `tasks.id TEXT PRIMARY KEY` (where `type = 'epic'`) |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

Note: No DB-level check enforces that `epic_id` references only rows with `type = 'epic'`. This is application-enforced. A CHECK constraint cannot enforce cross-row conditions in SQLite.

---

### SFK-005: `pipeline_manifest.brain_obs_id` → `brain_observations.id` (cross-DB)

| Field | Value |
|-------|-------|
| Source | `pipeline_manifest.brain_obs_id TEXT` (nullable) |
| Target | `brain_observations.id` in brain.db |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 (empty table) |
| Cross-DB | YES — cannot enforce with SQLite FK |

**Recommended behavior:** Application-level guard on insert/delete. See Part 2 for cross-DB strategy.

---

### SFK-006: `release_manifests.epic_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `release_manifests.epic_id TEXT` (nullable) |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 1 (one release manifest exists) |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

Rationale: A release manifest is a historical record. Deleting the epic task should not cascade-delete the release record.

---

### SFK-007: `warp_chain_instances.epic_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `warp_chain_instances.epic_id TEXT NOT NULL` |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | No |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE CASCADE`

Rationale: A warp chain instance bound to an epic that no longer exists is inert and can be safely removed.

---

### SFK-008: `lifecycle_transitions.from_stage_id` → `lifecycle_stages.id`

| Field | Value |
|-------|-------|
| Source | `lifecycle_transitions.from_stage_id TEXT NOT NULL` |
| Target | `lifecycle_stages.id TEXT PRIMARY KEY` |
| Nullable | No |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE CASCADE`

Rationale: A transition record with a non-existent source stage is meaningless for auditing.

---

### SFK-009: `lifecycle_transitions.to_stage_id` → `lifecycle_stages.id`

| Field | Value |
|-------|-------|
| Source | `lifecycle_transitions.to_stage_id TEXT NOT NULL` |
| Target | `lifecycle_stages.id TEXT PRIMARY KEY` |
| Nullable | No |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE CASCADE`

---

### SFK-010: `architecture_decisions.supersedes_id` → `architecture_decisions.id` (self-ref)

| Field | Value |
|-------|-------|
| Source | `architecture_decisions.supersedes_id TEXT` (nullable) |
| Target | `architecture_decisions.id TEXT PRIMARY KEY` (self-referential) |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |
| Note | Schema comment: "Self-referential FKs enforced at the DB level by the migration; omitted here to avoid Drizzle circular-ref syntax" |

This FK is documented in the schema as intentionally omitted from the Drizzle definition but present in the migration DDL. Verify the migration file to confirm it exists in the actual database. The `sqlite_master` DDL output does not show this FK — it is **absent from the live DB**.

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-011: `architecture_decisions.superseded_by_id` → `architecture_decisions.id` (self-ref)

Same situation as SFK-010.

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-012: `architecture_decisions.amends_id` → `architecture_decisions.id` (self-ref)

| Field | Value |
|-------|-------|
| Source | `architecture_decisions.amends_id TEXT` (nullable) |
| Target | `architecture_decisions.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-013: `architecture_decisions.consensus_manifest_id` → `manifest_entries.id`

| Field | Value |
|-------|-------|
| Source | `architecture_decisions.consensus_manifest_id TEXT` (nullable) |
| Target | `manifest_entries.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-014: `agent_instances.session_id` → `sessions.id`

| Field | Value |
|-------|-------|
| Source | `agent_instances.session_id TEXT` (nullable) |
| Target | `sessions.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

Rationale: Retaining the agent instance record is useful for post-mortem analysis even after session cleanup.

---

### SFK-015: `agent_instances.task_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `agent_instances.task_id TEXT` (nullable) |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-016: `agent_instances.parent_agent_id` → `agent_instances.id` (self-ref)

| Field | Value |
|-------|-------|
| Source | `agent_instances.parent_agent_id TEXT` (nullable) |
| Target | `agent_instances.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-017: `agent_error_log.agent_id` → `agent_instances.id`

| Field | Value |
|-------|-------|
| Source | `agent_error_log.agent_id TEXT NOT NULL` |
| Target | `agent_instances.id TEXT PRIMARY KEY` |
| Nullable | No |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE CASCADE`

Rationale: Error log entries for a deleted agent instance have no useful context. Cascade is safe.

---

### SFK-018: `tasks.session_id` → `sessions.id`

| Field | Value |
|-------|-------|
| Source | `tasks.session_id TEXT` (nullable) |
| Target | `sessions.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-019 (intentional): `audit_log.task_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `audit_log.task_id TEXT NOT NULL` |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | No |
| Existing rows | 319 |
| Orphans found | 30 (all with `task_id = 'system'` — sentinel value) |
| Schema comment | "No FK on taskId — log entries must survive task deletion." |

This is **intentionally a soft FK**. The audit log is an append-only record; log entries must survive task deletion. The `'system'` sentinel is used by the dispatch layer for non-task-scoped operations.

**Decision:** Keep as soft FK. Document the `'system'` sentinel as a known non-referential value. Do not add a FK constraint.

---

### SFK-020: `token_usage.session_id` → `sessions.id`

| Field | Value |
|-------|-------|
| Source | `token_usage.session_id TEXT` (nullable) |
| Target | `sessions.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 76 of 222 rows have a session_id |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

Rationale: Token usage records are telemetry. Deleting a session should not erase cost history.

---

### SFK-021: `token_usage.task_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `token_usage.task_id TEXT` (nullable) |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 of 222 rows have a task_id |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

---

### SFK-022: `task_work_history.task_id` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `task_work_history.task_id TEXT NOT NULL` |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | No |
| Existing rows | 0 |
| Orphans found | 0 |
| Note | `session_id` already has a hard FK with CASCADE. `task_id` does not. |

**Recommended behavior:** `ON DELETE CASCADE`

Rationale: Work history is only meaningful in the context of both the session (already enforced) and the task. If the task is deleted, the work history entry has no context.

---

### SFK-023: `sessions.current_task` → `tasks.id`

| Field | Value |
|-------|-------|
| Source | `sessions.current_task TEXT` (nullable) |
| Target | `tasks.id TEXT PRIMARY KEY` |
| Nullable | Yes |
| Existing rows | 0 |
| Orphans found | 0 |

**Recommended behavior:** `ON DELETE SET NULL`

---

## Part 2: Cross-Database Soft FKs (brain.db → tasks.db)

SQLite does not support `FOREIGN KEY` constraints across database connections. These references must be enforced at the application layer. They are documented here for completeness and to guide application-level guard implementation.

### XFKB-001: `brain_decisions.context_epic_id` → `tasks.id` (tasks.db)

| Field | Value |
|-------|-------|
| Source | `brain_decisions.context_epic_id TEXT` (nullable) |
| Target | `tasks.id` in tasks.db |
| Populated rows | 0 of 1 |
| Orphan check | N/A (requires application join) |

**Recommended behavior:** Application-level existence check on write. On task deletion, emit an event that nullifies `context_epic_id` via a cleanup hook.

---

### XFKB-002: `brain_decisions.context_task_id` → `tasks.id` (tasks.db)

| Field | Value |
|-------|-------|
| Source | `brain_decisions.context_task_id TEXT` (nullable) |
| Target | `tasks.id` in tasks.db |
| Populated rows | 0 of 1 |

**Recommended behavior:** Same as XFKB-001.

---

### XFKB-003: `brain_memory_links.task_id` → `tasks.id` (tasks.db)

| Field | Value |
|-------|-------|
| Source | `brain_memory_links.task_id TEXT NOT NULL` |
| Target | `tasks.id` in tasks.db |
| Populated rows | 0 |

**Recommended behavior:** Application-level existence check on write. On task deletion, cascade-delete corresponding `brain_memory_links` rows via cleanup hook.

---

### XFKB-004: `brain_observations.source_session_id` → `sessions.id` (tasks.db)

| Field | Value |
|-------|-------|
| Source | `brain_observations.source_session_id TEXT` (nullable) |
| Target | `sessions.id` in tasks.db |
| Populated rows | 0 of 9 |

**Recommended behavior:** Application-level guard on write. On session deletion, `SET NULL` via cleanup hook.

---

### XFKB-005: `brain_page_nodes.id` (task-type) → `tasks.id` (tasks.db)

| Field | Value |
|-------|-------|
| Source | `brain_page_nodes.id TEXT PRIMARY KEY` (where `node_type = 'task'`, format `'task:T5241'`) |
| Target | `tasks.id` in tasks.db |
| Populated rows | 1 (node `task:T5241`) |
| Cross-DB | YES |

The page graph uses a composite-key convention (`<type>:<id>`) to embed task references in node IDs. This is not a foreign key column per se but is a cross-DB soft reference.

**Recommended behavior:** Application-level consistency check. On task deletion, cascade-delete `brain_page_nodes` rows with `id = 'task:<task_id>'` and associated `brain_page_edges` via cleanup hook.

---

## Part 3: Orphan Check Query Reference

All queries below are safe to run on the live database without modification.

### tasks.db Orphan Queries

```sql
-- SFK-001: adr_task_links.task_id
SELECT 'adr_task_links.task_id', task_id
FROM adr_task_links
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = adr_task_links.task_id);

-- SFK-002: pipeline_manifest.task_id
SELECT 'pipeline_manifest.task_id', task_id
FROM pipeline_manifest
WHERE task_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = pipeline_manifest.task_id);

-- SFK-003: pipeline_manifest.session_id
SELECT 'pipeline_manifest.session_id', session_id
FROM pipeline_manifest
WHERE session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = pipeline_manifest.session_id);

-- SFK-004: pipeline_manifest.epic_id
SELECT 'pipeline_manifest.epic_id', epic_id
FROM pipeline_manifest
WHERE epic_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = pipeline_manifest.epic_id);

-- SFK-006: release_manifests.epic_id
SELECT 'release_manifests.epic_id', epic_id
FROM release_manifests
WHERE epic_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = release_manifests.epic_id);

-- SFK-007: warp_chain_instances.epic_id
SELECT 'warp_chain_instances.epic_id', epic_id
FROM warp_chain_instances
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = warp_chain_instances.epic_id);

-- SFK-008/009: lifecycle_transitions stage references
SELECT 'lifecycle_transitions.from_stage_id', from_stage_id
FROM lifecycle_transitions
WHERE NOT EXISTS (SELECT 1 FROM lifecycle_stages WHERE lifecycle_stages.id = lifecycle_transitions.from_stage_id);

SELECT 'lifecycle_transitions.to_stage_id', to_stage_id
FROM lifecycle_transitions
WHERE NOT EXISTS (SELECT 1 FROM lifecycle_stages WHERE lifecycle_stages.id = lifecycle_transitions.to_stage_id);

-- SFK-010/011/012: architecture_decisions self-refs
SELECT 'arch_decisions.supersedes_id', supersedes_id
FROM architecture_decisions
WHERE supersedes_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM architecture_decisions ad2 WHERE ad2.id = architecture_decisions.supersedes_id);

SELECT 'arch_decisions.superseded_by_id', superseded_by_id
FROM architecture_decisions
WHERE superseded_by_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM architecture_decisions ad2 WHERE ad2.id = architecture_decisions.superseded_by_id);

SELECT 'arch_decisions.amends_id', amends_id
FROM architecture_decisions
WHERE amends_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM architecture_decisions ad2 WHERE ad2.id = architecture_decisions.amends_id);

-- SFK-013: architecture_decisions.consensus_manifest_id
SELECT 'arch_decisions.consensus_manifest_id', consensus_manifest_id
FROM architecture_decisions
WHERE consensus_manifest_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM manifest_entries WHERE manifest_entries.id = architecture_decisions.consensus_manifest_id);

-- SFK-014: agent_instances.session_id
SELECT 'agent_instances.session_id', session_id
FROM agent_instances
WHERE session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = agent_instances.session_id);

-- SFK-015: agent_instances.task_id
SELECT 'agent_instances.task_id', task_id
FROM agent_instances
WHERE task_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = agent_instances.task_id);

-- SFK-016: agent_instances.parent_agent_id
SELECT 'agent_instances.parent_agent_id', parent_agent_id
FROM agent_instances
WHERE parent_agent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM agent_instances ai2 WHERE ai2.id = agent_instances.parent_agent_id);

-- SFK-017: agent_error_log.agent_id
SELECT 'agent_error_log.agent_id', agent_id
FROM agent_error_log
WHERE NOT EXISTS (SELECT 1 FROM agent_instances WHERE agent_instances.id = agent_error_log.agent_id);

-- SFK-018: tasks.session_id
SELECT 'tasks.session_id', session_id
FROM tasks
WHERE session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = tasks.session_id);

-- SFK-019 (intentional): audit_log.task_id — exclude known sentinel
SELECT 'audit_log.task_id (unexpected orphans)', task_id
FROM audit_log
WHERE task_id != 'system'
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = audit_log.task_id);

-- SFK-020: token_usage.session_id
SELECT 'token_usage.session_id', session_id
FROM token_usage
WHERE session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = token_usage.session_id);

-- SFK-021: token_usage.task_id
SELECT 'token_usage.task_id', task_id
FROM token_usage
WHERE task_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = token_usage.task_id);

-- SFK-022: task_work_history.task_id
SELECT 'task_work_history.task_id', task_id
FROM task_work_history
WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_work_history.task_id);

-- SFK-023: sessions.current_task
SELECT 'sessions.current_task', current_task
FROM sessions
WHERE current_task IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = sessions.current_task);
```

---

## Part 4: Remediation Plan

### Phase 1: Enable FK Enforcement (Prerequisite)

`PRAGMA foreign_keys = ON` is currently OFF in both databases. Even existing hard FKs (e.g., `tasks.parent_id`, `task_dependencies.task_id`) are not enforced at runtime. This must be fixed before adding new FK constraints.

**Action:** Ensure every database connection enables FK enforcement:
```typescript
// In data-accessor.ts / brain-accessor.ts connection setup
db.run('PRAGMA foreign_keys = ON');
```

This is non-destructive and requires no schema migration.

---

### Phase 2: Clean Up Existing Data

Before adding FK constraints, purge or repair any orphans. Based on current audit:

- `audit_log`: 30 rows with `task_id = 'system'` — leave as-is (intentional sentinel, this table stays soft FK)
- All other tables: **0 orphans** — safe to add FKs immediately

---

### Phase 3: Migration Scripts (Intra-DB FKs)

SQLite does not support `ALTER TABLE ... ADD FOREIGN KEY`. All FK additions require a table rebuild. Drizzle migrations should be used; the following SQL is the equivalent of what Drizzle will generate.

The migrations should be applied in dependency order (referenced tables before referencing tables).

#### Migration: Add FK on `adr_task_links.task_id`

```sql
-- SFK-001: adr_task_links.task_id CASCADE
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `adr_task_links_new` (
  `adr_id` text NOT NULL,
  `task_id` text NOT NULL,
  `link_type` text DEFAULT 'related' NOT NULL,
  CONSTRAINT `adr_task_links_pk` PRIMARY KEY(`adr_id`, `task_id`),
  CONSTRAINT `fk_adr_task_links_adr_id` FOREIGN KEY (`adr_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_adr_task_links_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);

INSERT INTO `adr_task_links_new` SELECT * FROM `adr_task_links`;
DROP TABLE `adr_task_links`;
ALTER TABLE `adr_task_links_new` RENAME TO `adr_task_links`;

CREATE INDEX `idx_adr_task_links_task_id` ON `adr_task_links`(`task_id`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FKs on `pipeline_manifest`

```sql
-- SFK-002/003/004: pipeline_manifest SET NULL FKs
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `pipeline_manifest_new` (
  `id` text PRIMARY KEY,
  `session_id` text,
  `task_id` text,
  `epic_id` text,
  `type` text NOT NULL,
  `content` text NOT NULL,
  `content_hash` text,
  `status` text DEFAULT 'active' NOT NULL,
  `distilled` integer DEFAULT false NOT NULL,
  `brain_obs_id` text,
  `source_file` text,
  `metadata_json` text,
  `created_at` text NOT NULL,
  `archived_at` text,
  CONSTRAINT `fk_pipeline_manifest_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pipeline_manifest_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pipeline_manifest_epic_id` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);

INSERT INTO `pipeline_manifest_new` SELECT * FROM `pipeline_manifest`;
DROP TABLE `pipeline_manifest`;
ALTER TABLE `pipeline_manifest_new` RENAME TO `pipeline_manifest`;

CREATE INDEX `idx_pipeline_manifest_task_id` ON `pipeline_manifest`(`task_id`);
CREATE INDEX `idx_pipeline_manifest_session_id` ON `pipeline_manifest`(`session_id`);
CREATE INDEX `idx_pipeline_manifest_distilled` ON `pipeline_manifest`(`distilled`);
CREATE INDEX `idx_pipeline_manifest_status` ON `pipeline_manifest`(`status`);
CREATE INDEX `idx_pipeline_manifest_content_hash` ON `pipeline_manifest`(`content_hash`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FK on `release_manifests.epic_id`

```sql
-- SFK-006: release_manifests.epic_id SET NULL
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `release_manifests_new` (
  `id` text PRIMARY KEY,
  `version` text NOT NULL UNIQUE,
  `status` text DEFAULT 'draft' NOT NULL,
  `pipeline_id` text,
  `epic_id` text,
  `tasks_json` text DEFAULT '[]' NOT NULL,
  `changelog` text,
  `notes` text,
  `previous_version` text,
  `commit_sha` text,
  `git_tag` text,
  `npm_dist_tag` text,
  `created_at` text NOT NULL,
  `prepared_at` text,
  `committed_at` text,
  `tagged_at` text,
  `pushed_at` text,
  CONSTRAINT `fk_release_manifests_pipeline_id` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_release_manifests_epic_id` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);

INSERT INTO `release_manifests_new` SELECT * FROM `release_manifests`;
DROP TABLE `release_manifests`;
ALTER TABLE `release_manifests_new` RENAME TO `release_manifests`;

CREATE INDEX `idx_release_manifests_status` ON `release_manifests`(`status`);
CREATE INDEX `idx_release_manifests_version` ON `release_manifests`(`version`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FK on `warp_chain_instances.epic_id`

```sql
-- SFK-007: warp_chain_instances.epic_id CASCADE
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `warp_chain_instances_new` (
  `id` text PRIMARY KEY,
  `chain_id` text NOT NULL,
  `epic_id` text NOT NULL,
  `variables` text,
  `stage_to_task` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `current_stage` text,
  `gate_results` text,
  `created_at` text DEFAULT (datetime('now')),
  `updated_at` text DEFAULT (datetime('now')),
  CONSTRAINT `fk_warp_chain_instances_chain_id` FOREIGN KEY (`chain_id`) REFERENCES `warp_chains`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_warp_chain_instances_epic_id` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);

INSERT INTO `warp_chain_instances_new` SELECT * FROM `warp_chain_instances`;
DROP TABLE `warp_chain_instances`;
ALTER TABLE `warp_chain_instances_new` RENAME TO `warp_chain_instances`;

CREATE INDEX `idx_warp_instances_chain` ON `warp_chain_instances`(`chain_id`);
CREATE INDEX `idx_warp_instances_epic` ON `warp_chain_instances`(`epic_id`);
CREATE INDEX `idx_warp_instances_status` ON `warp_chain_instances`(`status`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FKs on `lifecycle_transitions` stage references

```sql
-- SFK-008/009: lifecycle_transitions stage FKs CASCADE
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `lifecycle_transitions_new` (
  `id` text PRIMARY KEY,
  `pipeline_id` text NOT NULL,
  `from_stage_id` text NOT NULL,
  `to_stage_id` text NOT NULL,
  `transition_type` text DEFAULT 'automatic' NOT NULL,
  `transitioned_by` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  CONSTRAINT `fk_lifecycle_transitions_pipeline_id` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lifecycle_transitions_from_stage_id` FOREIGN KEY (`from_stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lifecycle_transitions_to_stage_id` FOREIGN KEY (`to_stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);

INSERT INTO `lifecycle_transitions_new` SELECT * FROM `lifecycle_transitions`;
DROP TABLE `lifecycle_transitions`;
ALTER TABLE `lifecycle_transitions_new` RENAME TO `lifecycle_transitions`;

CREATE INDEX `idx_lifecycle_transitions_pipeline_id` ON `lifecycle_transitions`(`pipeline_id`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add self-ref FKs on `architecture_decisions`

```sql
-- SFK-010/011/012/013: architecture_decisions self-refs and consensus_manifest_id SET NULL
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `architecture_decisions_new` (
  `id` text PRIMARY KEY,
  `title` text NOT NULL,
  `status` text DEFAULT 'proposed' NOT NULL,
  `supersedes_id` text,
  `superseded_by_id` text,
  `consensus_manifest_id` text,
  `content` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text,
  `date` text DEFAULT '' NOT NULL,
  `accepted_at` text,
  `gate` text,
  `gate_status` text,
  `amends_id` text,
  `file_path` text DEFAULT '' NOT NULL,
  `summary` text,
  `keywords` text,
  `topics` text,
  CONSTRAINT `fk_arch_decisions_supersedes_id` FOREIGN KEY (`supersedes_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arch_decisions_superseded_by_id` FOREIGN KEY (`superseded_by_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arch_decisions_amends_id` FOREIGN KEY (`amends_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arch_decisions_consensus_manifest_id` FOREIGN KEY (`consensus_manifest_id`) REFERENCES `manifest_entries`(`id`) ON DELETE SET NULL
);

INSERT INTO `architecture_decisions_new` SELECT * FROM `architecture_decisions`;
DROP TABLE `architecture_decisions`;
ALTER TABLE `architecture_decisions_new` RENAME TO `architecture_decisions`;

CREATE INDEX `idx_arch_decisions_status` ON `architecture_decisions`(`status`);
CREATE INDEX `idx_arch_decisions_amends_id` ON `architecture_decisions`(`amends_id`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FKs on `agent_instances`

```sql
-- SFK-014/015/016: agent_instances soft refs SET NULL
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `agent_instances_new` (
  `id` text PRIMARY KEY,
  `agent_type` text NOT NULL,
  `status` text DEFAULT 'starting' NOT NULL,
  `session_id` text,
  `task_id` text,
  `started_at` text DEFAULT (datetime('now')) NOT NULL,
  `last_heartbeat` text DEFAULT (datetime('now')) NOT NULL,
  `stopped_at` text,
  `error_count` integer DEFAULT 0 NOT NULL,
  `total_tasks_completed` integer DEFAULT 0 NOT NULL,
  `capacity` text DEFAULT '1.0' NOT NULL,
  `metadata_json` text DEFAULT '{}',
  `parent_agent_id` text,
  CONSTRAINT `fk_agent_instances_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_agent_instances_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_agent_instances_parent_agent_id` FOREIGN KEY (`parent_agent_id`) REFERENCES `agent_instances`(`id`) ON DELETE SET NULL
);

INSERT INTO `agent_instances_new` SELECT * FROM `agent_instances`;
DROP TABLE `agent_instances`;
ALTER TABLE `agent_instances_new` RENAME TO `agent_instances`;

CREATE INDEX `idx_agent_instances_status` ON `agent_instances`(`status`);
CREATE INDEX `idx_agent_instances_agent_type` ON `agent_instances`(`agent_type`);
CREATE INDEX `idx_agent_instances_session_id` ON `agent_instances`(`session_id`);
CREATE INDEX `idx_agent_instances_task_id` ON `agent_instances`(`task_id`);
CREATE INDEX `idx_agent_instances_parent_agent_id` ON `agent_instances`(`parent_agent_id`);
CREATE INDEX `idx_agent_instances_last_heartbeat` ON `agent_instances`(`last_heartbeat`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FK on `agent_error_log.agent_id`

```sql
-- SFK-017: agent_error_log.agent_id CASCADE
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `agent_error_log_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `agent_id` text NOT NULL,
  `error_type` text NOT NULL,
  `message` text NOT NULL,
  `stack` text,
  `occurred_at` text DEFAULT (datetime('now')) NOT NULL,
  `resolved` integer DEFAULT false NOT NULL,
  CONSTRAINT `fk_agent_error_log_agent_id` FOREIGN KEY (`agent_id`) REFERENCES `agent_instances`(`id`) ON DELETE CASCADE
);

INSERT INTO `agent_error_log_new` SELECT * FROM `agent_error_log`;
DROP TABLE `agent_error_log`;
ALTER TABLE `agent_error_log_new` RENAME TO `agent_error_log`;

CREATE INDEX `idx_agent_error_log_agent_id` ON `agent_error_log`(`agent_id`);
CREATE INDEX `idx_agent_error_log_error_type` ON `agent_error_log`(`error_type`);
CREATE INDEX `idx_agent_error_log_occurred_at` ON `agent_error_log`(`occurred_at`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FK on `tasks.session_id`

```sql
-- SFK-018: tasks.session_id SET NULL
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- tasks table rebuild needed to add session_id FK
-- NOTE: tasks.parent_id FK already exists; preserve it
CREATE TABLE `tasks_new` (
  `id` text PRIMARY KEY,
  `title` text NOT NULL,
  `description` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `priority` text DEFAULT 'medium' NOT NULL,
  `type` text,
  `parent_id` text,
  `phase` text,
  `size` text,
  `position` integer,
  `position_version` integer DEFAULT 0,
  `labels_json` text DEFAULT '[]',
  `notes_json` text DEFAULT '[]',
  `acceptance_json` text DEFAULT '[]',
  `files_json` text DEFAULT '[]',
  `origin` text,
  `blocked_by` text,
  `epic_lifecycle` text,
  `no_auto_complete` integer,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text,
  `completed_at` text,
  `cancelled_at` text,
  `cancellation_reason` text,
  `archived_at` text,
  `archive_reason` text,
  `cycle_time_days` integer,
  `verification_json` text,
  `created_by` text,
  `modified_by` text,
  `session_id` text,
  CONSTRAINT `fk_tasks_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tasks_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);

INSERT INTO `tasks_new` SELECT * FROM `tasks`;
DROP TABLE `tasks`;
ALTER TABLE `tasks_new` RENAME TO `tasks`;

CREATE INDEX `idx_tasks_status` ON `tasks`(`status`);
CREATE INDEX `idx_tasks_parent_id` ON `tasks`(`parent_id`);
CREATE INDEX `idx_tasks_phase` ON `tasks`(`phase`);
CREATE INDEX `idx_tasks_type` ON `tasks`(`type`);
CREATE INDEX `idx_tasks_priority` ON `tasks`(`priority`);
CREATE INDEX `idx_tasks_session_id` ON `tasks`(`session_id`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FK on `token_usage` session/task refs

```sql
-- SFK-020/021: token_usage SET NULL FKs
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `token_usage_new` (
  `id` text PRIMARY KEY,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `provider` text DEFAULT 'unknown' NOT NULL,
  `model` text,
  `transport` text DEFAULT 'unknown' NOT NULL,
  `gateway` text,
  `domain` text,
  `operation` text,
  `session_id` text,
  `task_id` text,
  `request_id` text,
  `input_chars` integer DEFAULT 0 NOT NULL,
  `output_chars` integer DEFAULT 0 NOT NULL,
  `input_tokens` integer DEFAULT 0 NOT NULL,
  `output_tokens` integer DEFAULT 0 NOT NULL,
  `total_tokens` integer DEFAULT 0 NOT NULL,
  `method` text DEFAULT 'heuristic' NOT NULL,
  `confidence` text DEFAULT 'coarse' NOT NULL,
  `request_hash` text,
  `response_hash` text,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  CONSTRAINT `fk_token_usage_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_token_usage_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);

INSERT INTO `token_usage_new` SELECT * FROM `token_usage`;
DROP TABLE `token_usage`;
ALTER TABLE `token_usage_new` RENAME TO `token_usage`;

CREATE INDEX `idx_token_usage_created_at` ON `token_usage`(`created_at`);
CREATE INDEX `idx_token_usage_request_id` ON `token_usage`(`request_id`);
CREATE INDEX `idx_token_usage_session_id` ON `token_usage`(`session_id`);
CREATE INDEX `idx_token_usage_task_id` ON `token_usage`(`task_id`);
CREATE INDEX `idx_token_usage_provider` ON `token_usage`(`provider`);
CREATE INDEX `idx_token_usage_transport` ON `token_usage`(`transport`);
CREATE INDEX `idx_token_usage_domain_operation` ON `token_usage`(`domain`, `operation`);
CREATE INDEX `idx_token_usage_method` ON `token_usage`(`method`);
CREATE INDEX `idx_token_usage_gateway` ON `token_usage`(`gateway`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FK on `task_work_history.task_id`

```sql
-- SFK-022: task_work_history.task_id CASCADE
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `task_work_history_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `session_id` text NOT NULL,
  `task_id` text NOT NULL,
  `set_at` text DEFAULT (datetime('now')) NOT NULL,
  `cleared_at` text,
  CONSTRAINT `fk_task_work_history_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_task_work_history_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);

INSERT INTO `task_work_history_new` SELECT * FROM `task_work_history`;
DROP TABLE `task_work_history`;
ALTER TABLE `task_work_history_new` RENAME TO `task_work_history`;

CREATE INDEX `idx_work_history_session` ON `task_work_history`(`session_id`);

COMMIT;
PRAGMA foreign_keys = ON;
```

#### Migration: Add FK on `sessions.current_task`

```sql
-- SFK-023: sessions.current_task SET NULL
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE `sessions_new` (
  `id` text PRIMARY KEY,
  `name` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `scope_json` text DEFAULT '{}' NOT NULL,
  `current_task` text,
  `task_started_at` text,
  `agent` text,
  `notes_json` text DEFAULT '[]',
  `tasks_completed_json` text DEFAULT '[]',
  `tasks_created_json` text DEFAULT '[]',
  `handoff_json` text,
  `started_at` text DEFAULT (datetime('now')) NOT NULL,
  `ended_at` text,
  `previous_session_id` text,
  `next_session_id` text,
  `agent_identifier` text,
  `handoff_consumed_at` text,
  `handoff_consumed_by` text,
  `debrief_json` text,
  `provider_id` text,
  `stats_json` text,
  `resume_count` integer,
  `grade_mode` integer,
  CONSTRAINT `fk_sessions_previous_session_id` FOREIGN KEY (`previous_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sessions_next_session_id` FOREIGN KEY (`next_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sessions_current_task` FOREIGN KEY (`current_task`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);

INSERT INTO `sessions_new` SELECT * FROM `sessions`;
DROP TABLE `sessions`;
ALTER TABLE `sessions_new` RENAME TO `sessions`;

CREATE INDEX `idx_sessions_status` ON `sessions`(`status`);
CREATE INDEX `idx_sessions_previous` ON `sessions`(`previous_session_id`);
CREATE INDEX `idx_sessions_agent_identifier` ON `sessions`(`agent_identifier`);
CREATE INDEX `idx_sessions_started_at` ON `sessions`(`started_at`);

COMMIT;
PRAGMA foreign_keys = ON;
```

---

### Phase 4: Cross-DB Application Guards (brain.db)

Since SQLite cannot enforce cross-database FKs, the following application-layer patterns are required:

1. **Write guards**: Before inserting into `brain_decisions` with a non-null `context_task_id` or `context_epic_id`, verify the task exists in tasks.db.

2. **Delete hooks**: When a task is deleted from tasks.db, run a cleanup sweep:
   - Nullify `brain_decisions.context_epic_id` and `context_task_id` where they match the deleted task ID
   - Delete `brain_memory_links` rows where `task_id` matches the deleted task
   - Delete `brain_page_nodes` where `id = 'task:<deleted_task_id>'` and cascade to `brain_page_edges`

3. **Session delete hooks**: When a session is deleted from tasks.db:
   - Nullify `brain_observations.source_session_id` where it matches the deleted session

These hooks should be implemented as lifecycle events in `data-accessor.ts` triggered after confirmed deletions.

---

## Part 5: Priority Matrix

| ID | Table.Column | Action | Priority | Blocker? |
|----|-------------|--------|----------|----------|
| PREREQ | Enable PRAGMA foreign_keys = ON | Application change | Critical | Yes |
| SFK-022 | task_work_history.task_id | CASCADE | High | No |
| SFK-007 | warp_chain_instances.epic_id | CASCADE | High | No |
| SFK-017 | agent_error_log.agent_id | CASCADE | High | No |
| SFK-001 | adr_task_links.task_id | CASCADE | High | No |
| SFK-008/009 | lifecycle_transitions stage refs | CASCADE | Medium | No |
| SFK-014/015/016 | agent_instances refs | SET NULL | Medium | No |
| SFK-018 | tasks.session_id | SET NULL | Medium | No |
| SFK-023 | sessions.current_task | SET NULL | Medium | No |
| SFK-002/003/004 | pipeline_manifest refs | SET NULL | Medium | No |
| SFK-010/011/012 | architecture_decisions self-refs | SET NULL | Medium | No |
| SFK-013 | arch_decisions.consensus_manifest_id | SET NULL | Low | No |
| SFK-006 | release_manifests.epic_id | SET NULL | Low | No |
| SFK-020/021 | token_usage refs | SET NULL | Low | No |
| XFKB-003 | brain_memory_links.task_id | App guard | Medium | No |
| XFKB-001/002 | brain_decisions context refs | App guard | Low | No |
| XFKB-004 | brain_observations.source_session_id | App guard | Low | No |
| XFKB-005 | brain_page_nodes task refs | App guard | Low | No |
| SFK-019 | audit_log.task_id | Keep soft (intentional) | — | N/A |
| SFK-005 | pipeline_manifest.brain_obs_id | App guard (cross-DB) | Low | No |

---

## Findings Summary

| Category | Count |
|----------|-------|
| Total soft FKs identified | 23 |
| Intentionally soft (must stay soft) | 1 (audit_log.task_id) |
| Cross-DB (cannot be native FKs) | 5 (brain.db → tasks.db) |
| Intra-DB candidates for hardening | 17 |
| Current orphan violations | 0 (excluding intentional sentinel) |
| FK enforcement currently ON | No (PRAGMA foreign_keys = 0) |
