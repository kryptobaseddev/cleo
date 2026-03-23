# T031 — Missing Index Analysis and Creation

**Date**: 2026-03-20
**Task**: T031
**Epic**: T029 (Schema Architecture Review)
**Status**: Analysis complete — no schema files modified

---

## 1. Databases In Scope

| Database | File | Schema Source |
|----------|------|---------------|
| `tasks.db` | `.cleo/tasks.db` | `packages/core/src/store/tasks-schema.ts` |
| `brain.db` | `.cleo/brain.db` | `packages/core/src/store/brain-schema.ts` |

---

## 2. Existing Indexes Inventory

### 2.1 tasks.db — `tasks` Table

| Index Name | Columns | Defined In |
|------------|---------|------------|
| `idx_tasks_status` | `status` | tasks-schema.ts:195 |
| `idx_tasks_parent_id` | `parent_id` | tasks-schema.ts:196 |
| `idx_tasks_phase` | `phase` | tasks-schema.ts:197 |
| `idx_tasks_type` | `type` | tasks-schema.ts:198 |
| `idx_tasks_priority` | `priority` | tasks-schema.ts:199 |
| `idx_tasks_session_id` | `session_id` | tasks-schema.ts:200 |
| PRIMARY KEY | `id` | tasks-schema.ts:140 |

### 2.2 tasks.db — `task_dependencies` Table

| Index Name | Columns |
|------------|---------|
| PRIMARY KEY | `(task_id, depends_on)` |
| `idx_deps_depends_on` | `depends_on` |

### 2.3 tasks.db — `task_relations` Table

| Index Name | Columns |
|------------|---------|
| PRIMARY KEY | `(task_id, related_to)` |
| `idx_task_relations_related_to` | `related_to` |

### 2.4 tasks.db — `sessions` Table

| Index Name | Columns |
|------------|---------|
| PRIMARY KEY | `id` |
| `idx_sessions_status` | `status` |
| `idx_sessions_previous` | `previous_session_id` |
| `idx_sessions_agent_identifier` | `agent_identifier` |
| `idx_sessions_started_at` | `started_at` |

### 2.5 tasks.db — `task_work_history` Table

| Index Name | Columns |
|------------|---------|
| PRIMARY KEY | `id` (autoincrement) |
| `idx_work_history_session` | `session_id` |

### 2.6 tasks.db — `audit_log` Table

| Index Name | Columns |
|------------|---------|
| PRIMARY KEY | `id` |
| `idx_audit_log_task_id` | `task_id` |
| `idx_audit_log_action` | `action` |
| `idx_audit_log_timestamp` | `timestamp` |
| `idx_audit_log_domain` | `domain` |
| `idx_audit_log_request_id` | `request_id` |
| `idx_audit_log_project_hash` | `project_hash` |
| `idx_audit_log_actor` | `actor` |

### 2.7 tasks.db — `token_usage` Table

| Index Name | Columns |
|------------|---------|
| PRIMARY KEY | `id` |
| `idx_token_usage_created_at` | `created_at` |
| `idx_token_usage_request_id` | `request_id` |
| `idx_token_usage_session_id` | `session_id` |
| `idx_token_usage_task_id` | `task_id` |
| `idx_token_usage_provider` | `provider` |
| `idx_token_usage_transport` | `transport` |
| `idx_token_usage_domain_operation` | `(domain, operation)` |
| `idx_token_usage_method` | `method` |
| `idx_token_usage_gateway` | `gateway` |

### 2.8 tasks.db — Other Tables (lifecycle, ADR, manifest)

| Table | Indexes |
|-------|---------|
| `lifecycle_pipelines` | `idx_lifecycle_pipelines_task_id`, `idx_lifecycle_pipelines_status` |
| `lifecycle_stages` | `idx_lifecycle_stages_pipeline_id`, `idx_lifecycle_stages_stage_name`, `idx_lifecycle_stages_status`, `idx_lifecycle_stages_validated_by` |
| `lifecycle_gate_results` | `idx_lifecycle_gate_results_stage_id` |
| `lifecycle_evidence` | `idx_lifecycle_evidence_stage_id` |
| `lifecycle_transitions` | `idx_lifecycle_transitions_pipeline_id` |
| `manifest_entries` | `idx_manifest_entries_pipeline_id`, `idx_manifest_entries_stage_id`, `idx_manifest_entries_status` |
| `pipeline_manifest` | `idx_pipeline_manifest_task_id`, `idx_pipeline_manifest_session_id`, `idx_pipeline_manifest_distilled`, `idx_pipeline_manifest_status`, `idx_pipeline_manifest_content_hash` |
| `release_manifests` | `idx_release_manifests_status`, `idx_release_manifests_version` |
| `architecture_decisions` | `idx_arch_decisions_status`, `idx_arch_decisions_amends_id` |
| `adr_task_links` | PK `(adr_id, task_id)`, `idx_adr_task_links_task_id` |
| `external_task_links` | `idx_ext_links_task_id`, `idx_ext_links_provider_external`, `idx_ext_links_provider_id`, UNIQUE `(task_id, provider_id, external_id)` |
| `status_registry` | PK `(name, entity_type)`, `idx_status_registry_entity_type`, `idx_status_registry_namespace` |

### 2.9 brain.db — All Tables

| Table | Indexes |
|-------|---------|
| `brain_decisions` | `idx_brain_decisions_type`, `idx_brain_decisions_confidence`, `idx_brain_decisions_outcome`, `idx_brain_decisions_context_epic`, `idx_brain_decisions_context_task` |
| `brain_patterns` | `idx_brain_patterns_type`, `idx_brain_patterns_impact`, `idx_brain_patterns_frequency` |
| `brain_learnings` | `idx_brain_learnings_confidence`, `idx_brain_learnings_actionable` |
| `brain_observations` | `idx_brain_observations_type`, `idx_brain_observations_project`, `idx_brain_observations_created_at`, `idx_brain_observations_source_type`, `idx_brain_observations_source_session`, `idx_brain_observations_content_hash` |
| `brain_sticky_notes` | `idx_brain_sticky_status`, `idx_brain_sticky_created`, `idx_brain_sticky_tags` |
| `brain_memory_links` | PK `(memory_type, memory_id, task_id, link_type)`, `idx_brain_links_task`, `idx_brain_links_memory` |
| `brain_page_nodes` | `idx_brain_nodes_type` |
| `brain_page_edges` | PK `(from_id, to_id, edge_type)`, `idx_brain_edges_from`, `idx_brain_edges_to` |

---

## 3. Query Pattern Analysis

### 3.1 `tasks` Table — Query Patterns

**Source files**: `sqlite-data-accessor.ts`, `task-store.ts`, `stats/index.ts`

| Query Pattern | Columns Used in WHERE | Current Index Coverage | Gap |
|---------------|-----------------------|----------------------|-----|
| List active tasks (default) | `status != 'archived'` | `idx_tasks_status` | None |
| Filter by status + type | `status`, `type` | Separate indexes | No composite — full scan on second predicate |
| Filter by status + priority | `status`, `priority` | Separate indexes | No composite — full scan on second predicate |
| Filter by parentId + status | `parent_id`, `status != 'archived'` | Separate indexes | No composite — used in `getChildren`, `countChildren`, `shiftPositions` |
| Filter by type + phase | `type`, `phase` | Separate indexes | No composite |
| Count by status (GROUP BY) | `status` | `idx_tasks_status` | None |
| Stats: archived + archiveReason | `status='archived'`, `archive_reason='completed'` | Only `idx_tasks_status` | No composite for archiving stats |
| Position queries | `parent_id IS NULL`, `status != 'archived'` | `idx_tasks_parent_id` | No composite with status |
| `listTasks` with status + parentId + type + phase | All four columns possible | Separate indexes | No composite |
| `queryTasks` ordered by `position ASC, createdAt ASC` | `status` + ORDER BY `position, created_at` | `idx_tasks_status` | No covering index for sort |

**Most frequent compound query** (from `sqlite-data-accessor.ts:queryTasks` and `getChildren`):
```sql
-- getChildren: called on virtually every task tree render
WHERE parent_id = ? AND status != 'archived'
ORDER BY position ASC, created_at ASC

-- countChildren / countActiveChildren
WHERE parent_id = ? AND status NOT IN ('done','cancelled','archived')

-- listTasks (task-store.ts): most common list path
WHERE status != 'archived' AND type = ? AND phase = ?
ORDER BY position ASC, created_at ASC
```

### 3.2 `sessions` Table — Query Patterns

**Source files**: `session-store.ts`, `sqlite-data-accessor.ts`

| Query Pattern | Columns | Coverage |
|---------------|---------|----------|
| `getActiveSession` | `status = 'active'` ORDER BY `started_at DESC` LIMIT 1 | `idx_sessions_status` + `idx_sessions_started_at` (separate) |
| `listSessions` with active filter | `status = 'active'` ORDER BY `started_at DESC` | Same as above |
| `gcSessions` | `status = 'ended'` | `idx_sessions_status` |

**Key observation**: The `getActiveSession` query is the most frequently called session query (called on every session-aware operation). It filters on `status` AND sorts by `started_at DESC`. With separate single-column indexes, SQLite must pick one — either use `idx_sessions_status` and sort in memory, or use `idx_sessions_started_at` and filter without index. A composite `(status, started_at)` index would serve this query optimally.

### 3.3 `audit_log` Table — Query Patterns

**Source files**: `audit.ts`, `audit-prune.ts`, `stats/index.ts`

| Query Pattern | Columns | Coverage |
|---------------|---------|----------|
| `queryAudit` with sessionId filter | `session_id`, `timestamp` ORDER BY `timestamp` | No `session_id` index |
| `queryAudit` with domain + operation | `domain`, `operation`, `timestamp` | `idx_audit_log_domain` only |
| `queryAudit` with taskId + since | `task_id`, `timestamp >= ?` | Separate indexes |
| `pruneAuditLog` — delete by timestamp | `timestamp < cutoff` | `idx_audit_log_timestamp` |
| `queryAuditEntries` (stats) | all rows, ORDER BY `timestamp` | `idx_audit_log_timestamp` |
| Session-scoped audit query | `session_id = ?`, sorted by `timestamp` | No `session_id` index |

**Key observation**: `audit_log` has no index on `session_id`. The `queryAudit` function in `audit.ts` filters by `sessionId` (line 63) and is called by `session-grade.ts` for behavioral analysis — a per-session scan without an index.

### 3.4 `brain_observations` Table — Query Patterns

**Source files**: `brain-accessor.ts`, `brain-retrieval.ts`

| Query Pattern | Columns | Coverage |
|---------------|---------|----------|
| `findObservations` by type | `type` | `idx_brain_observations_type` |
| `findObservations` by project | `project` | `idx_brain_observations_project` |
| `findObservations` by sourceSessionId | `source_session_id` | `idx_brain_observations_source_session` |
| `findObservations` by type + project (common combination) | `type`, `project` | No composite |
| `findObservations` by sourceType + date range | `source_type`, `created_at` | Separate indexes |
| Timeline: `created_at < ?` AND `id != ?` ORDER BY `created_at DESC` | `created_at` | `idx_brain_observations_created_at` |
| Dedup check: `content_hash = ?` AND `created_at > ?` | `content_hash`, `created_at` | Separate indexes |

**Key observation**: The dedup check in `observeBrain` (`brain-retrieval.ts:539`) uses `WHERE content_hash = ? AND created_at > ?`. This is the hot path for every `memory observe` call — a composite index on `(content_hash, created_at)` would make it a tight index lookup instead of a filter scan.

---

## 4. Recommended Indexes

### 4.1 `tasks` Table

#### INDEX 1 — `idx_tasks_parent_status` (HIGH VALUE)

```sql
CREATE INDEX idx_tasks_parent_status
  ON tasks (parent_id, status);
```

**Optimizes**:
- `getChildren(parentId)`: `WHERE parent_id = ? AND status != 'archived'`
- `countChildren(parentId)`: `WHERE parent_id = ? AND status != 'archived'`
- `countActiveChildren(parentId)`: `WHERE parent_id = ? AND status NOT IN (...)`
- `shiftPositions`: `WHERE parent_id = ? AND status != 'archived'`
- `getNextPosition`: `WHERE parent_id = ? AND status != 'archived'`

These are called on nearly every task hierarchy render. Currently SQLite must use `idx_tasks_parent_id` and then filter by status in memory, or vice versa.

**Not redundant**: `idx_tasks_parent_id` (single column) and `idx_tasks_status` (single column) both still serve their own single-column queries. This composite serves the compound WHERE.

---

#### INDEX 2 — `idx_tasks_status_priority` (MEDIUM VALUE)

```sql
CREATE INDEX idx_tasks_status_priority
  ON tasks (status, priority);
```

**Optimizes**:
- `queryTasks` with `{ status, priority }` filters (sqlite-data-accessor.ts:409)
- Dashboard `highPriority` query pattern: `priority IN ('critical','high') AND status NOT IN ('done','cancelled')`
- `listTasks` with both status and priority filters

**Not redundant**: `idx_tasks_status` and `idx_tasks_priority` exist as single-column indexes but cannot serve compound WHERE clauses efficiently. This composite avoids a second-pass filter.

---

#### INDEX 3 — `idx_tasks_type_phase` (MEDIUM VALUE)

```sql
CREATE INDEX idx_tasks_type_phase
  ON tasks (type, phase);
```

**Optimizes**:
- `listTasks` with `{ type, phase }` filters (task-store.ts:154–155)
- `queryTasks` with `{ type, phase }` filters (sqlite-data-accessor.ts:410–411)
- Epic listing: `type = 'epic'` AND `phase = ?`

**Not redundant**: `idx_tasks_type` and `idx_tasks_phase` exist separately but cannot cover compound queries without a table scan on the second predicate.

---

#### INDEX 4 — `idx_tasks_status_archive_reason` (LOW-MEDIUM VALUE)

```sql
CREATE INDEX idx_tasks_status_archive_reason
  ON tasks (status, archive_reason);
```

**Optimizes**:
- Stats query in `stats/index.ts:147–151`:
  `WHERE status = 'archived' AND archive_reason = 'completed'`

This query counts archived-as-completed tasks for the all-time completion metric. Without a composite index, SQLite scans all archived rows and filters on `archive_reason`.

**Not redundant**: `idx_tasks_status` alone cannot avoid the filter on `archive_reason`.

---

### 4.2 `sessions` Table

#### INDEX 5 — `idx_sessions_status_started_at` (HIGH VALUE)

```sql
CREATE INDEX idx_sessions_status_started_at
  ON sessions (status, started_at DESC);
```

**Optimizes**:
- `getActiveSession()`: `WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`
  Called on every session-aware CLI operation, session status check, and MCP `session status` query.
- `listSessions({ active: true })`: `WHERE status = 'active' ORDER BY started_at DESC`
- `gcSessions`: `WHERE status = 'ended'` (also benefits from the leading `status` column)

With this composite index, the `getActiveSession` query becomes a single index range scan: seek to `status = 'active'`, scan in `started_at DESC` order, return after first row. No separate sort step.

**Note on DESC**: SQLite supports DESC in index definitions since 3.38 (2022). The runtime is Node.js native SQLite which bundles SQLite 3.39+. If DESC causes issues in older environments, an ASC index on `(status, started_at)` still eliminates the memory sort for the LIMIT 1 case.

**Not redundant**: `idx_sessions_status` and `idx_sessions_started_at` are separate and cannot serve the compound query as efficiently as a composite.

---

### 4.3 `audit_log` Table

#### INDEX 6 — `idx_audit_log_session_id` (HIGH VALUE)

```sql
CREATE INDEX idx_audit_log_session_id
  ON audit_log (session_id);
```

**Optimizes**:
- `queryAudit({ sessionId })` in `audit.ts:63`: `WHERE session_id = ?`
  Called by `session-grade.ts` for behavioral analysis after every graded session.
- Session-scoped audit views used in session debrief and handoff generation.

**Current state**: `audit_log` has 7 indexes but **no index on `session_id`**. Every session-scoped audit query is a full table scan.

**Not redundant**: None of the existing indexes cover `session_id`.

---

#### INDEX 7 — `idx_audit_log_session_timestamp` (MEDIUM VALUE)

```sql
CREATE INDEX idx_audit_log_session_timestamp
  ON audit_log (session_id, timestamp);
```

**Optimizes**:
- `queryAudit({ sessionId, since })`: `WHERE session_id = ? AND timestamp >= ? ORDER BY timestamp ASC`
  This is the full compound query used by session grading — filters by session AND time range, then orders chronologically.

**Relationship to INDEX 6**: INDEX 7 is strictly more powerful than INDEX 6 for the compound query. However, INDEX 6 (single-column) is still useful for queries that only filter by `session_id` without a `since` filter. Both may be warranted given audit_log's append-heavy usage, but if storage is a concern, INDEX 7 alone covers both the single-column and composite cases (SQLite can use a composite index for single-column prefix queries).

**Recommendation**: If implementing both INDEX 6 and INDEX 7 is undesirable, skip INDEX 6 and implement INDEX 7 only — the composite serves both patterns.

---

#### INDEX 8 — `idx_audit_log_domain_operation` (MEDIUM VALUE)

```sql
CREATE INDEX idx_audit_log_domain_operation
  ON audit_log (domain, operation);
```

**Optimizes**:
- `queryAudit({ domain, operation })` in `audit.ts:65–68`:
  `WHERE (operation = ? OR action = ?) AND domain = ?`
- Token service domain/operation reporting queries.

**Note**: The existing `idx_audit_log_domain` only covers the leading `domain` column. Adding `operation` to the composite eliminates the second predicate scan when both are provided.

**Not redundant**: `idx_audit_log_domain` (single) still serves queries filtering only by domain. The composite adds coverage for the compound case.

---

### 4.4 `brain_observations` Table

#### INDEX 9 — `idx_brain_observations_content_hash_created_at` (HIGH VALUE)

```sql
CREATE INDEX idx_brain_observations_content_hash_created_at
  ON brain_observations (content_hash, created_at);
```

**Optimizes**:
- Hot dedup check in `observeBrain` (`brain-retrieval.ts:539`):
  `WHERE content_hash = ? AND created_at > ?`
  Called on **every** `memory observe` operation. Currently, `idx_brain_observations_content_hash` exists (single column) but the additional `created_at > cutoff` filter requires a range scan over all rows with that hash (unlikely to be many, but unindexed ranges on text columns are unordered scans).

**Not redundant**: `idx_brain_observations_content_hash` (single column) exists. This composite adds the `created_at` range predicate to the index structure. For dedup (where a hash typically matches 0–1 rows), the benefit is minimal in steady state but critical if observations accumulate across many sessions.

---

#### INDEX 10 — `idx_brain_observations_type_project` (MEDIUM VALUE)

```sql
CREATE INDEX idx_brain_observations_type_project
  ON brain_observations (type, project);
```

**Optimizes**:
- `findObservations({ type, project })` in `brain-accessor.ts:259–264`:
  `WHERE type = ? AND project = ? ORDER BY created_at DESC`
  This is a common retrieval pattern — filter by observation type within a project context.

**Not redundant**: `idx_brain_observations_type` and `idx_brain_observations_project` are separate single-column indexes. The compound query forces SQLite to use one and filter the other in memory.

---

#### INDEX 11 — `idx_brain_observations_source_type_created_at` (LOW-MEDIUM VALUE)

```sql
CREATE INDEX idx_brain_observations_source_type_created_at
  ON brain_observations (source_type, created_at DESC);
```

**Optimizes**:
- Timeline queries that filter by `source_type` (e.g., `agent`, `session-debrief`) and order by recency.
- `findObservations({ sourceType })` with implicit recency ordering.

**Verdict**: Lower priority than INDEX 9 and 10. The existing `idx_brain_observations_source_type` + `idx_brain_observations_created_at` covers most single-predicate cases. Add only if profiling shows this compound query is hot.

---

## 5. Redundancy Check

| Index | Verdict |
|-------|---------|
| `idx_tasks_parent_id` after adding INDEX 1 (`parent_id, status`) | **Not redundant** — SQLite uses single-column prefix for `WHERE parent_id = ?` queries without status filter. Keep. |
| `idx_tasks_status` after adding INDEX 1, 2 | **Not redundant** — serves `WHERE status = ?` standalone queries (e.g., `countByStatus`). Keep. |
| `idx_tasks_priority` after adding INDEX 2 | **Not redundant** — serves `WHERE priority = ?` standalone queries. Keep. |
| `idx_brain_observations_content_hash` after adding INDEX 9 | **Redundant if INDEX 9 is added** — SQLite can use the composite as a prefix index for single-column `content_hash` lookups. The single-column index becomes redundant. **Drop `idx_brain_observations_content_hash` when adding INDEX 9.** |
| `idx_audit_log_session_id` (INDEX 6) after adding INDEX 7 | INDEX 6 becomes redundant if INDEX 7 is implemented. SQLite uses the composite's leading column for single-predicate queries. **Do not add INDEX 6 if INDEX 7 is implemented.** |

---

## 6. Implementation Priority

| Priority | Index | Rationale |
|----------|-------|-----------|
| 1 (High) | INDEX 1: `idx_tasks_parent_status` | Called on every hierarchy render; compound WHERE is the default path |
| 2 (High) | INDEX 5: `idx_sessions_status_started_at` | `getActiveSession` is the most frequently called session query |
| 3 (High) | INDEX 6/7: `idx_audit_log_session_id` or `idx_audit_log_session_timestamp` | Session grading scans all audit rows without this |
| 4 (High) | INDEX 9: `idx_brain_observations_content_hash_created_at` | Hot path for every `memory observe` call; replace single-column content_hash index |
| 5 (Medium) | INDEX 2: `idx_tasks_status_priority` | Benefits dashboard and priority-filtered list views |
| 6 (Medium) | INDEX 3: `idx_tasks_type_phase` | Benefits `listTasks` and `queryTasks` compound filters |
| 7 (Medium) | INDEX 8: `idx_audit_log_domain_operation` | Benefits dispatch-layer audit queries |
| 8 (Medium) | INDEX 10: `idx_brain_observations_type_project` | Benefits `findObservations` compound filter |
| 9 (Low) | INDEX 4: `idx_tasks_status_archive_reason` | Low-frequency stats query |
| 10 (Low) | INDEX 11: `idx_brain_observations_source_type_created_at` | Only needed if profiling confirms it is hot |

---

## 7. CREATE INDEX SQL (Ready to Apply)

```sql
-- tasks.db

-- Priority 1: parent + status (most impactful for hierarchy queries)
CREATE INDEX IF NOT EXISTS idx_tasks_parent_status
  ON tasks (parent_id, status);

-- Priority 2: status + priority (dashboard, filtered list views)
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
  ON tasks (status, priority);

-- Priority 3: type + phase (epic/phase-scoped list queries)
CREATE INDEX IF NOT EXISTS idx_tasks_type_phase
  ON tasks (type, phase);

-- Priority 4: status + archive_reason (stats archived-completed count)
CREATE INDEX IF NOT EXISTS idx_tasks_status_archive_reason
  ON tasks (status, archive_reason);

-- Priority 5: sessions status + started_at (getActiveSession hot path)
CREATE INDEX IF NOT EXISTS idx_sessions_status_started_at
  ON sessions (status, started_at);

-- Priority 6: audit_log session_id + timestamp (session grading)
-- NOTE: This composite replaces a standalone session_id index — do not add both
CREATE INDEX IF NOT EXISTS idx_audit_log_session_timestamp
  ON audit_log (session_id, timestamp);

-- Priority 7: audit_log domain + operation (dispatch-layer audit)
CREATE INDEX IF NOT EXISTS idx_audit_log_domain_operation
  ON audit_log (domain, operation);


-- brain.db

-- Priority 8: content_hash + created_at (dedup hot path in observeBrain)
-- Drop idx_brain_observations_content_hash after creating this composite
CREATE INDEX IF NOT EXISTS idx_brain_observations_content_hash_created_at
  ON brain_observations (content_hash, created_at);

-- Priority 9: type + project (findObservations compound filter)
CREATE INDEX IF NOT EXISTS idx_brain_observations_type_project
  ON brain_observations (type, project);

-- Priority 10 (conditional — add only after profiling confirms need):
-- CREATE INDEX IF NOT EXISTS idx_brain_observations_source_type_created_at
--   ON brain_observations (source_type, created_at);
```

---

## 8. Indexes to Drop (Redundancy Removals)

| Index to Drop | Replacement | Reason |
|---------------|-------------|--------|
| `idx_brain_observations_content_hash` | INDEX 9 composite | Composite prefix covers all single-column `content_hash` queries |

**No other existing indexes are made redundant by the recommendations above.** All other proposed composites add coverage without duplicating existing index functionality, because existing single-column indexes remain useful for their respective single-predicate queries.

---

## 9. Notes on Implementation

1. **Migration vehicle**: These indexes should be added via a new Drizzle migration file (e.g., `packages/core/src/store/migrations/YYYYMMDD_composite-indexes.sql`) consistent with the existing migration pattern in `packages/core/src/store/migration-sqlite.ts`.

2. **Index naming convention**: Existing names follow `idx_<table>_<column(s)>`. Composite indexes use underscore-joined column names (e.g., `idx_tasks_parent_status`).

3. **`IF NOT EXISTS`**: All `CREATE INDEX` statements include `IF NOT EXISTS` to make the migration idempotent, consistent with the project's migration-retry safety pattern (see `migration-retry.test.ts`).

4. **SQLite DESC in indexes**: The `started_at DESC` suggestion for INDEX 5 is valid in SQLite 3.38+. If DESC is not used, the ASC composite `(status, started_at)` still eliminates the in-memory sort for the `LIMIT 1` pattern because SQLite can scan the index in reverse order.

5. **brain.db vs tasks.db**: These are separate database files with separate migration systems. brain.db indexes are managed via `brain-schema.ts` / `brain-sqlite.ts`; ensure the brain.db migration path is used for INDEX 9 and INDEX 10.

6. **No benchmark data available**: This analysis is based on static query pattern review. Before the implementation task, a benchmark using `EXPLAIN QUERY PLAN` on the live `.cleo/tasks.db` would confirm which indexes SQLite actually selects and quantify the scan reduction.
