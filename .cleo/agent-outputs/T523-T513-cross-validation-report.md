# T523 + T513 Cross-Specification Consistency Validation Report

**Date**: 2026-04-11
**Validator**: Cross-Specification Consistency Reviewer
**Role**: Quality Gate — nothing proceeds to implementation without sign-off
**Specs Reviewed**:
- T523-CA1: Brain Integrity Specification (CA1)
- T523-CA2: Memory SDK Specification (CA2)
- T513-CA: GitNexus Pipeline Implementation Specification (CA-Pipeline)

**Verdict**: **CONDITIONAL PASS**

---

## Section 1: Overall Assessment

### Verdict: CONDITIONAL PASS

All three specifications are grounded in reality, reference actual code, and propose coherent architectures. However, four conflicts and seven gaps require resolution before implementation begins. None are blockers that would invalidate the approach — all are correctable through targeted amendments.

**Pass conditions** (must be resolved before implementation):

1. [C1] Edge type naming conflict between CA2 and CA1 — resolve canonical set
2. [C2] Schema file placement conflict — CA1 says brain-schema.ts, CA-Pipeline says nexus-schema.ts; both need precision
3. [C3] Cross-graph bridge storage conflict — CA2 and CA-Pipeline disagree on where bridge edges live
4. [C4] Quality score column conflict — CA1 adds `quality_score` to typed tables, CA2 puts quality in `brain_page_nodes` only; the two formulas diverge

**Conditional requirements** (should be resolved before implementation):

5. [G1] Migration path for existing 5 `brain_memory_links` rows is incomplete
6. [G2] `brain_page_nodes` schema in CA2 removes the 4-item `BRAIN_EDGE_TYPES` but CA1 references the existing schema; migration ordering must be explicit
7. [G3] CA-Pipeline defines a `nexusBrainLinks` bridge table in nexus.db; CA2 defines shadow nodes in brain.db; neither fully specifies the write path for bridge creation

---

## Section 2: Consistency Matrix

### 2.1 Schema Consistency

| Element | CA1 (Brain Integrity) | CA2 (Memory SDK) | CA-Pipeline (Nexus) | Status |
|---------|----------------------|------------------|---------------------|--------|
| `brain_page_nodes` columns | References existing 4-column schema | Extends to 8 columns (adds `qualityScore`, `contentHash`, `lastActivityAt`, `updatedAt`) | Not modified | ALIGN — CA2 extends CA1's existing schema cleanly |
| `brain_page_edges` columns | References existing schema | Extends to 5 columns (adds `weight`, `provenance`) | Not modified | ALIGN — additive, no conflict |
| `BRAIN_NODE_TYPES` | References existing `['task','doc','file','concept']` | Replaces with 12-type enum | Not referenced | CONFLICT — CA1 never explicitly says the node type enum changes; CA2's enum must align with when CA1 assumes the old enum |
| `BRAIN_EDGE_TYPES` | References existing `['depends_on','relates_to','implements','documents']` | Replaces with 13-type enum | Not referenced | CONFLICT — same as above; CA1 Wave 1 (hook fixes) assumes existing edge types; CA2 schema migration is Wave 1 of its own plan |
| `nexus_nodes` | Not referenced | Shadow nodes with `nodeType='symbol'/'file'` reference `code_index.id` | Full table definition | ALIGN — CA2 references nexus concepts as shadow nodes only; CA-Pipeline defines the authoritative schema |
| `nexus_relations` | Not referenced | Bridge edges (`documents`, `references`) in brain.db | Full table definition | CONFLICT — see C3 |
| `nexusBrainLinks` | Not referenced | Not defined (CA2 uses shadow nodes in brain.db) | Defined as dedicated bridge table in nexus.db | CONFLICT — C3 |
| Quality scores | Adds `quality_score REAL` to all 4 typed tables (brain_patterns, brain_learnings, brain_decisions, brain_observations) | Adds `qualityScore REAL` to `brain_page_nodes` only | Not referenced | CONFLICT — C4: two separate quality score systems |
| FTS5 tables | Specifies post-purge rebuild, quality integration | Not referenced | Not referenced | ALIGN — CA1 owns FTS5; no conflict |

### 2.2 Edge Type Naming

| Edge Type | CA1 (brain_page_edges) | CA2 (brain_page_edges) | CA-Pipeline (nexus_relations) | Conflict? |
|-----------|------------------------|------------------------|-------------------------------|-----------|
| `derived_from` | Not defined | YES | Not defined | No conflict |
| `produced_by` | Not defined | YES | Not defined | No conflict |
| `informed_by` | Not defined | YES | Not defined | No conflict |
| `supports` | Not defined | YES | Not defined | No conflict |
| `contradicts` | Not defined | YES | Not defined | No conflict |
| `supersedes` | Not defined | YES | Not defined | No conflict |
| `applies_to` | Not defined | YES (brain.db edges) | YES (nexus_relations) + `applies_to` in brain→nexus cross-link | PARTIAL CONFLICT — `applies_to` appears in both graphs with different semantics |
| `documents` | Not defined | YES (brain.db edges) | YES (nexus_relations) + cross-link type | CONFLICT — same type name in both graphs |
| `references` | Not defined | YES | Not defined | No conflict |
| `modified_by` | Not defined | YES | Not defined | No conflict |
| `summarizes` | Not defined | YES | Not defined | No conflict |
| `part_of` | Not defined | YES | Not defined | No conflict |
| `depends_on` | YES (existing schema) | Not in new 13-type enum | Not defined | CONFLICT — CA2 removes `depends_on`; CA1 Wave 1 references existing schema that has it |
| `relates_to` | YES (existing schema) | Not in new 13-type enum | Not defined | CONFLICT — same removal issue |
| `implements` | YES (existing schema) | Not in new 13-type enum | `implements` | RENAMED — CA2 drops the existing `implements` edge in brain.db schema; CA-Pipeline has `implements` in nexus_relations |
| `contains` | Not defined | Not defined | YES | No conflict |
| `calls` | Not defined | Not defined | YES | No conflict |
| `extends` | Not defined | Not defined | YES | No conflict |
| `member_of` | Not defined | Not defined | YES | No conflict |
| `step_in_process` | Not defined | Not defined | YES | No conflict |

**Summary**: The brain.db edge types (`BRAIN_EDGE_TYPES`) and the nexus.db edge types (`NEXUS_RELATION_TYPES`) are correctly separated — they live in different databases. The conflict is that CA2 removes 3 existing brain edge types (`depends_on`, `relates_to`, `implements`) when expanding the enum. Any existing `brain_page_edges` rows using those types would break. Since `brain_page_edges` has 0 rows in the live database, this is not a data migration issue — but the code paths in `brain-accessor.ts` that reference these type values must be updated.

### 2.3 Contract Type Consistency (`GraphNodeKind` and `GraphRelationType`)

| Contract Type | CA2 (Memory SDK) | CA-Pipeline | Existing `contracts/graph.ts` |
|---------------|------------------|-------------|-------------------------------|
| `GraphNodeKind` | Not expanded (uses `BrainNodeType` instead) | Fully expanded to 35+ kinds | 18 kinds currently |
| `GraphRelationType` | Not expanded (uses `BrainEdgeType` instead) | Fully expanded to 22 types | 11 types currently |
| `GraphNode` | Not modified | Adds `communityId`, `processIds`, `meta` | Existing 10 fields |

**Assessment**: CA2 and CA-Pipeline operate on separate type systems (`BrainNodeType`/`BrainEdgeType` vs `GraphNodeKind`/`GraphRelationType`). This is correct by design — brain.db and nexus.db have different type vocabularies. No conflict here, but the `documents` and `applies_to` cross-graph types appear in BOTH type systems with different semantics (see C3).

### 2.4 Hook Behavior Consistency

| Hook | CA1 (Brain Integrity) | CA2 (Memory SDK) |
|------|-----------------------|------------------|
| `tasks.complete` | Removes "Completed:" learning write; makes `extractTaskCompletionMemory` a no-op | Adds graph node upsert + edge wiring in `brain_page_nodes` |
| `session.end` | Removes `extractSessionEndMemory` call; removes duplicate `observeBrain` from `handleSessionEnd` | Adds `session:<id>` node upsert + edges to observations |
| `memory.observe` | Retains `observeBrain` path (this is signal) | Adds `observation:<id>` node upsert |
| `memory.decide` | Retains `storeDecision` (adds dedup guard) | Adds `decision:<id>` node upsert + contradiction scan |
| `code.index` | Not addressed | Adds `file:<path>` and `symbol:<id>` shadow nodes |

**Assessment**: CA1 and CA2 are COMPATIBLE on hook behavior. CA1 fixes what fires in hooks (removing noise writers); CA2 specifies what the surviving hook calls write to the graph layer. They compose correctly. The risk is execution ordering — CA1 must run before CA2 to avoid wiring graph population hooks into the broken noise-generating code paths.

### 2.5 Wave Ordering Consistency

**CA1 Wave Plan**:
- Wave 1: Purge + Hook Fixes (stop the bleeding)
- Wave 2: Dedup Engine + Quality Scoring (typed tables)
- Wave 3: Embedding Activation
- Wave 4: Maintenance Automation

**CA2 Wave Plan**:
- Phase 1: Schema Migration (M-001, M-002 — extends brain_page_nodes/edges)
- Phase 2: Back-fill script for 57 existing entries
- Phase 3: Hook wiring for auto-population
- Phase 4: New CLI commands

**CA-Pipeline Wave Plan**:
- Wave 1: Schema + Contracts + Filesystem Walker + Structure Processor
- Wave 2: SymbolTable + Import Resolution + Parse Loop
- Wave 3: Call Resolution + Heritage + MRO
- Wave 4: Community Detection + Process Detection + CLI
- Wave 5: Worker Pool + Phase 14 + Incremental Re-index
- Wave 6: Additional Language Providers

**Cross-wave dependency analysis**:

| Dependency | Required Before | Status |
|-----------|-----------------|--------|
| CA1 Wave 1 (purge + hook fixes) | CA2 Phase 1 (schema migration) | MUST precede — cannot migrate graph schema while noise hooks are live |
| CA1 Wave 1 | CA2 Phase 2 (back-fill) | MUST precede — back-fill populates graph from the 57 real entries, not 2,955 noisy ones |
| CA1 Wave 2 (dedup engine) | CA2 Phase 3 (hook wiring) | SHOULD precede — hook wiring into `storePattern`/`storeLearning` would be wiring into the broken dedup path otherwise |
| CA-Pipeline Wave 1 (nexus schema) | CA2 Phase 3 (hook wiring for code.index events) | SHOULD precede — the `code.index` hook in CA2 creates `symbol:` nodes that reference nexus; nexus must exist |
| CA-Pipeline Wave 2 (parse loop) | CA2 Phase 3 (`code.index` hook) | Not strictly required — shadow nodes can exist before nexus data |

**Canonical ordering is possible**: CA1 → CA2 Phase 1-2 → CA-Pipeline Wave 1-2 → CA2 Phase 3-4 → CA-Pipeline Wave 3+

---

## Section 3: Gap Inventory

### G1: Migration path for existing `brain_memory_links` rows

**Spec**: CA2 Section 1.4 says "`brain_memory_links` is superseded by `brain_page_edges` for new entries. Existing rows are migrated to edges during Phase 3. The table is retained read-only for one release cycle then dropped."

**Gap**: CA2 Phase 3 spec does not include migration of the 5 existing `brain_memory_links` rows into `brain_page_edges`. The back-fill script in Phase 2 (`populateGraphFromTypedTables`) explicitly handles 5 categories but says "5. brain_memory_links (5 rows) → convert to edges" without specifying the edge type mapping:

| `brain_memory_links.link_type` | Proposed `brain_page_edges.edgeType` |
|--------------------------------|--------------------------------------|
| `produced_by` | `produced_by` (maps 1:1) |
| `applies_to` | `applies_to` (maps 1:1) |
| `informed_by` | `informed_by` (maps 1:1) |
| `contradicts` | `contradicts` (maps 1:1) |

The existing `BRAIN_LINK_TYPES = ['produced_by', 'applies_to', 'informed_by', 'contradicts']` maps directly to CA2's new `BRAIN_EDGE_TYPES`. This migration is straightforward but needs to be explicitly specified in the back-fill script.

**Severity**: Low — only 5 rows, but the spec should be explicit.

### G2: Schema migration ordering for `brain_page_nodes` node type enum

**Spec**: CA1 Wave 1 makes `extractTaskCompletionMemory` a no-op. CA2 Phase 1 expands `BRAIN_NODE_TYPES` from 4 to 12 values. The existing brain-schema.ts ENUM is `['task', 'doc', 'file', 'concept']`.

**Gap**: CA2 Phase 1 expands the enum. The Drizzle migration (M-001) must run before CA2 Phase 2 (back-fill) which creates nodes of new types like `'decision'`, `'pattern'`, `'learning'`, `'observation'`. However, the migration also implicitly removes the old `'doc'` type (not in CA2's new 12-type enum). Any code that checks `nodeType === 'doc'` would break.

Checking the live codebase: `brain-accessor.ts` lines 424-567 implement CRUD for `brain_page_nodes` using the 4-item enum. These accessors would need updating for the new 12-type enum.

**Severity**: Medium — requires coordinated update of accessor code in the same wave as schema migration.

### G3: Bridge table ownership and write path

**CA2** says: "The two graphs live in separate databases (brain.db vs nexus.db) but share a consistent ID namespace via the `symbol:<code_index.id>` convention." CA2 stores shadow nodes in `brain_page_nodes` with `nodeType='symbol'` or `nodeType='file'`. Bridge edges (`documents`, `references`) are in `brain_page_edges`.

**CA-Pipeline** says: Cross-graph edges live in a dedicated `nexus_brain_links` table in nexus.db. "Stored in nexus.db since brain.db is the source of truth for cognitive artifacts."

**Gap**: The two specs propose two different storage mechanisms for the same conceptual bridge:
- CA2: brain.db stores shadow nodes + bridge edges in `brain_page_edges`
- CA-Pipeline: nexus.db stores bridge edges in `nexus_brain_links`

Neither is wrong, but they are incompatible — implementing both creates two parallel cross-graph indexing systems. The `documents` and `applies_to` edge types appear in both `BRAIN_EDGE_TYPES` (CA2) and `NEXUS_BRAIN_LINK_TYPES` (CA-Pipeline).

**Write path not specified**: When a task is completed (CA2 Section 2.2, step 3), CA2 says "add edge `observation:<obsId> → applies_to → task:<id>`". This edge is in brain.db. When does a brain node write a `nexus_brain_links` row in nexus.db? Neither spec specifies who triggers `nexus_brain_links` inserts.

**Severity**: High — must resolve before implementation to avoid duplicated systems.

### G4: `qualityScore` in `brain_page_nodes` vs. `quality_score` in typed tables

**CA1** adds `quality_score REAL` column to `brain_patterns`, `brain_learnings`, `brain_decisions`, `brain_observations` with four different computation formulas.

**CA2** adds `qualityScore REAL` to `brain_page_nodes` with a unified formula (base_confidence * age_factor * edge_density_bonus * provenance_multiplier).

**Gap**: Two quality score systems exist after both specs are implemented:
1. Typed table quality scores (CA1) — type-specific formulas, stored in source tables
2. Graph node quality scores (CA2) — unified formula, stored in `brain_page_nodes`

The CA2 formula already incorporates type-specific base confidence values (decision `high=0.9`, etc.), essentially replicating the CA1 formula at the graph layer. The CA1 score also factors in FTS5 search ranking. The two scores will diverge over time as they have different decay rates and update triggers.

**Proposed resolution**: The graph node `qualityScore` (CA2) should be the canonical display/retrieval score. The typed table `quality_score` (CA1) can be retained as an input to CA2's formula computation (not as an independent score). CA1's search ranking and bridge generation logic should read from `brain_page_nodes.quality_score` where the node exists, falling back to the typed table score for entries not yet in the graph.

**Severity**: Medium — creates confusion and divergent rankings if not resolved.

### G5: `extractTaskCompletionMemory` becomes a no-op in CA1, but CA2 depends on task completion for graph wiring

**CA1** Section 5.2: "Intentionally empty. Task completion no longer auto-writes learnings."

**CA2** Section 2.2: When a task is completed, CA2 specifies:
1. Upsert `task:<id>` node
2. Add `part_of` edge to epic
3. Add `applies_to` edges from observations to task
4. Add `applies_to` edges from decisions to task

**Gap**: CA1 guts `extractTaskCompletionMemory()`. CA2's graph wiring for task completion must go somewhere. CA2 Section 8.3 says graph population is wired via hooks, specifically the `task:completed` CANT event. But CA1 says `extractTaskCompletionMemory` becomes a no-op and moves label pattern detection to maintenance.

These are NOT in conflict — CA2's graph wiring is a separate code path from CA1's learning/pattern extraction. CA2 writes to `brain_page_nodes` / `brain_page_edges`; CA1's no-op is for `brain_learnings` / `brain_patterns`. However, the implementation spec needs to be explicit: the `tasks.complete` hook should call CA2's graph wiring AND be a no-op for CA1's learning writes. The two concerns must be cleanly separated.

**Severity**: Low — requires implementation clarity but no design conflict.

### G6: `brain_embeddings` table and CA2's graph layer

**CA1** Section 6: Activates vector embeddings via `sqlite-vec`. Embeddings are stored in `brain_embeddings` (vec0 table) keyed to the typed table row IDs.

**CA2**: No mention of embeddings or `brain_embeddings`. The graph node quality scoring formula uses `edge_density_bonus` but not semantic similarity.

**Gap**: After CA1 Wave 3 activates embeddings, semantic similarity search returns results from `brain_embeddings`. After CA2 is implemented, nodes are in `brain_page_nodes`. Should `brain_embeddings` store vectors keyed to `brain_page_nodes.id` (the composite `'observation:O-*'` format) or to the original typed table row IDs?

The existing `brain-similarity.ts:searchSimilar()` queries `brain_embeddings` using typed table IDs. If CA2 moves to graph-native queries, either:
(a) `brain_embeddings` continues to use typed table IDs (requires ID translation in hybrid search), or
(b) `brain_embeddings` is re-keyed to graph node IDs (requires schema change and back-fill)

**Severity**: Low (embeddings are not core to CA1 or CA2 Wave 1-2), but must be decided before CA1 Wave 3.

### G7: `cleo nexus analyze` vs. `gitnexus analyze` disambiguation

**CA-Pipeline** defines `cleo nexus analyze` as the full pipeline command. The existing `CLAUDE.md` / AGENTS.md says "run `npx gitnexus analyze` in terminal first" for index freshness.

**Gap**: After CA-Pipeline is implemented, `cleo nexus analyze` replaces `npx gitnexus analyze` for CLEO projects. The CLAUDE.md instructions and PostToolUse hook (mentioned in AGENTS.md) will be stale. This is a documentation gap, not a spec conflict.

**Severity**: Low — post-implementation documentation update required.

---

## Section 4: Risk Register

### 4.1 CA1 (Brain Integrity) — Top 5 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1.1 | **Purge SQL deletes real entries**: Rule 6 (delete test decisions) pattern `lower(rationale) LIKE '%test%' AND type = 'process'` could match the one real decision if its rationale contains the word "test" | Low | Critical | Pre-purge: run a SELECT with each DELETE's WHERE clause and verify the specific real decision (D-mntpeeer) is not in the result set before executing |
| R1.2 | **FTS5 content-sync triggers do not fire for raw SQL DELETEs**: The purge SQL runs via `cleo backup` / raw SQL; if FTS5 `_ad` triggers require Drizzle-layer operations, the FTS5 tables will be inconsistent after purge | Medium | High | The spec already calls for `rebuildFts5Index()` post-purge; ensure this runs before any search operation after purge |
| R1.3 | **`initDefaultProvider()` called before sqlite-vec loads**: The wiring in Section 6.3 calls embedding init async in the `getBrainDb()` hot path; if `sqlite-vec` fails to load (ABI mismatch), the async void swallows the error silently | Medium | Medium | Add explicit logging when `_vecLoaded = false` after the require attempt; wrap the async init in an error handler that sets `_embeddingAvailable = false` explicitly |
| R1.4 | **Quality score backfill performance**: `cleo brain score --rebuild` recomputes scores for all entries. With only 57 entries post-purge, this is fast. But the score formula reads multiple fields from each row — if patterns re-accumulate before the rebuild, this could be slow | Low | Low | The 57-entry baseline makes this negligible; monitor after 30 days of normal usage |
| R1.5 | **Weakest assumption — "Completed:" learnings are all noise**: The purge deletes ALL learnings where `insight LIKE 'Completed: %'`. If any agent wrote a genuinely informative learning with that prefix (e.g., `"Completed refactoring: the async pattern now requires explicit error boundaries"`), it will be deleted | Low | Medium | Accept the loss — the R1 audit confirmed zero genuine learnings survived the review, and the dedup engine (Wave 2) will prevent future quality learnings from being accidentally formatted as "Completed:" entries |

### 4.2 CA2 (Memory SDK) — Top 5 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R2.1 | **Contradiction detection false positives**: Stage 1 SQL uses `json_each()` on `metadataJson.keywords`. If `metadataJson` is null or keywords field is absent, `json_each()` returns 0 rows, silently skipping the node rather than erroring. But any node without keywords populated will NEVER be checked for contradictions | High | Medium | The back-fill script (Phase 2) must populate `metadataJson.keywords` for all 57 existing entries; new write paths must compute keywords at insert time |
| R2.2 | **Cycle detection in traversal CTE**: The `path NOT LIKE ('%' || target.id || '%')` cycle guard uses substring matching on the path string. If a node ID contains another node ID as a substring (e.g., `task:T52` and `task:T523`), this guard produces false positives, cutting off valid traversal paths | Medium | Medium | Use pipe-separated `path` with delimiters: `'|' || target.id || '|'` not just substring; or use a depth limit without path-based cycle detection (since maxDepth=3 prevents infinite loops anyway) |
| R2.3 | **Bidirectional shortest-path BFS implementation complexity**: Section 4.3 specifies an application-layer bidirectional BFS. SQLite recursive CTEs for single-direction BFS work fine, but bidirectional requires multiple round-trips and frontier intersection detection in TypeScript. This is the most complex algorithm in the spec | High | Medium | Implement single-direction BFS first (6 hops from one end) and validate; add bidirectional as an optimization in a follow-up task |
| R2.4 | **Weakest assumption — "Option C Hybrid is right": The hybrid design preserves the typed tables and layers a graph on top. The graph layer will diverge from typed tables if any write path hits the typed table without updating `brain_page_nodes`. This creates a consistency drift problem | Medium | High | All write paths (storePattern, storeLearning, storeDecision, observeBrain) must be wrapped to call `graphSDK.store()` atomically. A write to a typed table without a corresponding graph node upsert is a bug. This requires strict discipline in CA2 Phase 3 hook wiring |
| R2.5 | **Graph consolidation aggressive merging**: Section 6.2 downgraded member quality: `qualityScore *= 0.3`. A node with quality=0.9 becomes 0.27 after consolidation — below the 0.3 exclusion threshold used in bridge generation and search. Real signal nodes will be hidden if they get consolidated incorrectly | Medium | High | Raise the minimum cluster size for consolidation (start at 8 nodes, not 4); exclude nodes with `qualityScore > 0.8` from consolidation candidates (high-quality nodes should never be merged away) |

### 4.3 CA-Pipeline (GitNexus Port) — Top 5 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R3.1 | **Call resolution deferred creates a bad Wave 3 dependency**: Wave 3 implements Tier 1 and Tier 2a call resolution. But Phase 5 (community detection, Wave 4) REQUIRES CALLS edges for meaningful clusters. If call resolution in Wave 3 is incomplete (missing many calls), communities in Wave 4 will be low-quality and process detection in Phase 6 will be inaccurate | Medium | Medium | Accept this as an iterative quality improvement; Wave 4's communities are "better than nothing" and will improve in Wave 5 when full call resolution arrives |
| R3.2 | **`graphology-communities-louvain` Louvain quality vs. Leiden**: The spec explicitly chooses Louvain over Leiden. For large codebases with many small interconnected modules (like `cleocode`'s monorepo), Louvain may merge distinct packages into single communities. Community quality degrades with smaller, more numerous communities | Medium | Medium | Use resolution parameter 2.0 instead of 1.0 for monorepo codebases — higher resolution produces more, smaller communities that respect package boundaries |
| R3.3 | **`nexus_brain_links` write path undefined**: Section 12 defines the `nexusBrainLinks` table schema but never specifies when or how rows are inserted. The "Show Me All Decisions About This Function" query assumes `nexus_brain_links` has data, but no hook or pipeline phase writes to it | High | High | This is a critical gap (see G3). A write path must be defined: either (a) add a CA2 Phase 3 hook that writes `nexusBrainLinks` when brain nodes that reference nexus IDs are created, or (b) add a `cleo nexus link` CLI command for explicit linkage |
| R3.4 | **Weakest assumption — "In-memory KnowledgeGraph scales to cleocode"**: The spec uses an in-memory graph (Map<string, GraphNode>) for the full analysis run. The cleocode monorepo has 21,142 symbols and 42,339 relationships. Each `GraphNode` at ~500 bytes + relations array = ~50MB at minimum. The spec says this is fine ("avoid the complexity of writing to SQLite mid-ingestion") but does not validate the memory assumption | Medium | Medium | Add a memory budget check at Phase 1: if estimated graph size > 500MB (based on file count * average node size), enable streaming mode that flushes chunks to DB. At current scale, cleocode should be ~50-100MB, well within Node.js defaults |
| R3.5 | **Highest-risk design decision — single `nexus_nodes` table for 30+ node kinds**: The spec uses one table with a `kind` text discriminator instead of 28 separate tables (as LadybugDB uses). This is correct for CLEO's scale, but the `metaJson` blob carries kind-specific metadata without schema enforcement. Process nodes, community nodes, and route nodes all have different metadata shapes stored as unvalidated JSON | Medium | Low | Define TypeScript union types for `metaJson` per node kind in `packages/contracts/src/graph.ts`; validate at write time in the flush function. This prevents runtime failures from malformed metadata |

---

## Section 5: Specific Conflicts and Resolutions

### Conflict C1: `BRAIN_EDGE_TYPES` enum replacement removes existing types

**Problem**: The current live `brain-schema.ts` has `BRAIN_EDGE_TYPES = ['depends_on', 'relates_to', 'implements', 'documents']`. CA2 replaces this with a 13-type enum that removes `depends_on`, `relates_to`, and `implements`. CA1 Wave 1 references the current schema without addressing this replacement.

**Resolution**: CA2's Phase 1 migration (M-002) must explicitly address the 3 removed types:
- `depends_on` → replace with `derived_from` in any existing edges (0 existing rows, so no data migration needed; but accessor code referencing `'depends_on'` must be updated)
- `relates_to` → no equivalent in CA2's enum; observations that previously "related to" something now need a more specific edge type
- `implements` (brain edge) → the concept is covered by `informed_by` or `applies_to` depending on semantics

**Action required**: CA2 Phase 1 spec should add an explicit enum transition table mapping old types to new types. Since `brain_page_edges` has 0 rows, no data migration is needed, but code referencing old enum values in `brain-accessor.ts` must be updated.

### Conflict C2: Schema file placement

**Problem**: CA1 Appendix A says "store brain-schema.ts: quality_score column added via migration (NOT in schema file directly)." CA-Pipeline Section 1.2 says "File: `packages/core/src/store/nexus-schema.ts`" for both `nexus_nodes` and `nexus_relations`. CA2 mentions extending `brain-schema.ts`. These are different files for different databases.

**No actual conflict**: CA1/CA2 modify `packages/core/src/store/brain-schema.ts` (brain.db). CA-Pipeline modifies `packages/core/src/store/nexus-schema.ts` (nexus.db). These are separate files for separate databases. The apparent confusion arises because CA-Pipeline says "extend the existing file" — this is correct (nexus-schema.ts already has project_registry, etc.).

**Recommendation**: Make the distinction explicit in both specs. The two schema files serve different databases and must never be merged.

### Conflict C3: Cross-graph bridge storage

**Problem**: CA2 stores bridge links as `brain_page_edges` rows with `fromId` referencing a brain node and `toId` referencing a nexus node ID. CA-Pipeline defines `nexusBrainLinks` table in nexus.db for the same conceptual links.

**Proposed resolution**:
- Keep CA2's shadow nodes (`brain_page_nodes` with `nodeType='symbol'/'file'`) — these enable brain-side traversal to reach code concepts
- Keep CA-Pipeline's `nexusBrainLinks` table — this enables nexus-side traversal to reach brain concepts
- **Remove** the cross-graph edges from `brain_page_edges` (`documents`, `references` edges where `toId` points to nexus concepts) — these would create unresolvable FK-like references in brain.db
- The `documents` and `references` edge types in CA2's `BRAIN_EDGE_TYPES` should only apply to brain-to-brain edges, not brain-to-nexus edges
- Brain-to-nexus linkage uses the shadow node pattern (CA2): brain observation creates a `file:src/foo.ts` node, which is its own entity in brain.db
- Code-to-brain linkage uses `nexusBrainLinks` (CA-Pipeline): nexus analysis writes a link from `nexus_node.id` to `brain_page_node.id`

**Write path for `nexusBrainLinks`**: A post-analysis enrichment step in `cleo nexus analyze` scans `brain_page_nodes` for `nodeType='file'` and `nodeType='symbol'` nodes, matches them against existing `nexus_nodes` by ID, and writes `nexusBrainLinks` rows for each match.

### Conflict C4: Dual quality score systems

**Problem**: CA1 adds `quality_score REAL` to `brain_patterns`, `brain_learnings`, `brain_decisions`, `brain_observations`. CA2 adds `qualityScore REAL` to `brain_page_nodes`. Both compute quality scores but with different formulas and update triggers.

**Proposed resolution**: Designate CA2's `brain_page_nodes.qualityScore` as the **canonical retrieval score** (used for search ranking and bridge generation). CA1's typed table scores become **input signals** to CA2's formula, not independent rankings.

**Implementation**:
1. CA1 Wave 2: Add `quality_score REAL` to typed tables — but rename CA1's operation to `source_quality_score` to distinguish from the graph score
2. CA2 Phase 2: Compute `brain_page_nodes.qualityScore` using the unified formula, where `base_confidence` reads from the typed table's `source_quality_score`
3. Update CA1's search ranking (Section 3.5) to read `brain_page_nodes.qualityScore` where the graph node exists, falling back to the typed table score

This avoids running two independent quality decay cycles on the same entries.

---

## Section 6: Recommended Changes

### Required Changes (implementation blocked without these)

**RC1 — CA2 must explicitly specify the resolution of removed edge types**

In CA2 Phase 1 (Schema Migration), add an enum transition note:
```
Removed from BRAIN_EDGE_TYPES: ['depends_on', 'relates_to', 'implements']
Action: Update brain-accessor.ts and any code referencing these string literals.
Replacement mapping: depends_on → derived_from, relates_to → (none — use informed_by or applies_to), implements → applies_to
Data migration: not needed (0 rows in brain_page_edges).
```

**RC2 — CA-Pipeline must specify the nexusBrainLinks write path**

Add to CA-Pipeline Section 12.2:
```
Write path: After `cleo nexus analyze` completes the full pipeline flush, run a post-analysis bridge scan:
1. Load all `brain_page_nodes` where `nodeType IN ('symbol', 'file')` from brain.db
2. For each such node, extract the nexus node ID from the composite ID (e.g., 'symbol:src/foo.ts::bar' → 'src/foo.ts::bar')
3. Check if `nexus_nodes` has a row with that ID
4. If yes: upsert a `nexus_brain_links` row with `linkType='documents'`
This runs as a new Phase 7 post-flush step, or as a scheduled `cleo nexus link-brain` command.
```

**RC3 — Resolve the dual quality score system before implementation begins**

Adopt the proposal in C4 resolution: rename CA1's typed-table scores to `source_quality_score` and designate CA2's graph node scores as canonical. Update CA1 Section 3.5 (search ranking and bridge) to reference graph node scores.

**RC4 — Add minQuality protection for graph consolidation**

In CA2 Section 6.2 (graph-based consolidation), add to Step 4:
```
Exclusion from consolidation candidates:
- Nodes with qualityScore > 0.8 are NEVER downgraded via consolidation
- Nodes with nodeType IN ('task', 'session', 'epic') are structural and NEVER consolidated
- Only 'observation', 'learning', 'pattern' nodes are eligible for consolidation merging
```

### Recommended Changes (implementation quality improved with these)

**RR1 — CA2 cycle detection improvement**

Replace the substring cycle guard in the traversal CTE with a delimiter-wrapped check:
```sql
AND ('|' || g.path || '|') NOT LIKE ('%|' || target.id || '|%')
```

**RR2 — CA-Pipeline use Louvain resolution 2.0 for monorepos**

In Phase 5 implementation, detect if project has `workspaces` in `package.json` and use resolution `2.0` instead of `1.0` for monorepo projects.

**RR3 — CA1 safety check for the one real decision**

Before executing Rule 6 (delete test decisions), run:
```sql
SELECT id, decision FROM brain_decisions WHERE id = 'D-mntpeeer';
-- Must return 1 row before proceeding with Rule 6
```

**RR4 — CA2 back-fill must compute keywords for all 57 entries**

`populateGraphFromTypedTables()` must also populate `metadataJson.keywords` for each node it creates; otherwise contradiction detection will silently skip all existing entries.

**RR5 — CA-Pipeline incremental mode needs explicit delete before re-parse**

Section 3.3 says "Delete all nexus_nodes and nexus_relations rows for changed files before re-analysis." This should be an atomic transaction: DELETE + INSERT for changed files must either both complete or both rollback. Add explicit transaction wrapping.

---

## Section 7: Unified Wave Plan

The following is the corrected, unified ordering that accounts for all inter-spec dependencies:

### Pre-Work (must complete before any wave)

- Take backup of brain.db (`cleo backup add`)
- Verify backup exists
- Run safety check queries from CA1 Section 1.2

### Wave A: Brain Integrity — Stop the Bleeding (CA1 Wave 1)

**Scope**: Purge noise + fix hooks
**Specs**: CA1 Sections 1, 4, 5
**Acceptance**: brain.db ≤ 70 entries; no new noise on session end/task complete
**Duration sizing**: small

### Wave B: Schema Foundation (CA2 Phase 1 + CA-Pipeline Wave 1)

**Scope**: Expand brain.db graph schema + create nexus graph schema + expand contracts
**Specs**: CA2 Phase 1 (M-001, M-002), CA-Pipeline Wave 1
**Acceptance**: `brain_page_nodes` has 8 columns; `nexus_nodes` + `nexus_relations` tables exist; `GraphNodeKind`/`GraphRelationType` fully expanded; `pnpm run build` passes
**Duration sizing**: medium
**Parallelizable**: CA2 Phase 1 and CA-Pipeline Wave 1 can run in parallel (separate files, separate databases)
**Prerequisite**: Wave A complete (so graph schema migration runs on clean data)

### Wave C: Brain Back-fill + Dedup Engine (CA2 Phase 2 + CA1 Wave 2)

**Scope**: Populate graph from 57 real entries + fix dedup in typed table stores
**Specs**: CA2 Phase 2, CA1 Wave 2
**Acceptance**: `brain_page_nodes` has 57 nodes; `storePattern` upserts correctly; quality scores computed
**Duration sizing**: medium
**Prerequisite**: Wave B complete (new schema must exist before back-fill)

### Wave D: Nexus Parse Pipeline (CA-Pipeline Wave 2)

**Scope**: SymbolTable + TypeScript import resolution + sequential parse loop
**Specs**: CA-Pipeline Wave 2
**Acceptance**: `cleo nexus analyze` on packages/nexus/src produces nexus_nodes rows
**Duration sizing**: large
**Prerequisite**: Wave B complete (schema and contracts must exist)

### Wave E: Call Resolution + Heritage + Brain Hook Wiring (CA-Pipeline Wave 3 + CA2 Phase 3)

**Scope**: EXTENDS/IMPLEMENTS/CALLS edges + brain graph auto-population hooks
**Specs**: CA-Pipeline Wave 3, CA2 Phase 3
**Acceptance**: Call relations resolved; brain hooks write graph nodes; nexusBrainLinks populated after analyze
**Duration sizing**: large
**Prerequisite**: Waves C + D complete; RC2 bridge write path implemented

### Wave F: Embedding Activation + Brain CLI Commands (CA1 Wave 3 + CA2 Phase 4)

**Scope**: sqlite-vec + embedding backfill + new memory graph CLI commands
**Specs**: CA1 Wave 3, CA2 Phase 4
**Acceptance**: Vector search functional; `cleo memory trace`, `cleo memory context` etc. work
**Duration sizing**: medium
**Prerequisite**: Wave C complete (dedup engine live before embedding backfill)

### Wave G: Community + Process Detection + Nexus CLI (CA-Pipeline Wave 4)

**Scope**: Louvain community detection + BFS process detection + all nexus CLI commands
**Specs**: CA-Pipeline Wave 4
**Acceptance**: `cleo nexus clusters` returns ≥ 3 communities; `cleo nexus flows` returns ≥ 1 process
**Duration sizing**: large
**Prerequisite**: Wave E complete (needs CALLS edges for meaningful communities)

### Wave H: Performance + Maintenance Automation (CA1 Wave 4 + CA-Pipeline Wave 5)

**Scope**: Worker pool + Phase 14 + brain maintenance automation + quality score rebuild
**Specs**: CA1 Wave 4, CA-Pipeline Wave 5
**Acceptance**: Incremental mode handles deletions; maintenance cycle runs clean; worker pool activates
**Duration sizing**: large
**Prerequisite**: Wave G complete

### Wave I: Additional Language Providers (CA-Pipeline Wave 6)

**Scope**: Python, Rust, Go providers
**Specs**: CA-Pipeline Wave 6
**Acceptance**: Python + Rust + Go files produce nexus nodes
**Duration sizing**: large (one per sub-task)
**Prerequisite**: Wave H complete

---

## Section 8: Source of Truth Verification

### Section 2 Core Invariants (BRAIN Spec)

| Invariant | CA1 Compliance | CA2 Compliance | CA-Pipeline Compliance |
|-----------|---------------|----------------|----------------------|
| Stable task identity (T### never change) | PASS — purge only touches brain.db, not task IDs | PASS — task nodes use `task:T###` composite IDs | PASS — not relevant to code pipeline |
| Atomic writes (temp→validate→backup→rename) | PASS — Section 1.1 mandates backup first | PASS — upsert semantics are atomic | PASS — batch flush uses transactions |
| Validation-first enforcement | PASS — safety check queries must pass before purge | PASS — content hash dedup is validation | PASS — schema validation at flush |
| Append-only audit trail | PASS — audit_log not touched by CA1 | PASS — CA2 doesn't modify audit_log | PASS — phase errors go to `nexus_audit_log` |
| Machine-first output | PASS — all new commands use LAFS envelope | PASS — contradictions output uses LAFS | PASS — all CLI commands use JSON envelope |
| Explicit lifecycle enforcement | PASS — hook gating is explicit | PASS — wave phases are explicit gates | PASS — wave dependencies are explicit |

### Section 11 BrainConfig Feature Flags

| Flag | CA1 Behavior | CA2 Behavior |
|------|-------------|-------------|
| `autoCapture: true` | Controls session observation write; defaults to NOT controlling whether graph hooks fire (hook fixes unconditionally disable noise, not gated by config) | Graph population hooks should also check `autoCapture`; CA2 spec does not explicitly state this |
| `embedding.enabled: false` | Controls `initDefaultProvider()` call; Section 6.3 correctly gates on config | Not addressed — CA2 should clarify that quality scoring in `brain_page_nodes` is NOT gated by embedding config (it uses no embeddings) |
| `memoryBridge.autoRefresh: true` | CA1 retains bridge refresh | CA2 adds graph summary to bridge output; should be gated by same flag |

**Gap**: CA2 does not specify whether graph auto-population hooks respect `autoCapture`. The BRAIN spec says `autoCapture: true` controls all lifecycle captures. CA2 should add: "All graph population hooks (task:completed, session:ended, brain:observed, brain:decided) are gated on `brain.autoCapture`. If `autoCapture = false`, no graph writes occur from hook calls — only from explicit `graphSDK.store()` calls."

### Section 13.1.4 CLI Command Compatibility

**Existing commands that must not break**:
- `cleo memory find` — CA2 does not modify; only adds new commands
- `cleo memory fetch` — CA2 does not modify
- `cleo memory timeline` — CA2 does not modify
- `cleo memory observe` — CA2 adds graph node upsert on this path; the write still completes if graph fails
- `cleo memory graph.add`, `graph.show`, `graph.neighbors`, `graph.remove` — CA2 expands the graph schema; existing commands that call these APIs must be verified against new enum types

**Risk**: `cleo memory graph.add` currently accepts `nodeType` from the old 4-item enum. After CA2 Phase 1 expands to 12 types, this command should accept all 12 types. If the CLI validation is enum-locked to the old 4 values, new node types will be rejected.

**Required**: CA2 Phase 4 (new CLI commands) must also update any existing graph commands that reference old enum values.

### Section 15 Phase Alignment

The CA1 + CA2 specs are implementing the **Base (Memory) dimension** and belong in **Phase 2 (Intelligence, Months 5-9)** of the BRAIN spec. The CA-Pipeline spec implements the **Network/Code Intelligence** layer.

The BRAIN spec's Phase 2 precondition: "Phase 1 validation MUST pass for Nexus AND the CLI dispatch surface." Given that the Nexus validation gate (Section 13.5.2) is "PENDING" (zero real-world usage data), strictly speaking, CA-Pipeline Wave 1+ should be contingent on Nexus validation. However, this constraint was set for the cross-project semantic search feature, not for the code intelligence pipeline. The T513 pipeline work is building the code intelligence capability — it is the thing that will generate usage data for the validation gate.

**Recommendation**: Treat the code intelligence pipeline (T513) as the path to satisfying the Nexus validation gate, not as contingent on it.

---

## Section 9: Sign-Off Statement

### Conditions for Full Implementation Authorization

This cross-specification review certifies that:

1. **CA1 (Brain Integrity)** is internally consistent, grounded in actual code paths, and ready for implementation with the following conditions:
   - RC3 (dual quality score system) must be resolved before Wave 2 (CA1's quality score columns may conflict with CA2's graph quality scores)
   - RC1 (edge type enum removal) must be accounted for in Wave 1 even though brain_page_edges has 0 rows

2. **CA2 (Memory SDK)** is architecturally sound and well-grounded in LadybugDB patterns applied to SQLite, but requires:
   - RC1: Edge type transition table (removing `depends_on`, `relates_to`, `implements`)
   - RC4: Consolidation exclusion for high-quality nodes
   - RR1: CTE cycle detection fix
   - RR4: Keywords population in back-fill
   - Explicit statement that graph hooks respect `autoCapture` config flag
   - Removal of cross-DB `brain_page_edges` bridge edges (replace with shadow node pattern only, per C3 resolution)

3. **CA-Pipeline (GitNexus Port)** is the most complete and implementation-ready of the three specs. Requires:
   - RC2: Define the `nexusBrainLinks` write path explicitly
   - RR2: Use Louvain resolution 2.0 for monorepo detection
   - RR5: Atomic DELETE+INSERT for incremental re-index

4. **The unified wave plan (Section 7)** defines a conflict-free execution order. Wave A must complete before any other wave. Waves B-C-D can be parallelized partially. All others are sequential.

### Risks Accepted

The following risks are accepted as implementation proceeds:
- R1.5 (loss of "Completed:"-formatted genuine learnings) — accepted; the audit found zero such entries
- R3.1 (Wave 4 communities built on incomplete call graph) — accepted; iterative quality improvement
- R3.4 (in-memory graph memory assumption) — accepted at cleocode's current scale

### Authorization

**Overall status**: CONDITIONAL PASS

**Proceed to implementation**: YES, with Wave A (CA1 brain purge) authorized immediately. All subsequent waves require the conditions above to be addressed in the spec before implementation work begins.

**Signed**: Validator — Cross-Specification Consistency Reviewer, 2026-04-11

---

## Appendix: Files Reviewed

| File | Purpose |
|------|---------|
| `.cleo/agent-outputs/T523-R1-brain-audit-report.md` | Source of truth for brain.db noise data |
| `.cleo/agent-outputs/T523-R2-ladybugdb-architecture-study.md` | Graph model reference |
| `.cleo/agent-outputs/T523-R3-memory-system-code-review.md` | Live code analysis |
| `.cleo/agent-outputs/T513-R-gitnexus-pipeline-architecture.md` | GitNexus pipeline architecture |
| `.cleo/agent-outputs/T523-CA1-brain-integrity-spec.md` | Brain integrity implementation spec |
| `.cleo/agent-outputs/T523-CA2-memory-sdk-spec.md` | Memory SDK implementation spec |
| `.cleo/agent-outputs/T513-CA-pipeline-spec.md` | Pipeline implementation spec |
| `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md` | BRAIN canonical specification (Authority Level 2) |
| `packages/contracts/src/graph.ts` | Current graph contract definitions |
| `packages/core/src/store/brain-schema.ts` | Current brain.db schema |
| `packages/nexus/src/schema/code-index.ts` | Current nexus code index schema |
