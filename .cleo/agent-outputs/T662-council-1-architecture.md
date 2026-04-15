# Council Lead 1 — Architecture & Substrate Audit
**Task**: T662 | **Date**: 2026-04-15 | **Auditor**: Council Member 1 (Architecture)
**Method**: Read schema source files + live SQLite queries against .cleo/brain.db and ~/.local/share/cleo/nexus.db. All counts are ground-truth from the databases, not from documentation.

---

## Substrate Reality Table

| Substrate | Schema file | Tables | Node/Edge types | Cross-substrate FKs |
|-----------|-------------|--------|-----------------|---------------------|
| **BRAIN** | `packages/core/src/store/brain-schema.ts` | 10: brain_decisions, brain_patterns, brain_learnings, brain_observations, brain_sticky_notes, brain_memory_links, brain_schema_meta, brain_page_nodes, brain_page_edges, brain_retrieval_log, brain_plasticity_events (11 total counting plasticity) | Node types: 12 (decision, pattern, learning, observation, sticky, task, session, epic, file, symbol, concept, summary). Edge types: 17 (derived_from, produced_by, informed_by, supports, contradicts, supersedes, applies_to, documents, summarizes, part_of, references, modified_by, code_reference, affects, mentions, co_retrieved — note: `affects` and `mentions` in schema but NOT in EDGE_TYPES constants file edge-types.ts) | brain_decisions.context_task_id → tasks.db (soft FK); brain_decisions.context_epic_id → tasks.db (soft FK); brain_observations.source_session_id → tasks.db (soft FK); brain_memory_links.task_id → tasks.db (soft FK); brain_retrieval_log.session_id → tasks.db (soft FK); brain_page_edges.to_id can reference nexus node IDs (text match, no FK) |
| **NEXUS** | `packages/core/src/store/nexus-schema.ts` | 5: project_registry, nexus_audit_log, nexus_schema_meta, nexus_nodes, nexus_relations | Node kinds: 31 (file, folder, module, namespace, function, method, constructor, class, interface, struct, trait, impl, type_alias, enum, property, constant, variable, static, record, delegate, macro, union, typedef, annotation, template, community, process, route, tool, section, import, export, type). Relation types: 22 (contains, defines, imports, accesses, calls, extends, implements, method_overrides, method_implements, has_method, has_property, member_of, step_in_process, handles_route, fetches, handles_tool, entry_point_of, wraps, queries, documents, applies_to) | project_registry.brain_db_path → brain.db path (string, no FK); project_registry.tasks_db_path → tasks.db path (string, no FK); nexus_nodes.project_id → project_registry.project_id (real FK) |
| **TASKS** | `packages/core/src/store/tasks-schema.ts` | 17: tasks, task_dependencies, task_relations, sessions, task_work_history, lifecycle_pipelines, lifecycle_stages, lifecycle_gate_results, lifecycle_evidence, lifecycle_transitions, manifest_entries, pipeline_manifest, release_manifests, schema_meta, audit_log, token_usage, architecture_decisions (+ adr_task_links, adr_relations, external_task_links, status_registry, warpChains, warpChainInstances, agentInstances, agentErrorLog) | Task types: epic/task/subtask. Relation types: related/blocks/duplicates/absorbs/fixes/extends/supersedes. Lifecycle stages: 10 (research through contribution). | tasks.session_id → sessions.id (FK). tasks.parent_id → tasks.id (FK). pipeline_manifest.brain_obs_id → brain.db (string, no FK). tasks.assignee → signaldock.agents.agent_id (soft FK, text). audit_log.project_hash → nexus.project_registry (soft FK, text). |
| **CONDUIT** | `packages/core/src/store/conduit-sqlite.ts` | 11: conversations, messages, delivery_jobs, dead_letters, message_pins, attachments, attachment_versions, attachment_approvals, attachment_contributors, project_agent_refs, _conduit_meta, _conduit_migrations | messages.status: pending/delivered/read/failed (inferred from DDL pattern). attachment.mode: draft/published. FTS5 virtual: messages_fts (content + from_agent_id). | messages.from_agent_id → signaldock.agents.agent_id (soft FK, text). messages.to_agent_id → signaldock.agents.agent_id (soft FK, text). project_agent_refs.agent_id → signaldock.agents.agent_id (soft FK, documented in code). |
| **SIGNALDOCK** | `packages/core/src/store/signaldock-sqlite.ts` | 12: users, organization, agents, claim_codes, capabilities, skills, agent_capabilities, agent_skills, agent_connections, accounts, sessions, verifications, org_agent_keys (13 tables). | agents.status: online/offline/busy/away. agents.class: custom + others. agents.privacy_tier: public + others. agents.transport_type: http/local/etc. agent_connections: per-transport heartbeat tracking. | agents.owner_id → users.id (FK). agents.organization_id → organization.id (FK). agent_connections.agent_id → agents.agent_id (FK). claim_codes.agent_id → agents.id (FK). |

---

## Cross-Substrate Bridge Reality

| Claim (from §4 of research doc) | Verified? | Evidence |
|----------------------------------|-----------|----------|
| `brain_decisions.context_task_id` exists in schema | **YES** | brain-schema.ts:146 — `contextTaskId: text('context_task_id')` |
| `brain_decisions.context_task_id` is actually populated | **BARELY** | Live query: `SELECT COUNT(*) FROM brain_decisions WHERE context_task_id IS NOT NULL` → **1 of 14 decisions** (7%) |
| `nexus_relations.type IN {'documents', 'applies_to'}` exist in schema | **YES** | nexus-schema.ts:275-276 — both present in NEXUS_RELATION_TYPES enum |
| `nexus_relations.type IN {'documents', 'applies_to'}` are actually used | **NO** | Live query: `SELECT COUNT(*) FROM nexus_relations WHERE type IN ('documents','applies_to')` → **0 rows each**. Total nexus_relations = 21,328 (calls/member_of/contains/imports dominate) |
| `brain_page_edges` populated with cross-substrate edges (brain→nexus) | **PARTIAL** | `code_reference` edges exist: 2,669 rows. But `documents`=0, `modified_by`=0, `affects`=0, `mentions`=0. Bridge is CODE_REFERENCE only. |
| `project_registry.brain_db_path` column exists | **YES** | nexus-schema.ts:35 — `brainDbPath: text('brain_db_path')` |
| `project_registry.tasks_db_path` column exists | **YES** | nexus-schema.ts:37 — `tasksDbPath: text('tasks_db_path')` |
| `SELECT COUNT(*) FROM project_registry` — actual count | **FACT** | Live query against `~/.local/share/cleo/nexus.db` → **24,816 rows** (includes test projects, temp dirs, and real projects). `cleocode` present at `/mnt/projects/cleocode`. |
| `brain_page_edges` backfill for `decisions→tasks` applied_to edges | **NO** | `SELECT COUNT(*) FROM brain_page_edges WHERE edge_type='applies_to' AND provenance LIKE 'auto:store-decision'` → **1 row** (only 1 of 14 decisions bridged). |

---

## Hebbian/STDP State

- **`strengthenCoRetrievedEdges` function**: EXISTS and is real code at `brain-lifecycle.ts:930`.
- **Called in consolidation pipeline**: YES — Step 6 of `runConsolidation` (verified at line 606 context).
- **Edge type emitted**: `EDGE_TYPES.CO_RETRIEVED` = `'co_retrieved'` (via constants from edge-types.ts:15).
- **Historical bug (D-BRAIN-VIZ-05)**: Prior to T626/T632 migration fix, this function emitted `edge_type='relates_to'` (wrong type, bypassed Drizzle enum). Fix was applied: `brain-sqlite.ts:171-180` runs idempotent UPDATE to relabel `'relates_to'` → `'co_retrieved'` for rows where `provenance LIKE 'consolidation:%'`.
- **Live `co_retrieved` edge count**: **0 rows** — the Hebbian strengthener has never successfully produced a co_retrieved edge in this database. The relabeling migration also produced 0 changes.
- **Reason it hasn't fired**: `brain_retrieval_log` has only **38 rows** (date range: 2026-04-13 to 2026-04-15), with the co-occurrence threshold requiring ≥3 co-retrievals of the same pair. The retrieval log is too sparse for the threshold to trigger.
- **`brain_plasticity_events` table**: Schema EXISTS (brain-schema.ts:740 — T626-era addition). **0 rows** in live database. The STDP audit log has never been written to.
- **STDP upgrade (T627 Phase 5)**: Not started. The `brain_plasticity_events` table schema is in place but no writer code is wired yet.

---

## Vector Substrate State

- **`loadBrainVecExtension` function**: EXISTS at `brain-sqlite.ts:192` — calls `sqlite-vec` npm package's `load()` function.
- **Vec extension loading**: Gracefully no-ops (returns false) if `sqlite-vec` is not available or fails. Non-fatal by design.
- **`brain_embeddings` virtual table**: Schema DDL is `CREATE VIRTUAL TABLE brain_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])`. This DDL is present and the `.schema` command returns it from `brain.db`.
- **CLI sqlite3 access to `brain_embeddings`**: **FAILS** — `sqlite3 .cleo/brain.db "SELECT COUNT(*) FROM brain_embeddings"` → `Error: no such module: vec0`. The CLI `sqlite3` binary does not have the vec0 extension loaded. This is expected — the extension only loads when the Node.js process uses `sqlite-vec` npm package.
- **Actual embedding rows**: Cannot query via `sqlite3` CLI due to missing module. Assumed 0 given system state — node process with `getBrainDb` would be required to verify.
- **Status**: The embedding infrastructure (virtual table DDL + extension loading code) exists. Whether embeddings are being generated and populated depends on whether `@huggingface/transformers` model inference is wired to write to `brain_embeddings` during memory operations.

---

## Live Database Counts (Ground Truth)

### brain.db

| Table | Count |
|-------|-------|
| brain_decisions | 14 |
| brain_page_nodes | 959 |
| brain_page_edges | 3,573 |
| brain_retrieval_log | 38 |
| brain_plasticity_events | 0 |
| brain_embeddings | NOT QUERYABLE via sqlite3 CLI (vec0 module not loaded) |

### brain_page_edges by type

| edge_type | count | avg_weight | provenance |
|-----------|-------|------------|------------|
| code_reference | 2,669 | (auto:exact-symbol=2597, auto:fuzzy-symbol=62, auto:exact-file=10) | auto:exact-symbol / auto:fuzzy-symbol / auto:exact-file |
| supersedes | 520 | - | observer-reflector |
| applies_to | 120 | - | backfill:observation.text-task-ref=109, backfill:sticky.content-task-ref=10, auto:store-decision=1 |
| derived_from | 107 | - | backfill:pattern.context-task-ref |
| contradicts | 100 | - | consolidation:contradiction |
| part_of | 35 | - | auto:task-complete |
| produced_by | 21 | - | auto:observe=19, backfill:observation.sourceSessionId=2 |
| references | 1 | - | (blank provenance) |
| **co_retrieved** | **0** | - | NEVER WRITTEN |

### nexus.db (global, ~/.local/share/cleo/nexus.db)

| Table | Count |
|-------|-------|
| project_registry | 24,816 |
| nexus_nodes | 10,742 |
| nexus_relations | 21,328 |

### nexus_relations by type (top 10)

| type | count |
|------|-------|
| calls | 9,573 |
| member_of | 4,136 |
| contains | 3,006 |
| imports | 2,909 |
| has_method | 734 |
| step_in_process | 469 |
| has_property | 259 |
| entry_point_of | 104 |
| extends | 83 |
| implements | 55 |
| **documents** | **0** |
| **applies_to** | **0** |

---

## DRIFT / GAPS / LIES IN THE PLAN DOC

### 1. `brain_page_edges` enum drift — STILL NOT FIXED (Phase 3a claims OPEN, confirmed)

The plan doc (§3a) says `co_retrieved` and `code_reference` are missing from `BRAIN_EDGE_TYPES` and need to be added.

**Actual schema state**: BOTH `co_retrieved` (line 571) and `code_reference` (line 567) ARE ALREADY IN the `BRAIN_EDGE_TYPES` constant in `brain-schema.ts`. The plan doc's §3a claim that these are "missing from the Drizzle enum" is **STALE**. They were added (apparently during T626). The enum drift was fixed. Phase 3a backlog item is done at the schema level.

However, `affects` and `mentions` ARE in `BRAIN_EDGE_TYPES` (brain-schema.ts lines 568-569) but are NOT in the `EDGE_TYPES` constants object in `edge-types.ts`. This is a **real drift gap** the plan doc does not mention.

### 2. `nexus_relations.type IN {'documents', 'applies_to'}` — SCHEMA EXISTS, ZERO USAGE

The plan doc claims these relation types exist "as brain bridge types" in nexus_relations. The schema defines them (nexus-schema.ts:275-276). But live nexus.db has 0 rows of either type across 21,328 total relations. The brain↔nexus bridge via nexus_relations is **entirely theoretical** — no code actually writes these cross-substrate edges into nexus_relations.

### 3. `brain_page_edges` cross-substrate bridge — CODE_REFERENCE ONLY (not the full picture claimed)

The plan doc's §4.1 lists 5 edge types in brain_page_edges as cross-substrate bridges: references, documents, modified_by, applies_to, affects. Live reality:
- `code_reference`: 2,669 rows (this is the dominant bridge, NOT listed as primary in §4.1)
- `applies_to`: 120 rows (backfill provenance — observation.text-task-ref, NOT decision→task)
- `references`: 1 row
- `documents`: 0 rows
- `modified_by`: 0 rows
- `affects`: 0 rows

The plan doc does NOT mention `code_reference` edges in §4.1 (they were added by T645 after the section was written). This makes §4.1 an inaccurate picture of what's actually there.

### 4. Hebbian co_retrieved edges — CLAIMED "SHIPPED", ACTUALLY ZERO IN PRODUCTION

The plan doc §5 states `strengthenCoRetrievedEdges` is shipped and works. D-BRAIN-VIZ-04 says "preserve shipped Hebbian strengthener." Section §1 Phase 1a is marked DONE.

**Reality**: The function code is real and correct. But `brain_page_edges` has **0 co_retrieved edges** in the live database. The retrieval log (38 rows, ~2 days old) is too sparse to trigger the co-occurrence threshold (≥3 pairs). The Hebbian strengthener has never produced output in this database. The plan doc's claim that it "works" is technically true as code, but the claim implies it has produced results — that part is false.

### 5. `project_registry` count is misleading — 24,816 rows includes junk

The plan doc implies `project_registry` holds meaningful cross-project data. Reality: 24,816 rows, the majority of which are test projects in `~/.temp/cleo-test-*` directories. The real project count is likely <20. This inflates any cross-project meta-brain analysis.

### 6. `brain_plasticity_events` table — SCHEMA EXISTS, ZERO DATA, NO WRITER

The `brain_plasticity_events` table is defined in brain-schema.ts (T626 era). Zero rows in production. No code path in brain-lifecycle.ts writes to this table — it was added to the schema as prep for the STDP upgrade (Phase 5) but the writer was never implemented. The table is a phantom.

### 7. `brain_embeddings` — DDL EXISTS, QUERYABILITY UNCERTAIN

The vec0 virtual table DDL is present. The `sqlite-vec` npm package is integrated. But:
- Cannot verify row count via sqlite3 CLI (vec0 not loaded in system sqlite3)
- No evidence in the codebase that `@huggingface/transformers` writes to `brain_embeddings` during normal memory operations
- The entire embedding pipeline may be infrastructure without a writer

---

## Recommended Next Architecture Work (Top 3)

### 1. Wire the brain↔nexus cross-substrate bridge

The most critical architectural gap. `nexus_relations.type IN {documents, applies_to}` has zero rows despite being schema-defined. The `brain_page_edges.to_id` can reference nexus node IDs by convention (string match) but there is no enforced join. The plan's Phase 3b (backfill missing bridge edges) needs a concrete writer:
- `cleo memory code-auto-link` already exists for observation→symbol linking (produces code_reference edges in brain_page_edges)
- Missing: a job that writes `documents` / `applies_to` rows INTO nexus_relations pointing back at brain nodes
- Without this, the "unified 5-substrate graph" is actually 2 disconnected graphs (brain_page_edges side + nexus_relations side) with no join path

### 2. Fix the `brain_plasticity_events` writer (implement Phase 5 STDP writer)

The table schema is in place but nothing writes to it. The `strengthenCoRetrievedEdges` function updates edge weights but does NOT log to `brain_plasticity_events`. This means:
- No STDP audit trail exists
- The brain_plasticity_events table is entirely dark
- Any visualization of "plasticity history" will have no data
- Phase 5 is described as requiring an "owner checkpoint" but the schema prep is already done — the writer is the missing piece

### 3. Prune the project_registry junk rows

24,816 rows in `project_registry` with the majority being test artifacts degrades any cross-project meta-brain analysis and makes `nexus nexus context` / `nexus impact` queries slower. A one-time cleanup job that removes rows where `project_path LIKE '%/.temp/%' OR NOT EXISTS (SELECT 1 FROM ... WHERE path is valid)` is needed before Phase 4 (cross-project meta-brain) can be meaningful.
