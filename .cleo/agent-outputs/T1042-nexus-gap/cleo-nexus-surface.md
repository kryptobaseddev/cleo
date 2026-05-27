# cleo nexus — Complete Surface Documentation

**Task**: T1044 (Explorer/Researcher)
**Date**: 2026-04-20
**Source**: Live CLI + source read at v2026.4.100

---

## 1. CLI Surface

All subcommands live under `cleo nexus`. Two dispatch gateways: `query` (reads) and `mutate` (writes). The CLI handler is `packages/cleo/src/cli/commands/nexus.ts`; domain handler is `packages/cleo/src/dispatch/domains/nexus.ts`; engine wrapper is `packages/cleo/src/dispatch/engines/nexus-engine.ts`.

### 1.1 Subcommand Table

| Subcommand | Gateway | Operation (dispatch) | Key Args / Flags | Description |
|---|---|---|---|---|
| `init` | mutate | `init` | — | Initialize NEXUS dirs (`~/.cleo/nexus/`, `~/.cleo/nexus/cache/`) and `nexus.db` |
| `register <PATH>` | mutate | `register` | `--name`, `--permissions=read\|write\|execute` | Register a project in the global registry |
| `unregister <NAMEORHASH>` | mutate | `unregister` | — | Remove a project from the registry |
| `list` | query | `list` | — | List all registered projects |
| `status [PATH]` | query | `status` | `--project-id`, `--json` | Code intelligence freshness: file/node/relation counts, last indexed. Falls back to registry status. |
| `show <NAME>` | query | `show` | — | Full details for a registered project by name |
| `resolve <TASKREF>` | query | `resolve` | — | Resolve `project:T###` or `*:T###` across registry |
| `discover <TASKQUERY>` | query | `discover` | `--method=labels\|description\|files\|auto`, `--limit=10` | Find related tasks across projects |
| `search <PATTERN>` | query | `search` | `--project`, `--limit=20` | Search task titles/descriptions across projects |
| `deps <TASKQUERY>` | query | `deps` | `--reverse` | Show cross-project task dependencies |
| `critical-path` | query | `path.show` | — | Global critical path across all registered projects |
| `blocking <TASKQUERY>` | query | `blockers.show` | — | Blocking impact analysis for a task |
| `orphans` | query | `orphans.list` | — | Detect broken cross-project dependency references |
| `sync [PROJECT]` | mutate | `sync` | — | Sync project metadata (task count, labels) for one or all projects |
| `reconcile` | mutate | `reconcile` | `--path` | Auto-register or update path if project was moved (4-scenario policy, uses `projectId` as stable key) |
| `graph` | query | `graph` | — | Full dependency graph across all registered projects |
| `share-status` | query | `share.status` | — | Multi-contributor sharing status for current project |
| `transfer-preview <TASKIDS> --from --to` | query | `transfer.preview` | `--mode=copy\|move`, `--scope=single\|subtree` | Dry-run preview of task transfer |
| `transfer <TASKIDS> --from --to` | mutate | `transfer` | `--mode=copy\|move`, `--scope=single\|subtree`, `--on-conflict=rename\|skip\|duplicate\|fail`, `--transfer-brain` | Transfer tasks between projects (copy or move, optionally migrate brain entries) |
| `permission set` | mutate | `permission.set` | `--name`, `--level=read\|write\|execute` | Set permission level for a registered project |
| `share export` | mutate | `share.snapshot.export` | `--output` | Export a snapshot of current project state for sharing |
| `share import` | mutate | `share.snapshot.import` | `--input` | Import a shared project snapshot |
| `clusters [PATH]` | (direct DB) | — | `--project-id`, `--json` | List all Louvain community nodes from last analysis |
| `flows [PATH]` | (direct DB) | — | `--project-id`, `--json` | List all execution flow (process) nodes from last analysis |
| `context <SYMBOL>` | (direct DB) | — | `--project-id`, `--json`, `--limit=20` | Callers, callees, community membership, process participation for a symbol |
| `impact <SYMBOL>` | (direct DB) | — | `--project-id`, `--json`, `--depth=3` | BFS blast-radius: d=1 (direct callers), d=2 (indirect), d=3 (transitive); risk level NONE/LOW/MEDIUM/HIGH/CRITICAL |
| `analyze [PATH]` | (direct DB + pipeline) | — | `--project-id`, `--json`, `--incremental` | Run full 6-phase code intelligence pipeline. Writes `nexus-bridge.md` and updates registry stats post-run. |
| `projects list` | (direct DB) | — | — | List all globally registered projects |
| `projects register` | (direct DB) | — | `--name`, `--permissions` | Register current directory in global registry |
| `projects remove` | (direct DB) | — | `<NAMEORHASH>` | Remove a project from global registry |
| `projects scan` | (direct DB) | — | `--roots`, `--max-depth=5`, `--include-existing`, `--auto-register`, `--json` | Walk filesystem to find unregistered `.cleo/` directories |
| `projects clean` | (direct DB) | — | path-filter flags | Bulk purge `project_registry` rows |
| `refresh-bridge [PATH]` | (direct DB) | — | `--project-id`, `--json` | Regenerate `.cleo/nexus-bridge.md` from existing `nexus.db` (no re-index) |
| `export` | (direct DB) | — | `--format=gexf\|json`, `--output`, `--project` | Export graph to GEXF (Gephi-compatible) or JSON |
| `diff` | (direct DB + pipeline) | — | `--before=HEAD~1`, `--after=HEAD`, `--path`, `--project-id`, `--json` | Compare index state between two git commits; runs incremental pipeline on `--after` ref |

**Note**: `clusters`, `flows`, `context`, `impact`, `analyze`, `projects *`, `refresh-bridge`, `export`, and `diff` bypass the dispatch layer and query `nexus.db` directly via `@cleocode/core/store/nexus-sqlite`. They also read from `@cleocode/nexus/pipeline` for the analysis steps. This is documented as intentional to avoid awkward coupling at the dispatch layer.

### 1.2 Dispatch-Layer Operations

The `NexusHandler` (`packages/cleo/src/dispatch/domains/nexus.ts`) exposes these operations formally:

**query**: `share.status`, `status`, `list`, `show`, `resolve`, `deps`, `graph`, `path.show`, `blockers.show`, `orphans.list`, `discover`, `search`, `transfer.preview`, `top-entries`

**mutate**: `share.snapshot.export`, `share.snapshot.import`, `init`, `register`, `unregister`, `sync`, `permission.set`, `reconcile`, `transfer`

The `top-entries` operation (`query nexus top-entries`) is undocumented in CLI help — it queries `brain_page_nodes` by `quality_score` and returns highest-weight symbols. This is a direct BRAIN bridge operation (T1006).

---

## 2. Storage Engine and Schema

### 2.1 Storage Locations

| Database | Path | Contents |
|---|---|---|
| `nexus.db` | `~/.cleo/nexus.db` (global, derived from `getCleoHome()`) | `project_registry`, `nexus_audit_log`, `nexus_schema_meta`, `nexus_nodes`, `nexus_relations` |
| Legacy JSON | `~/.cleo/projects-registry.json` | Migrated to SQLite on first `nexus init`. Retained for `migrate-json-to-sqlite.ts`. |

The database uses Drizzle ORM v1.0.0-beta (per ADR rules) on top of `node:sqlite` via a sync proxy. The `nexus.db` is **global** (shared across all registered projects). Per-project `tasks.db` and `brain.db` paths are stored in the registry rows.

### 2.2 Tables

#### `project_registry`
| Column | Type | Notes |
|---|---|---|
| `project_id` | TEXT PK | UUID from `project-info.json` (stable across moves) |
| `project_hash` | TEXT UNIQUE | `sha256(absolutePath)` — changes when project moves |
| `project_path` | TEXT UNIQUE | Absolute filesystem path |
| `name` | TEXT | Human name (default: `basename(path)`) |
| `registered_at` | TEXT | ISO 8601 |
| `last_seen` | TEXT | ISO 8601 |
| `health_status` | TEXT | `unknown\|healthy\|degraded\|unreachable` |
| `health_last_check` | TEXT | ISO 8601 or NULL |
| `permissions` | TEXT | `read\|write\|execute` |
| `last_sync` | TEXT | ISO 8601 |
| `task_count` | INTEGER | Updated on sync |
| `labels_json` | TEXT | JSON array of labels |
| `brain_db_path` | TEXT | Absolute path to project's `brain.db` |
| `tasks_db_path` | TEXT | Absolute path to project's `tasks.db` |
| `last_indexed` | TEXT | ISO 8601 of last `cleo nexus analyze` run |
| `stats_json` | TEXT | `{"nodeCount":N,"relationCount":N,"fileCount":N}` |

Indexes: `projectHash`, `healthStatus`, `name`, `lastIndexed`.

#### `nexus_audit_log`
Append-only log of all registry operations. Fields: `id`, `timestamp`, `action`, `projectHash`, `projectId`, `domain`, `operation`, `sessionId`, `requestId`, `source`, `gateway`, `success`, `durationMs`, `detailsJson`, `errorMessage`. Indexed on timestamp, action, projectHash, projectId, sessionId.

#### `nexus_schema_meta`
Key-value store for schema versioning.

#### `nexus_nodes`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Format: `<filePath>::<name>` for symbols, `<filePath>` for files, `community:<n>` for communities, `process:<slug>` for flows |
| `project_id` | TEXT | FK to `project_registry.project_id` (soft) |
| `kind` | TEXT ENUM | See node kinds below |
| `label` | TEXT | Display label |
| `name` | TEXT | Symbol name in source. NULL for file/folder nodes |
| `file_path` | TEXT | Relative to project root. NULL for community/process |
| `start_line` / `end_line` | INTEGER | Source location |
| `language` | TEXT | `typescript`, `python`, `rust`, etc. |
| `is_exported` | BOOLEAN | Whether publicly exported |
| `parent_id` | TEXT | Parent node ID (soft FK, for nested symbols) |
| `parameters_json` | TEXT | JSON array of param names for functions/methods |
| `return_type` | TEXT | Return type annotation |
| `doc_summary` | TEXT | First line of TSDoc/JSDoc |
| `community_id` | TEXT | Set during Phase 5 community detection |
| `meta_json` | TEXT | Kind-specific blob: `{symbolCount,cohesion}` for community; `{stepCount,entryScore}` for process; `{method,path}` for route |
| `indexed_at` | TEXT | ISO 8601 |

**Node Kinds** (30 total, from `NEXUS_NODE_KINDS`):
- Structural: `file`, `folder`
- Module: `module`, `namespace`
- Callable: `function`, `method`, `constructor`
- Type hierarchy: `class`, `interface`, `struct`, `trait`, `impl`, `type_alias`, `enum`
- Value-level: `property`, `constant`, `variable`, `static`, `record`, `delegate`
- Language-specific: `macro`, `union`, `typedef`, `annotation`, `template`
- Graph-level (synthetic): `community`, `process`, `route`
- External: `tool`, `section`
- Legacy: `import`, `export`, `type`

Indexes: `project_id`, `kind`, `file_path`, `name`, `(project_id, kind)`, `(project_id, file_path)`, `community_id`, `parent_id`, `is_exported`.

#### `nexus_relations`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `project_id` | TEXT | FK to `project_registry.project_id` (soft) |
| `source_id` | TEXT | Source `nexus_nodes.id` |
| `target_id` | TEXT | Target `nexus_nodes.id` or raw module specifier for unresolved imports |
| `type` | TEXT ENUM | See relation types below |
| `confidence` | REAL | Extractor confidence 0.0–1.0 |
| `reason` | TEXT | Human note on why relation was emitted |
| `step` | INTEGER | Step index within execution flow |
| `indexed_at` | TEXT | ISO 8601 |
| `weight` | REAL | Plasticity weight [0.0, 1.0], starts at 0.0 (T998) |
| `last_accessed_at` | TEXT | ISO 8601, NULL until first co-access (T998) |
| `co_accessed_count` | INTEGER | Number of co-access strengthening events (T998) |

**Relation Types** (27 total, from `NEXUS_RELATION_TYPES`):
- Structural: `contains`
- Definition/usage: `defines`, `imports`, `accesses`
- Callable: `calls`
- Type hierarchy: `extends`, `implements`, `method_overrides`, `method_implements`
- Class structure: `has_method`, `has_property`
- Graph-level (synthetic): `member_of` (symbol → community), `step_in_process` (symbol → process)
- Web/API: `handles_route` (function → route), `fetches` (function → external API)
- Tool/agent: `handles_tool`, `entry_point_of` (function → process)
- Wrapping: `wraps`
- Data access: `queries`
- Cross-graph BRAIN link: `documents` (brain_page_node → nexus_nodes), `applies_to`
- Plasticity (T998): `co_changed` (nodes changed together in same commit), `co_cited_in_task`

Indexes: `project_id`, `source_id`, `target_id`, `type`, `(project_id, type)`, `(source_id, type)`, `(target_id, type)`, `confidence`, `last_accessed_at`.

---

## 3. Query Primitives

### 3.1 `context <SYMBOL>`

Queries `nexus_nodes` for all nodes with `name` containing the symbol string (case-insensitive partial match) in the given project, excluding `community` and `process` kinds. Results are ranked by a `NODE_KIND_PRIORITY` table (callable types first: function=0, method=1, constructor=2, class=3 … file=40, folder=41). Up to 5 matching nodes are returned.

For each matching node, the command:
1. Loads all `nexus_relations` for the project into memory (single scan).
2. Computes **callers** (incoming): relations where `targetId = nodeId` and `type IN (calls, imports, accesses)`.
3. Computes **callees** (outgoing): relations where `sourceId = nodeId` and `type IN (calls, imports, accesses)`.
4. Looks up **community membership** via `communityId` field on the node.
5. Looks up **process participation** via `step_in_process` and `entry_point_of` relations.

Implementation: in-memory scan of all project nodes and relations. No SQL-level graph traversal — entire project graph is loaded into JavaScript Maps. This is efficient for the typical ~12,000 node / 48,000 relation index seen in cleocode itself.

### 3.2 `impact <SYMBOL>`

BFS upstream traversal (reverse adjacency graph):
1. Finds target node (same kind-priority sort as `context`).
2. Builds a reverse adjacency map: `targetId → [sourceIds that call/import/access it]`.
3. BFS from the target node up to `--depth` levels (default 3, max 5).
4. Groups impacted nodes by BFS depth level.
5. Assigns risk level: NONE (0), LOW (1–3), MEDIUM (4–10), HIGH (11–25), CRITICAL (>25).

Output layers labeled: d=1 "WILL BREAK (direct callers)", d=2 "LIKELY AFFECTED", d=3 "MAY NEED TESTING".

### 3.3 `clusters`

Reads `nexus_nodes` from `nexus.db` and filters to `kind = 'community'` for the given project. Communities are stored as synthetic nodes created during Phase 5 (Louvain algorithm). The `meta_json` on each community node holds `{symbolCount, cohesion}`. No re-computation is done by this command — it reads the already-computed nodes.

**Algorithm**: Louvain via `graphology-communities-louvain` (CJS loaded via `createRequire`). Input graph is built from CALLS + EXTENDS + IMPLEMENTS relations among symbol nodes. The graph uses `graphology` (undirected for community detection). Resolution parameter is configurable. Returns modularity, community assignments, and dendrogram.

### 3.4 `flows`

Reads `nexus_nodes` filtered to `kind = 'process'` for the given project. Process nodes are synthetic nodes created during Phase 6. The `meta_json` holds `{stepCount, entryScore}`. No re-computation.

**Algorithm (Phase 6 — process-processor.ts)**:
1. Score candidate entry points: exported functions with high call-out ratio, name patterns (`run`, `start`, `main`, `execute`, `handle`, `process`, `dispatch`, `initialize`) score higher. Test files and utility files are deprioritized.
2. For each candidate above threshold: BFS forward via CALLS edges, max depth 10, max branching 4.
3. Deduplication: remove traces that are subsets of longer traces; keep longest path per (entry, terminal) pair.
4. Create `Process` nodes and `STEP_IN_PROCESS`/`ENTRY_POINT_OF` edges.

### 3.5 `export` — GEXF and JSON

GEXF generation is implemented in-CLI (`generateGexf` function). Produces standard GEXF 1.2draft format with:
- Node attributes: `kind`, `filePath`, `language`, `startLine`, `endLine`, `isExported`, `projectId`
- Edge attributes: `relationType`, `confidence`, `reason`
- Color coding by node kind (function=blue, class=red, community=purple, process=teal, etc.)
- Edges skipped for unresolved imports (external specifiers not in node set)
- Can filter by `--project` or export all projects

JSON format outputs raw nodes and relations arrays.

### 3.6 `diff`

Compares graph state between two git commits:
1. Resolves `--before` and `--after` refs to short SHAs via `git rev-parse`.
2. Lists changed `.ts`/`.js`/`.rs` files via `git diff --name-only`.
3. Snapshots current node/relation counts for the project.
4. Runs incremental pipeline (`runPipeline` with `{ incremental: true }`) on `--after` ref's file set.
5. Computes delta: `newRelations`, `removedRelations`, `newNodes`, `removedNodes`.
6. Classifies regressions: >5 removed relations or any removed nodes trigger a warning.

**Limitation**: The diff operates on the *current working tree* state (the pipeline sees the filesystem as-is), not a proper git checkout of `--after`. The `--before` / `--after` refs are primarily used for labeling and `git diff --name-only` scoping, not for actual code checkout. True "checkout and compare" is not implemented.

---

## 4. Multi-Project Registry

### 4.1 Registration and Identity

Projects are identified by two keys:
- `projectId` (UUID from `.cleo/project-info.json`) — **stable across filesystem moves**
- `projectHash` (SHA of absolute path) — changes when the project is moved

The `reconcile` command implements a 4-scenario policy:
1. `projectId` in registry + path matches → update `lastSeen`, return `{status:'ok'}`
2. `projectId` in registry + path changed → update path+hash, return `{status:'path_updated'}`
3. `projectId` not in registry → auto-register, return `{status:'auto_registered'}`
4. `projectHash` matches but different `projectId` → throw identity conflict error

Registration requires a readable `.cleo/tasks.db` (`isCleoProject` check). Registration reads `taskCount` and `labels` from the project's `tasks.db` via `getAccessor`.

### 4.2 `projects` Sub-Group

| Subcommand | Description |
|---|---|
| `projects list` | Select all rows from `project_registry` |
| `projects register` | Register current (or specified) directory |
| `projects remove <NAMEORHASH>` | Delete row from `project_registry` |
| `projects scan` | Walk `~/code`, `~/projects`, `/mnt/projects` (configurable) up to depth 5, find dirs with `.cleo/`, cross-reference against registry |
| `projects clean` | Bulk delete by path criteria |

The `scan` command respects filesystem boundaries (`stat().dev` comparison), skips `node_modules`, `.git`, `target`, `dist`, `build`, `coverage`, etc. Results are written to `nexus_audit_log` with action `projects.scan`.

### 4.3 Cross-Project Query Syntax

The query parser (`packages/core/src/nexus/query.ts`) supports:
- `T001` — bare task ID (implicit current project)
- `my-app:T001` — named project
- `.:T001` — current project
- `*:T001` — wildcard (all registered projects)

`getCurrentProject()` reads `.cleo/project-info.json` (field `name`), falls back to `basename(cwd)`. Can be overridden with `NEXUS_CURRENT_PROJECT` env var.

### 4.4 `deps` and `graph`

`deps` shows cross-project task dependencies for a given task reference (with `--reverse` for reverse deps). `graph` builds the full dependency graph across all registered projects. Both operate on task-level dependency data (blocking/blocked-by relationships), not the code-level graph.

### 4.5 `critical-path` and `orphans`

`critical-path` shows the longest dependency chain across all projects. `orphans` detects task references to tasks that do not exist in any registered project (broken cross-project deps).

### 4.6 `workspace.ts` — Conduit Routing

The `workspace.ts` module provides `nexus.route(directiveEvent)` to dispatch Conduit directives to the correct project, and `nexus.workspace.status()` for aggregated cross-project task view. This is the ORCH-PLAN Phase B integration (dispatch Conduit messages to the right project's `tasks.db`).

---

## 5. Integration Surface

### 5.1 BRAIN Integration

Three integration points exist between NEXUS and BRAIN:

**A. Hebbian Plasticity (T998 — `nexus-plasticity.ts`)**
When nodes are co-accessed during a BRAIN retrieval (via `runConsolidation` Step 6b in `brain-lifecycle.ts`), the directed edges in `nexus_relations` between those nodes gain `weight` += 0.05, capped at 1.0. Fields `co_accessed_count` and `last_accessed_at` are also updated. Strengthening query:
```sql
UPDATE nexus_relations
SET weight = MIN(1.0, weight + 0.05),
    co_accessed_count = co_accessed_count + 1,
    last_accessed_at = datetime('now')
WHERE source_id = ? AND target_id = ?
```

**B. Living Brain Substrate Adapter (`packages/brain/src/adapters/nexus.ts`)**
The BRAIN API can query `nexus.db` as a substrate. Returns `BrainNode[]` and `BrainEdge[]` from the highest in-degree symbols (most-called functions, most-imported files). Node IDs are prefixed with `nexus:` to prevent collisions with BRAIN node IDs. Capped at `ceil(limit/5)` nodes per substrate call.

**C. `top-entries` Operation**
The dispatch operation `query nexus top-entries` reads `brain_page_nodes` sorted by `quality_score DESC, last_activity_at DESC`. This is a BRAIN→NEXUS cross-query (reads brain.db to surface high-quality symbols). Available as an MCP-style query operation.

**D. Cross-graph Relation Types**
`nexus_relations` has two cross-graph relation types:
- `documents`: brain_page_node → nexus_nodes (brain entry annotates code symbol)
- `applies_to`: brain_page_node → nexus_nodes

**E. Sentient Tier-2 Ingester (`nexus-ingester.ts`)**
The sentient loop's Tier-2 propose tick uses NEXUS as a structural anomaly signal:
- Pattern A: orphaned callees (high in-degree, zero out-degree — no calls)
- Pattern B: over-coupled nodes (total degree > 20)
Both generate `ProposalCandidate` entries with `NEXUS_BASE_WEIGHT = 0.3`.

### 5.2 TASKS Integration

`nexusUpdateIndexStats()` is called after every successful `cleo nexus analyze` to write `lastIndexed` and `statsJson` back into `project_registry`. On registration, the registry reads `taskCount` and `labels` from the project's `tasks.db`. On sync, it re-reads these values.

### 5.3 `nexus-bridge.md` — Agent Context Bridge

`refresh-bridge` (and the post-analyze hook) regenerates `.cleo/nexus-bridge.md` from `nexus.db` content. The bridge summarizes:
- Index status (file/node/relation counts, last indexed timestamp)
- Symbol counts by kind (functions, classes, methods, etc.)
- Relation counts by type (calls, imports, extends, etc.)
- Top entry points (most CALLS-out-edges, exported)
- Functional clusters (community nodes, ranked by symbolCount)
- Code intelligence command reference

This file is `@`-referenced in `AGENTS.md` so it is auto-loaded into agent context at session start (memory bridge pattern).

### 5.4 No MCP Integration

There is no MCP server or MCP tool exposing NEXUS operations. The nexus domain is accessible only via the `cleo nexus` CLI or the internal dispatch layer (`query/mutate nexus <operation>`). No HTTP endpoint, no REST API.

---

## 6. Gaps Observed

### G1: No Cypher or Graph Query Language
NEXUS has no graph query DSL. All traversal is hardcoded BFS in TypeScript (context, impact) or SQL with in-memory filtering. There is no way to write ad-hoc graph queries such as "find all functions that transitively call X and also import Y." Cypher, Gremlin, or even a minimal SPARQL-like surface is absent.

### G2: No Semantic / Embedding Layer
NEXUS contains no embedding generation, no vector index, no semantic similarity search. Queries are structural (graph traversal) or lexical (name substring matching). There is no way to ask "find symbols semantically similar to this description" or "find code that does the same thing as this snippet." The symbol search in `context` and `impact` is purely a case-insensitive `String.includes()` match.

### G3: No Wiki / Docstring Generation
There is no command that generates human-readable documentation pages from the graph (no `cleo nexus wiki`, no auto-generated module docs). The `doc_summary` field stores the first TSDoc line for each symbol, but there is no pipeline to aggregate these into navigable documentation.

### G4: `diff` Does Not Truly Checkout Git Refs
The `diff` command resolves `--before`/`--after` to SHAs and lists changed files, but then runs the pipeline on the *current working tree*, not a proper checkout of the `--after` ref. The "before" state is the existing `nexus.db` — there is no mechanism to checkpoint the graph at the `--before` ref. This means `diff` can produce misleading results if the working tree differs from `--after`.

### G5: Impact / Context Operate on Full In-Memory Load
Both `context` and `impact` load ALL `nexus_nodes` and `nexus_relations` for the project into JavaScript memory before filtering. For a project the size of cleocode (~12,304 nodes, ~48,598 relations), this works. For larger projects (>100k relations), this will become a memory/latency bottleneck. No SQL-level graph traversal (e.g., recursive CTEs) is used.

### G6: No MCP Exposure
NEXUS has no MCP server. An agent running in a different process cannot call `context` or `impact` via MCP tools — it must shell out to `cleo nexus context`. This is a friction point for agent-to-agent code intelligence access.

### G7: `clusters` / `flows` Bypass Dispatch Layer
These commands directly import `@cleocode/core/store/nexus-sqlite` inside the CLI handler, bypassing the dispatch layer entirely. There is no `query nexus clusters` or `query nexus flows` MCP-compatible operation. This means they cannot be called via the CLEO agent protocol (`query nexus …`).

### G8: No Incremental Community/Flow Re-detection
With `--incremental`, the pipeline only re-parses changed files. However, community detection (Phase 5) and process detection (Phase 6) are re-run on the complete symbol table each time. For large codebases, this may be expensive. There is no "only re-run community detection on affected sub-graphs" optimization.

### G9: `top-entries` Reads brain.db, Not nexus.db
The `query nexus top-entries` operation reads `brain_page_nodes` (from `brain.db`), not `nexus_nodes`. The comment in the code says it "will prefer a `weight` column when T998 ships it; uses quality_score until then" — but T998 did ship. The operation is thus using a suboptimal proxy and has not been updated to read `nexus_relations.weight` directly.

### G10: No Cross-Project Code Analysis
The code intelligence graph (nodes/relations) is per-project. There is no mechanism to trace calls across project boundaries (e.g., from a caller in `packages/cleo` to a callee in `packages/core`). Cross-project analysis only applies to task dependency data, not code symbols.

---

## 7. Strengths Observed

### S1: Louvain Community Detection (Shipped)
Phase 5 uses the Louvain algorithm via `graphology-communities-louvain`, a well-regarded library. Produces `community` synthetic nodes with `modularity`, `cohesion`, and `symbolCount` metadata. Clusters are persisted as graph nodes (same schema as code symbols), making them queryable via standard node operations.

### S2: Multi-Phase Ingestion Pipeline (6 Phases, Tree-sitter)
The analysis pipeline is well-structured: filesystem-walker → structure-processor → import resolution → parse loop (tree-sitter) → call resolution → community detection → process detection. Uses tree-sitter for parsing, supporting TypeScript, Rust, and other languages. Entry-point scoring (Phase 6a) is sophisticated: considers export status, call ratios, name patterns, and test-file detection.

### S3: Hebbian Plasticity (T998)
Co-access strengthening in `nexus_relations.weight` is a novel feature. Every BRAIN retrieval passively strengthens code-graph edges, creating a living record of which code relationships are most frequently traversed. This data could power future semantic ranking, anomaly detection, and "hot path" visualization.

### S4: Cross-Project Task Registry with Stable Identity
The `projectId`-based reconciliation (stable across moves) is architecturally sound. The 4-scenario reconcile policy handles the common case of project relocation cleanly. The global `nexus.db` in `~/.cleo/` provides a single source of truth for all registered projects.

### S5: GEXF Export for Visualization
GEXF is a standard format accepted by Gephi, Cytoscape, and other graph tools. The export includes edge weights (`confidence`), node kind color coding, and all metadata attributes. This enables offline analysis and visualization without additional tooling.

### S6: Audit Log on All Registry Operations
Every `register`, `unregister`, `sync`, `reconcile`, `permission.set`, and `projects.scan` operation writes to `nexus_audit_log`. This provides a durable operation history, useful for debugging registry corruption and for compliance.

### S7: TASKS-Integrated Cross-Project Analysis
`deps`, `critical-path`, `blocking`, `orphans`, `discover`, `search`, and `transfer` operate at the task level across all registered projects. This is a strong integration between code intelligence (nexus.db) and project management (tasks.db), rare in code intelligence tools.

### S8: nexus-bridge.md Auto-Generated Agent Context
Post-analyze automatic regeneration of `nexus-bridge.md` ensures agents always have up-to-date codebase summaries injected via `AGENTS.md`. The bridge captures entry points, cluster counts, and relation statistics — the most relevant signals for agentic navigation.

### S9: Sentient Loop Integration (Tier-2)
The `nexus-ingester.ts` feeds structural anomalies (orphaned callees, over-coupled nodes) as ranked `ProposalCandidate[]` into the sentient loop's propose tick. This closes the loop between static code analysis and autonomous task generation.
