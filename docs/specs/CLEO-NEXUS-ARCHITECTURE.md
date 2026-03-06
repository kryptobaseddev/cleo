# CLEO NEXUS Specification

**Version**: 2026.3
**Status**: APPROVED
**Date**: 2026-03-05
**Task**: T5372

---

## 1. Overview

NEXUS is CLEO's cross-project coordination layer. It maintains a global registry of all CLEO-managed projects, enabling cross-project dependency analysis, critical path calculation, and orphan detection across a developer's entire project portfolio.

The registry lives at `~/.cleo/nexus.db` (SQLite) and is accessible from any CLEO-managed project. Each project MUST register itself with NEXUS on initialization and reconcile its identity on upgrade.

NEXUS operates on a portability model where each project's `.cleo/` directory travels with the project (containing `project-info.json` with a stable UUID), while the global registry at `~/.cleo/nexus.db` stores machine-specific path mappings. When a project moves to a new filesystem location, the reconciliation protocol detects the path change and updates the global registry without losing the project's identity or audit history.

NEXUS enables three primary capabilities: (1) unified task querying across project boundaries using `project:taskId` syntax, (2) cross-project dependency graph construction for critical path and blocker analysis, and (3) orphan detection for broken cross-project references. These capabilities are exposed through 31 MCP operations organized into core registry operations and `nexus.share.*` relay operations.

The relationship between NEXUS and other CLEO databases is complementary: `tasks.db` stores per-project task state (portable), `brain.db` stores cognitive memory (portable), and `nexus.db` stores the global project index (machine-specific). NEXUS reads from project-local `tasks.db` files during sync operations but never writes to them.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **projectId** | UUID (v4) assigned at project creation. Stored in `.cleo/project-info.json`. Stable across path moves. Primary identity key. |
| **projectHash** | `SHA-256(absolutePath).substring(0, 12)`. Path-derived, changes on move. Used as unique index for fast lookups. |
| **registry** | The `project_registry` table in `~/.cleo/nexus.db`. |
| **reconcile** | Process of verifying a project's identity against the global registry and resolving discrepancies via the 4-scenario policy. |
| **orphan** | A cross-project dependency reference pointing to a project not present in the registry. |
| **critical path** | The longest dependency chain across registered projects that determines minimum completion sequence. |
| **permission level** | Access tier assigned to a project: `read`, `write`, or `execute`. |
| **health status** | Registry-tracked project state: `unknown`, `healthy`, `degraded`, or `unreachable`. |

---

## 3. Storage Model

NEXUS uses SQLite at `~/.cleo/nexus.db` -- a global file outside any project directory. The database is managed via Drizzle ORM with migrations stored in `drizzle-nexus/`.

### 3.1 Tables

#### 3.1.1 project_registry

Central registry of all CLEO projects known to the NEXUS.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `project_id` | text | PRIMARY KEY | UUID (v4), stable across path moves |
| `project_hash` | text | NOT NULL, UNIQUE | SHA-256(path).substring(0,12) |
| `project_path` | text | NOT NULL, UNIQUE | Absolute filesystem path |
| `name` | text | NOT NULL | Human-readable project name |
| `registered_at` | text | NOT NULL, DEFAULT datetime('now') | ISO 8601 registration timestamp |
| `last_seen` | text | NOT NULL, DEFAULT datetime('now') | ISO 8601 last reconciliation timestamp |
| `health_status` | text | NOT NULL, DEFAULT 'unknown' | One of: unknown, healthy, degraded, unreachable |
| `health_last_check` | text | nullable | ISO 8601 timestamp of last health check |
| `permissions` | text | NOT NULL, DEFAULT 'read' | One of: read, write, execute |
| `last_sync` | text | NOT NULL, DEFAULT datetime('now') | ISO 8601 last metadata sync timestamp |
| `task_count` | integer | NOT NULL, DEFAULT 0 | Cached count of tasks in project |
| `labels_json` | text | NOT NULL, DEFAULT '[]' | JSON array of unique task labels |

**Indexes**: `idx_project_registry_hash` (projectHash), `idx_project_registry_health` (healthStatus), `idx_project_registry_name` (name).

#### 3.1.2 nexus_audit_log

Append-only audit log for all NEXUS operations across projects.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | text | PRIMARY KEY | UUID (v4), unique per audit entry |
| `timestamp` | text | NOT NULL, DEFAULT datetime('now') | ISO 8601 event timestamp |
| `action` | text | NOT NULL | Operation action name (e.g., register, sync, reconcile) |
| `project_hash` | text | nullable | Hash of affected project |
| `project_id` | text | nullable | UUID of affected project |
| `domain` | text | nullable | Always 'nexus' for nexus operations |
| `operation` | text | nullable | MCP operation name |
| `session_id` | text | nullable | Active session ID if available |
| `request_id` | text | nullable | MCP request correlation ID |
| `source` | text | nullable | Operation source (mcp, cli, internal) |
| `gateway` | text | nullable | Gateway type (query, mutate) |
| `success` | integer | nullable | 1 for success, 0 for failure |
| `duration_ms` | integer | nullable | Operation duration in milliseconds |
| `details_json` | text | DEFAULT '{}' | JSON object with operation-specific details |
| `error_message` | text | nullable | Error description on failure |

**Indexes**: `idx_nexus_audit_timestamp` (timestamp), `idx_nexus_audit_action` (action), `idx_nexus_audit_project_hash` (projectHash), `idx_nexus_audit_project_id` (projectId), `idx_nexus_audit_session` (sessionId).

#### 3.1.3 nexus_schema_meta

Key-value store for nexus.db schema versioning and metadata.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `key` | text | PRIMARY KEY | Metadata key |
| `value` | text | NOT NULL | Metadata value |

### 3.2 Initialization

`nexusInit()` MUST be called before any registry operation. It is idempotent and safe to call multiple times. On first call:

1. Creates the `~/.cleo/nexus/` directory and `~/.cleo/nexus/cache/` subdirectory.
2. Initializes `nexus.db` via Drizzle ORM (runs pending migrations).
3. Checks if `project_registry` is empty. If so, calls `migrateJsonToSqlite()` to import from any legacy `~/.cleo/projects-registry.json` file.

---

## 4. Identity Model

### 4.1 projectId (Primary Identifier)

`projectId` is a UUID (v4) assigned at project creation time and stored in `.cleo/project-info.json`. It is the **stable** identifier -- it does NOT change when a project moves to a new path.

`projectId` MUST be used as the database primary key and as the stable reference in cross-project dependencies.

### 4.2 projectHash (Path-Derived Index)

`projectHash` = `SHA-256(absolutePath).substring(0, 12)`. It provides a short, unique index for fast lookups but MUST NOT be used as a stable reference across path changes.

The hash is a 12-character lowercase hexadecimal string validated by the pattern `/^[a-f0-9]{12}$/`.

When a project moves, its `projectHash` changes but its `projectId` remains constant.

### 4.3 Portability Contract

The `.cleo/` directory is portable -- it moves with the project. The global registry (`~/.cleo/nexus.db`) stores path-dependent data. When a project moves:

1. The project's `.cleo/project-info.json` retains the same `projectId`.
2. The global registry MUST be updated via `nexus.reconcile` to reflect the new path and hash.
3. Cross-project dependency references using `projectId` remain valid without updates.

---

## 5. Registration and Reconciliation Lifecycle

### 5.1 Auto-Registration

Projects MUST be registered on `cleo init` and reconciled on `cleo upgrade`. Both entry points call `nexusReconcile()`.

Registration validates that the target path contains a readable CLEO project (has `.cleo/tasks.db`) before inserting into the registry. If the project lacks task data, registration fails with exit code 1 (NOT_FOUND).

### 5.2 Reconciliation Policy

`nexusReconcile(projectRoot)` implements a 4-scenario handshake:

| Scenario | Condition | Action | Result |
|---|---|---|---|
| **ok** | `projectId` in registry, path matches | Update `lastSeen` | `{status: 'ok'}` |
| **path_updated** | `projectId` in registry, path differs | Update path + hash + `lastSeen` | `{status: 'path_updated', oldPath, newPath}` |
| **auto_registered** | `projectId` not in registry | Register project via `nexusRegister()` | `{status: 'auto_registered'}` |
| **identity_conflict** | `projectHash` matches but different `projectId` | Throw `CleoError(75)` | Error: manual resolution required |

The reconciliation algorithm proceeds in order:

1. **Conflict check**: If the current `projectHash` exists in the registry with a different `projectId`, throw identity conflict (exit code 75).
2. **Stable lookup**: Search by `projectId`. If found and path matches, scenario 1. If found and path differs, scenario 2.
3. **Hash fallback**: For projects without a `projectId` in `project-info.json`, fall back to hash-based lookup.
4. **Auto-register**: If no match found by either key, register the project as new.

### 5.3 Conflict Resolution

Identity conflicts (scenario 4) indicate registry corruption or a hash collision. The developer MUST manually run `nexus.unregister` for the conflicting entry followed by `nexus.register` to resolve the conflict. The conflict is logged to the audit trail with `success: false` before the error is thrown.

---

## 6. Operation Surface

NEXUS exposes 17 query and 14 mutate operations through the MCP gateway (31 total). All operations are tier 2 except `nexus.reconcile` which is tier 1.

### 6.1 Query Operations (17)

#### Core Registry Queries

| Operation | Tier | Description |
|---|---|---|
| `nexus.status` | 2 | Overall NEXUS health status |
| `nexus.list` | 2 | List all registered NEXUS projects |
| `nexus.show` | 2 | Show a specific project by name or hash |
| `nexus.query` | 2 | Resolve a cross-project `project:taskId` query |
| `nexus.search` | 2 | Search for patterns across registered projects |
| `nexus.discover` | 2 | Discover related tasks across registered projects |

#### Dependency Analysis Queries

| Operation | Tier | Description |
|---|---|---|
| `nexus.deps` | 2 | Cross-project dependency analysis |
| `nexus.graph` | 2 | Global dependency graph across all projects |
| `nexus.critical-path` | 2 | Global critical path across all registered projects |
| `nexus.blocking` | 2 | Blocking impact analysis for a task |
| `nexus.orphans` | 2 | Detect broken cross-project dependency references |
| `nexus.path.show` | 2 | Show critical dependency path across projects |
| `nexus.blockers.show` | 2 | Show blocking impact for a task query |
| `nexus.orphans.list` | 2 | List orphaned cross-project dependencies |

#### Sharing Queries

| Operation | Tier | Description |
|---|---|---|
| `nexus.share.status` | 2 | Sharing status for current project |
| `nexus.share.remotes` | 2 | List configured remotes |
| `nexus.share.sync.status` | 2 | Sync status with remotes |

### 6.2 Mutate Operations (14)

#### Core Registry Mutations

| Operation | Tier | Description |
|---|---|---|
| `nexus.init` | 2 | Initialize NEXUS (creates registry and directories) |
| `nexus.register` | 2 | Register a project in NEXUS |
| `nexus.unregister` | 2 | Remove a project from NEXUS |
| `nexus.sync` | 2 | Sync project metadata (task count, labels) |
| `nexus.sync.all` | 2 | Sync all registered projects |
| `nexus.permission.set` | 2 | Update project permissions |
| `nexus.reconcile` | 1 | Reconcile project identity with global nexus registry |

#### Sharing Mutations

| Operation | Tier | Description |
|---|---|---|
| `nexus.share.snapshot.export` | 2 | Export project snapshot |
| `nexus.share.snapshot.import` | 2 | Import project snapshot |
| `nexus.share.sync.gitignore` | 2 | Sync gitignore for shared files |
| `nexus.share.remote.add` | 2 | Add a remote for sharing |
| `nexus.share.remote.remove` | 2 | Remove a remote |
| `nexus.share.push` | 2 | Push to remote |
| `nexus.share.pull` | 2 | Pull from remote |

---

---

## 7. Cross-Project Discovery (Graph-RAG)

The `nexus.discover` operation implements Graph-RAG (Graph Retrieval-Augmented Generation) for finding related tasks across registered projects. Discovery uses multiple similarity methods combined with hierarchical proximity scoring.

### Discovery Methods

| Method | Algorithm | Score Range | Description |
|--------|-----------|-------------|-------------|
| `labels` | Jaccard similarity | 0.0-1.0 | Matches tasks by shared label overlap |
| `description` | Tokenized Jaccard | 0.0-1.0 | Keyword extraction from title + description |
| `files` | File path overlap | 0.0-1.0 | Matches tasks referencing same files |
| `hierarchy` | Fixed boosts | 0.08-0.15 | Siblings (0.15) and cousins (0.08) |
| `auto` | Weighted combination | 0.0-1.0 | Combines all methods with hierarchy boosts |

### Auto Mode Scoring

The default `auto` method combines results from all discovery methods:

1. **Base Scores**: Highest score per task from labels/description/files
2. **Hierarchy Boost**: Adds sibling (0.15) or cousin (0.08) proximity bonus
3. **Cap**: Final score capped at 1.0
4. **Sort**: Results sorted by score descending

### Example Output

```json
{
  "results": [
    {
      "project": "backend-api",
      "taskId": "T042",
      "title": "Implement auth middleware",
      "score": 0.85,
      "type": "labels",
      "reason": "3 shared label(s): auth, security, middleware"
    }
  ]
}
```

---

## 8. Logging and Audit Model

### 7.1 Operational Logging

All nexus operations emit structured Pino logs via `getLogger('nexus')`. Log level: `info` for successful operations, `warn` for non-fatal failures (including audit write failures).

### 7.2 Audit Trail

All mutate operations write to `nexus_audit_log` in nexus.db via `writeNexusAudit()`. Each audit entry includes correlation fields for tracing:

- **id**: UUID (v4) unique to this audit entry
- **timestamp**: ISO 8601 datetime (defaults to current time)
- **action**: The operation performed (register, unregister, sync, reconcile, etc.)
- **projectHash**: Hash of the affected project (nullable for global operations like sync-all)
- **projectId**: UUID of the affected project (nullable)
- **domain**: Always `'nexus'`
- **operation**: MCP operation name
- **sessionId**: Active CLEO session ID if available
- **requestId**: MCP request correlation ID if available
- **source**: Operation source (mcp, cli, internal)
- **gateway**: Gateway type (query, mutate)
- **success**: Boolean (stored as integer: 1 or 0)
- **durationMs**: Operation duration in milliseconds
- **detailsJson**: JSON object with operation-specific details (e.g., `{status: 'path_updated', oldPath, newPath}`)
- **errorMessage**: Error description on failure

Audit failures MUST NOT interrupt primary operations. The `writeNexusAudit()` function catches all errors and logs them as warnings via Pino. This ensures that audit infrastructure issues never break registry operations.

---

## 9. Migration Plan

### 9.1 Legacy JSON Migration

For projects using the legacy `~/.cleo/projects-registry.json` backend, NEXUS automatically migrates on first initialization:

1. `nexusInit()` detects an empty `project_registry` table.
2. Calls `migrateJsonToSqlite()` which reads the JSON file.
3. For each project entry, reads the target project's `.cleo/project-info.json` for a stable `projectId`. Falls back to a newly generated UUID if `project-info.json` is absent.
4. Upserts each entry into `project_registry` (on conflict by `projectHash`: updates path, name, and `lastSeen`).
5. Renames `projects-registry.json` to `projects-registry.json.migrated`.
6. Logs migration count via Pino.

### 9.2 Rollback

The `.migrated` file is retained for recovery. To roll back:

1. Rename `projects-registry.json.migrated` back to `projects-registry.json`.
2. Delete or reset `~/.cleo/nexus.db`.
3. On next `nexusInit()`, the migration will re-run from the restored JSON file.

---

## 10. Failure and Recovery Semantics

### 10.1 Exit Codes

NEXUS operations use exit codes 70-79:

| Code | Name | Description |
|---|---|---|
| 70 | NEXUS_NOT_INITIALIZED | Registry not initialized; run `cleo nexus init` |
| 71 | NEXUS_PROJECT_NOT_FOUND | Referenced project not in registry |
| 72 | NEXUS_PERMISSION_DENIED | Operation exceeds project permission level |
| 73 | NEXUS_INVALID_SYNTAX | Malformed cross-project query syntax |
| 74 | NEXUS_SYNC_FAILED | Metadata sync operation failed |
| 75 | NEXUS_REGISTRY_CORRUPT | Identity conflict detected during reconciliation |
| 76 | NEXUS_PROJECT_EXISTS | Project already registered (duplicate registration attempt) |
| 77 | NEXUS_QUERY_FAILED | Cross-project query execution failed |
| 78 | NEXUS_GRAPH_ERROR | Dependency graph construction failed |
| 79 | NEXUS_RESERVED | Reserved for future use |

### 10.2 Conflict Policy

Identity conflicts exit with code 75 (`NEXUS_REGISTRY_CORRUPT`). This occurs when `nexusReconcile()` detects that the current path's `projectHash` is already registered to a different `projectId`. Manual resolution: run `nexus.unregister` for the conflicting entry, then `nexus.register` for the current project.

### 10.3 Orphan Detection

`nexus.orphans` scans all cross-project dependency references and returns entries where the referenced project is not in the registry. Each orphan entry includes a `reason` field explaining why the reference is broken.

### 10.4 Database Recovery

If `~/.cleo/nexus.db` is corrupt or missing, `nexusInit()` recreates it from the Drizzle schema and runs `migrateJsonToSqlite()` if the legacy JSON backup (`.migrated` or original) exists. The migration is idempotent: it checks for an empty `project_registry` before attempting import.

---

## 11. Portability Guarantees

| Data | Location | Portable? | Notes |
|---|---|---|---|
| Project identity (`projectId`) | `.cleo/project-info.json` | Yes | Moves with project |
| Task database | `.cleo/tasks.db` | Yes | Moves with project |
| Brain database | `.cleo/brain.db` | Yes | Moves with project |
| Global registry | `~/.cleo/nexus.db` | No | Machine-specific, global |
| Audit log | `~/.cleo/nexus.db` (nexus_audit_log) | No | Machine-specific, global |
| NEXUS cache | `~/.cleo/nexus/cache/` | No | Regenerable |

Projects SHOULD call `nexus.reconcile` after moving to a new path to update the global registry. Cross-project dependency references using `projectId` remain valid across moves without requiring updates to the referencing project.

---

## References

- [CLEO-OPERATION-CONSTITUTION.md](CLEO-OPERATION-CONSTITUTION.md) -- Full operation listing across all domains
- [VERB-STANDARDS.md](VERB-STANDARDS.md) -- Canonical verb definitions
- [CLEO-BRAIN-SPECIFICATION.md](CLEO-BRAIN-SPECIFICATION.md) -- Related storage pattern (brain.db)
- [CLEO-SYSTEM-FLOW-ATLAS.md](../concepts/CLEO-SYSTEM-FLOW-ATLAS.md) -- Workshop vocabulary and system architecture
- [CLEO-VISION.md](../concepts/CLEO-VISION.md) -- Workshop language documentation
- Task T5372 -- Implementation task for this specification
- Task T5365 -- nexus.db schema definition (nexus-schema.ts)
- Task T5366 -- Core registry operations (registry.ts)
- Task T5368 -- Reconciliation protocol (nexusReconcile)
- Task T4529 -- Graph-RAG discovery algorithms (src/core/tasks/graph-rag.ts)
