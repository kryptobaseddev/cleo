# CLEO NEXUS Specification

**Status**: APPROVED

---

## 1. Overview

NEXUS is CLEO's cross-project layer. It has two parts:

1. **The project registry** — a machine-wide index of every CLEO project, keyed by each project's tracked identity. It backs cross-project task queries (`project:T###`), cross-project dependency analysis (critical path, blockers, orphans) and project discovery.
2. **The code-intelligence graph** — the symbols, relations and contracts of one project's source, built by `cleo nexus analyze` and read by `cleo nexus context`, `impact`, `search-code` and related verbs.

The two parts live in different stores (ADR-090):

- The registry is cross-project, so it lives in the **global** `<cleoHome>/cleo.db`.
- The graph belongs to one project, so it lives in that project's `<projectRoot>/.cleo/cleo.db` and travels with the project.

`<cleoHome>` is `~/.local/share/cleo` on Linux and `~/Library/Application Support/cleo` on macOS; `CLEO_HOME` overrides it. The store model is specified in [database-architecture](database-architecture.md).

NEXUS is reached through the CLI (`cleo nexus <verb>`, §7). It reads each registered project's task store when it syncs, queries or discovers across projects; only `cleo nexus transfer` writes tasks into another project.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **projectId** | The project's identity, read from the tracked `.cleo/project.json`, else the legacy `.cleo/project-id`; `.cleo/project-info.json` is only a cache used when nothing is tracked yet. Written once, stable across moves. Must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. |
| **projectHash** | `SHA-256(path).substring(0, 12)` of the canonical (`realpath`) project path. Path-derived; changes when the project moves. A lookup aid, never an identity. |
| **registry** | The `nexus_project_registry` table in the global `cleo.db`. |
| **location** | A (projectId, device, path) row in `nexus_project_locations`, with state `live`, `missing`, `superseded` or `candidate`. |
| **reconcile** | Checking the current checkout against the registry and updating the row (§6.2). |
| **orphan** | A cross-project dependency whose target project is not registered, or whose target task does not exist. |
| **critical path** | The longest dependency chain across registered projects. |
| **permission level** | A project's access tier: `read`, `write` or `execute` (default `read`). |
| **health status** | `unknown`, `healthy`, `degraded` or `unreachable` (default `unknown`). |

---

## 3. Storage model

### 3.1 Residency

| Scope | File | NEXUS tables |
|---|---|---|
| Global | `<cleoHome>/cleo.db` | `nexus_project_registry`, `nexus_project_id_aliases`, `nexus_project_paths`, `nexus_project_locations`, `nexus_devices`, `nexus_project_git_state`, `nexus_audit_log`, `nexus_schema_meta`, `nexus_user_profile`, `nexus_sigils` |
| Project | `<projectRoot>/.cleo/cleo.db` | `nexus_nodes`, `nexus_relations`, `nexus_relation_weights`, `nexus_contracts`, `nexus_code_index` |

Schemas: `packages/core/src/store/schema/cleo-global/nexus.ts` and `packages/core/src/store/schema/cleo-project/nexus-graph.ts`. The graph tables have no `project_id` column; scope is implied by which project's `cleo.db` is open.

The `drizzle-nexus` migration lineage adds what the consolidated migrations do not model: the `nexus_symbols_fts` FTS5 table and its triggers on `nexus_nodes`, `nexus_relation_weights`, and the `_nexus_meta` health-probe table.

### 3.2 Accessor

`getNexusDb()` (`packages/core/src/store/nexus-sqlite.ts`) opens the project `cleo.db` as `main` through `openDualScopeDb('project')` and `ATTACH`es the global `cleo.db` as `nexus_global`. A bare table name resolves to `main` first, so graph tables are read from the project file and registry tables fall through to the global file. The global file may still hold empty graph tables from an earlier migration; `main` shadows them. `cleo doctor nexus-residency` reports NEXUS tables found in the wrong scope (read-only).

### 3.3 `nexus_project_registry`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `project_id` | text | PRIMARY KEY | projectId |
| `project_hash` | text | NOT NULL | projectHash of `project_path` |
| `project_path` | text | NOT NULL | Absolute path of the checkout seen most recently |
| `name` | text | NOT NULL | Display name; unique among registered projects (enforced at registration) |
| `registered_at` | text | NOT NULL, DEFAULT `datetime('now')` | Registration time |
| `last_seen` | text | NOT NULL, DEFAULT `datetime('now')` | Last reconcile |
| `health_status` | text | NOT NULL, DEFAULT `'unknown'` | Health status |
| `health_last_check` | text | nullable | Last health check |
| `permissions` | text | NOT NULL, DEFAULT `'read'` | Permission level |
| `last_sync` | text | NOT NULL, DEFAULT `datetime('now')` | Last metadata sync |
| `task_count` | integer | NOT NULL, DEFAULT 0 | Cached task count |
| `labels_json` | text | NOT NULL, DEFAULT `'[]'` | JSON array of task labels |
| `brain_db_path` | text | nullable | The project store path (`<path>/.cleo/cleo.db`) |
| `tasks_db_path` | text | nullable | The project store path (`<path>/.cleo/cleo.db`) |
| `last_indexed` | text | nullable | Last code-graph index |
| `stats_json` | text | NOT NULL, DEFAULT `'{}'` | Index statistics |
| `last_probed_at` | text | nullable | Last git-state probe |
| `last_opened_at` | text | nullable | Last open |

**Indexes** (non-unique): `idx_nexus_project_registry_hash`, `_path`, `_health`, `_name`, `_last_indexed`, `_last_opened`.

The other global tables:

- `nexus_project_id_aliases` maps a legacy or path-derived id to its canonical projectId.
- `nexus_project_paths` records every path a project was seen at.
- `nexus_project_locations` and `nexus_devices` record each checkout per device.
- `nexus_project_git_state` holds the last git probe per checkout (branch, head, dirty count, ahead/behind).
- `nexus_user_profile` and `nexus_sigils` hold peer profile and sigil rows.

### 3.4 `nexus_audit_log`

| Column | Type | Description |
|---|---|---|
| `id` | text PRIMARY KEY | UUID per entry |
| `timestamp` | text NOT NULL, DEFAULT `datetime('now')` | Event time |
| `action` | text NOT NULL | e.g. `register`, `reconcile`, `set-permission` |
| `project_hash` | text | Affected project's hash |
| `project_id` | text | Affected projectId |
| `domain` | text | Always `nexus` |
| `operation` | text | Operation name |
| `session_id` | text | Session id, when known |
| `request_id` | text | Request correlation id, when known |
| `source` | text | Caller source, when known |
| `gateway` | text | Gateway, when known |
| `success` | integer | 1 success, 0 failure |
| `duration_ms` | integer | Duration |
| `details_json` | text, DEFAULT `'{}'` | Operation details (redacted column) |
| `error_message` | text | Error text (redacted column) |
| `uid` | text | Row uid (unique index `uq_nexus_audit_log_uid`) |

**Indexes**: `idx_nexus_audit_timestamp`, `idx_nexus_audit_action`, `idx_nexus_audit_project_hash`, `idx_nexus_audit_project_id`, `idx_nexus_audit_session`.

### 3.5 Initialization

`nexusInit()` (`packages/core/src/nexus/registry.ts`) is idempotent. It:

1. Creates the NEXUS home `<cleoHome>/nexus/` and its `cache/` subdirectory (overridable with `NEXUS_HOME` and `NEXUS_CACHE_DIR`).
2. Opens the stores through `getNexusDb()`, which runs pending migrations.
3. If `nexus_project_registry` is empty, runs `migrateJsonToSqlite()` to import a legacy `projects-registry.json` (§10).

---

## 4. Identity model

### 4.1 projectId

The projectId is the only identity. NEXUS reads it from the tracked `.cleo/project.json` (or the legacy `.cleo/project-id`) through `readPortableProjectId`, and falls back to the `project-info.json` cache only when nothing is tracked (`readProjectId`, `packages/core/src/nexus/registry.ts`). It is the registry primary key and the stable reference in cross-project dependencies.

Reconcile never mints an identity. A project that declares none is refused with a fix that says to run `cleo init`. Minting happens only in `cleo init`, `cleo nexus register` or `cleo doctor project-identity --resolve`.

### 4.2 projectHash

`generateProjectHash(path)` (`packages/core/src/nexus/hash.ts`) returns the first 12 hex characters of `SHA-256(path)`. Registration hashes the `realpath` of the project, so relative and symlinked spellings produce one hash. Because the hash follows the path, it is never used as an identity or ownership key.

### 4.3 Portability

The project's `.cleo/` moves with it: the tracked identity files and the project `cleo.db`, including its code graph. Only the global registry row is machine-specific. After a move, reconcile (§6.2) updates the row's path and hash, and cross-project references by projectId stay valid.

---

## 5. Permissions

`packages/core/src/nexus/permissions.ts` orders the levels `read` < `write` < `execute`. A cross-project operation requires the target project's granted level to meet the required level; operations inside one project always have full permission. `cleo nexus permission set` changes a project's level and writes a `set-permission` audit entry.

---

## 6. Registration and reconciliation

### 6.1 Registration

- `cleo init` calls `nexusReconcile()` through `initNexusRegistration` (`packages/core/src/init.ts`). A project under a temp directory is not auto-registered; it can still be registered with `cleo nexus register`.
- `cleo upgrade` records an encounter instead. The encounter never mints an identity and never moves an existing row to this checkout.
- `nexusRegister()` requires the path to contain a `.cleo/` directory and fails with `NOT_FOUND` otherwise. It refuses a display name another project already holds (`VALIDATION_ERROR`). It records the path fingerprint and legacy id as aliases.

### 6.2 Reconciliation

`nexusReconcile(projectRoot)` looks the project up by projectId alone. The path and its hash are never consulted for ownership.

| Status | Condition | Action |
|---|---|---|
| `ok` | projectId registered, path matches | Update `last_seen`; record the checkout |
| `path_updated` | projectId registered, path differs, old path gone or superseded | Update path, hash, `last_seen` and store paths |
| `candidate` | projectId registered, path differs, old path still exists on this device | Record this checkout as a `candidate` location; the row is NOT repointed |
| `auto_registered` | projectId not registered | Register via `nexusRegister()` |

A `candidate` result is a second checkout or a clone, not a move. `cleo init` prints a warning naming `cleo doctor project-identity --resolve` or `--force-rebind` to make this checkout the owner.

A registry row at this path under a different projectId is not a conflict. It is a stale location of another project and is marked `superseded` in `nexus_project_locations`.

Every reconcile writes a `reconcile` audit entry with the status in `details_json`.

---

## 7. CLI surface

All NEXUS operations run through `cleo nexus <verb>`. Run `cleo nexus <verb> --help` for flags.

### 7.1 Registry

| Verb | Purpose |
|---|---|
| `init` | Create the NEXUS directories and registry |
| `register` / `unregister` | Add or remove a project |
| `list`, `show` | List projects; show one by name |
| `sync [PROJECT]` | Refresh task count and labels (default: all projects) |
| `reconcile` | Reconcile the current project (§6.2) |
| `permission set` | Set a project's permission level |
| `projects list\|register\|remove\|scan\|clean\|status` | Registry management; `scan` finds unregistered `.cleo/` directories, `status` is the fleet view per device, `clean` bulk-purges rows (always run `--dry-run` first) |

### 7.2 Cross-project tasks

| Verb | Purpose |
|---|---|
| `resolve` | Resolve `project:T###` or `T###` across projects |
| `search` | Search tasks across projects by pattern |
| `discover` | Find related tasks across projects (§8) |
| `deps`, `graph`, `critical-path`, `blocking`, `orphans` | Cross-project dependency analysis |
| `transfer-preview`, `transfer` | Move tasks between projects (`transfer-preview` is a dry run) |
| `share export\|import`, `share-status` | Snapshot sharing for multiple contributors |

### 7.3 Code intelligence

| Verb | Purpose |
|---|---|
| `analyze [PATH]` | Build the code graph for a repository |
| `status` | Index freshness: file, node and relation counts, last indexed time, stale files |
| `context`, `impact`, `impact-full`, `full-context`, `why` | Callers, callees and blast radius of a symbol, alone or merged with tasks and memory |
| `search-code`, `query` | BM25 symbol search; recursive CTE queries over the graph |
| `clusters`, `flows`, `wiki`, `route-map`, `shape-check`, `contracts` | Communities, execution flows, wiki index, routes and contract checks |
| `diff`, `affected` | Index changes between commits; tests and symbols a change reaches |
| `task-footprint`, `task-symbols`, `brain-anchors` | Links between tasks, memory and symbols |
| `hot-paths`, `hot-nodes`, `cold-symbols`, `top-entries` | Plasticity weights |
| `hooks`, `auto-reindex`, `reindex-on-merge` | Keep the index current from git hooks |
| `augment`, `setup` | PreToolUse hook augmenter |
| `refresh-bridge`, `export` | Regenerate `.cleo/nexus-bridge.md`; export the graph to GEXF or JSON |
| `sigil` | Sigil (peer-card) rows |

---

## 8. Cross-project discovery

`cleo nexus discover <query> [--method labels|description|files|auto] [--limit N]` runs `discoverRelated()` (`packages/core/src/nexus/discover.ts`). The default method is `auto` and the default limit is 10.

1. The query must be a single task (`T001`, `project:T001` or `.:T001`); a wildcard `*:T001` is refused.
2. For each registered project, every task except the source is scored:
   - **labels** (`labels`, `auto`): shared labels ÷ the larger of the two label-set sizes.
   - **description** (`description`, `auto`): shared keywords (title + description, stop words removed) ÷ the larger keyword count.
   - In `auto` mode the higher of the two scores wins and sets the match `type`.
3. Tasks with a score above 0 are returned, rounded to two decimals, highest first.

The `files` method is accepted but has no scoring branch, so it returns no results. A project whose tasks cannot be read is skipped.

```json
{
  "query": "web-app:T017",
  "method": "auto",
  "results": [
    {
      "project": "backend-api",
      "taskId": "T042",
      "title": "Implement auth middleware",
      "score": 0.75,
      "type": "labels",
      "reason": "Shared labels: auth, security, middleware"
    }
  ],
  "total": 1
}
```

---

## 9. Logging and audit

All NEXUS operations log through `getLogger('nexus')`.

Registry mutations write to `nexus_audit_log` through `writeNexusAudit()` (`packages/core/src/nexus/registry.ts`), with the fields in §3.4. An audit failure is caught and logged as a warning; it never fails the operation.

---

## 10. Legacy JSON registry migration

When `nexus_project_registry` is empty, `nexusInit()` runs `migrateJsonToSqlite()` (`packages/core/src/nexus/migrate-json-to-sqlite.ts`) against `<cleoHome>/projects-registry.json` (overridable with `NEXUS_REGISTRY_FILE`):

1. For each entry, it reads the target project's declared id from `.cleo/project.json`, then `.cleo/project-id`, then `.cleo/project-info.json`.
2. If the project declares none, it falls back to a new random UUID.
3. On success it renames the file to `projects-registry.json.migrated`, which prevents a second import and is kept for recovery.

---

## 11. Failure semantics

### 11.1 Exit codes

NEXUS errors use exit codes 70-79 (`packages/contracts/src/exit-codes.ts`):

| Code | Name |
|---|---|
| 70 | `NEXUS_NOT_INITIALIZED` |
| 71 | `NEXUS_PROJECT_NOT_FOUND` |
| 72 | `NEXUS_PERMISSION_DENIED` |
| 73 | `NEXUS_INVALID_SYNTAX` |
| 74 | `NEXUS_SYNC_FAILED` |
| 75 | `NEXUS_REGISTRY_CORRUPT` |
| 76 | `NEXUS_PROJECT_EXISTS` |
| 77 | `NEXUS_QUERY_FAILED` |
| 78 | `NEXUS_GRAPH_ERROR` |
| 79 | `NEXUS_IMPACT_CRITICAL` |

Code 111, `NEXUS_INDEX_STALE` (`E_NEXUS_INDEX_STALE`), refuses a graph answer when the index trails the checked-out HEAD by more than `nexus.freshness.maxCommitsBehind` commits, or when the queried symbol is missing from an index that is stale for this checkout. `error.fix` names the reindex command. `--allow-stale` (or `CLEO_NEXUS_ALLOW_STALE=1`) accepts the stale answer.

### 11.2 Orphans

`cleo nexus orphans` returns cross-project dependency references whose target is broken, each with a `reason`: `project_not_registered` or `task_not_found` (`packages/core/src/nexus/deps.ts`).

### 11.3 Recovery

- The registry is store data. It is backed up and restored with the global `cleo.db` (see [database-architecture](database-architecture.md) §8.3).
- `cleo doctor projects` checks machine-wide registry integrity: it rebinds moved projects by id and flags split, missing, temp and home/root rows. It is a dry run unless `--apply`, and `--rollback <receiptId>` restores the prior rows.
- The code graph is derived from source. `cleo nexus analyze` rebuilds it.

---

## 12. Portability guarantees

| Data | Location | Portable? |
|---|---|---|
| Project identity | `.cleo/project.json` (+ legacy `.cleo/project-id`), tracked in git | Yes |
| Tasks, memory, docs | `<projectRoot>/.cleo/cleo.db` | Yes (moves with the directory; never committed) |
| Code graph | `<projectRoot>/.cleo/cleo.db` (`nexus_*` graph tables) | Yes; rebuildable with `cleo nexus analyze` |
| Project registry, locations, audit log | `<cleoHome>/cleo.db` | No — machine-specific |
| NEXUS cache | `<cleoHome>/nexus/cache/` | No — regenerable |

After moving a project, run `cleo nexus reconcile` (or `cleo init`) to update the registry. References by projectId need no update.

---

## References

- [database-architecture](database-architecture.md) — Store model: the two `cleo.db` files
- [CLEO-OPERATION-CONSTITUTION.md](cleo-operation-constitution.md) — Operation listing across all domains
- [VERB-STANDARDS.md](verb-standards.md) — Canonical verb definitions
- [CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md](cleo-portable-project-brain.md) — Portable project brain
- [CLEO architecture guide](../concept/cleo-architecture-guide.md) — Workshop vocabulary, systems and request flow
- ADR-090 — NEXUS graph residency split: `cleo docs fetch adr-090-nexus-graph-residency-split`
- [ADR-072](../adr/ADR-072-nexus-db-split.md) — Superseded by ADR-090
- [ADR-036](../adr/adr-036-cleoos-database-topology.md) — Superseded; its global-only NEXUS rule no longer holds for the graph tables
