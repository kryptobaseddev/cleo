# cleo nexus — Revised Gap Analysis & Living Brain Decomposition Plan

**Task**: T1048 (Lead/Synthesizer — revision of T1047)
**Epic**: T1042
**Date**: 2026-04-20
**Supersedes**: `.cleo/agent-outputs/T1042-nexus-gap/RECOMMENDATION.md` (V1, T1047)
**Wave 0 Sources**: T1043 (gitnexus surface), T1044 (cleo nexus surface), T1045 (gitnexus runs), T1046 (cleo nexus runs)
**New Audit Sources**: Live CLI help introspection; source reads across packages/core/src/memory/, packages/core/src/sentient/, packages/nexus/src/; docs/plans/brain-synaptic-visualization-research.md

---

## 1. Executive Summary (Revised)

The strategy is not parity with gitnexus. It is supersession via architectural difference.

cleo nexus stops being a standalone code-graph and becomes the **code-plane of a unified 5-substrate living brain**: BRAIN + NEXUS + TASKS + CONDUIT + SIGNALDOCK, with Hebbian/STDP plasticity weights on edges and symbol-level traversal across all substrates. This is structurally impossible for gitnexus to replicate because it has no task layer, no memory substrate, and no plasticity engine.

The audit reveals a critical discovery that V1 missed: **partial BRAIN×NEXUS cross-substrate integration is already shipped**. The `cleo memory` domain exposes `code-links`, `code-auto-link`, `code-memories-for-code`, `code-for-memory`, and `search-hybrid` (FTS5 + vector + graph RRF fusion). The `packages/core/src/memory/` directory contains `graph-memory-bridge.ts`, `nexus-plasticity.ts`, `edge-types.ts` with 8 canonical cross-substrate edge types, and `brain-links.ts` with task↔memory linking. The `sentient/ingesters/nexus-ingester.ts` already produces proposals from code-graph anomalies. Plasticity Hebbian strengthening on `nexus_relations.weight` is shipped as T998. The Living Brain Phase 1–2 visualization is shipped in `packages/studio/`.

**What is missing is not the foundation — it is the completion of the cross-substrate graph wiring and the query primitives to traverse it.** Specifically: `documents`, `modified_by`, `affects`, and `mentions` edges in `brain_page_edges` are schema-defined but have 0 live rows. The `TASKS→NEXUS` bridge (task touches symbol) is entirely absent. The conduit→symbol ingestion pipeline does not exist. The `reason-why` command operates on task dependency chains only — it does not trace through code symbols or brain observations. No SDK function exists to answer "show me the full context of this symbol: what tasks touched it, what brain observations mention it, what decisions were made about it, what sentient proposals concern it."

The three-epic plan below closes these gaps in dependency order: (1) P0 — Core Query Power gives cleo a DSL, semantic search, source retrieval, wiki, and hook augmenter so it stops losing raw code-intelligence benchmarks; (2) P1 — Competitive Closure fixes edge coverage, community granularity, route/API surface, and contract registry; (3) P2 — Living Brain completes the cross-substrate graph wiring and exposes the traversal primitives that are cleo's permanent moat.

---

## 2. What Already Exists (Cross-Substrate Wiring Audit)

The following table maps the existing integration surface. Every row was verified against source code or CLI help output. "Unwired" means the SDK primitive exists but no CLI verb exposes it. "Partial" means the code runs but produces no data under normal conditions (confirmed by live-DB state from docs/plans/brain-synaptic-visualization-research.md §4.1).

| Feature | Location in packages/core | CLI entry point | Status |
|---|---|---|---|
| BRAIN↔NEXUS `code_reference` edges (auto-link on entity scan) | `memory/graph-memory-bridge.ts` — `autoLinkMemories()` | `cleo memory code-auto-link` | **Shipped** — 2,669 live `code_reference` rows |
| Show memory nodes linked to a code symbol | `memory/graph-memory-bridge.ts` — `queryMemoriesForCode()` | `cleo memory code-memories-for-code <symbol>` | **Shipped** |
| Show code nodes linked to a memory entry | `memory/graph-memory-bridge.ts` — `queryCodeForMemory()` | `cleo memory code-for-memory <memoryId>` | **Shipped** |
| Show all code↔memory edges (code_reference) | `memory/graph-memory-bridge.ts` | `cleo memory code-links` | **Shipped** |
| Hybrid search: FTS5 + vector + graph RRF over BRAIN entries | `memory/brain-retrieval.ts` — `hybridSearch()` + `searchBrain()` | `cleo memory search-hybrid <query>` | **Shipped** — searches BRAIN, NOT nexus symbols |
| Hebbian plasticity on `nexus_relations.weight` | `memory/nexus-plasticity.ts` — `strengthenNexusCoAccess()` | No direct CLI verb (fires via consolidation) | **Shipped (code)** / Partial (0 rows strengthened — BUG-2: comma vs JSON format mismatch in `entry_ids`) |
| BRAIN graph BFS traversal | `memory/brain-search.ts` | `cleo memory trace <nodeId>` | **Shipped** |
| BRAIN graph 360-degree context | `memory/graph-queries.ts` | `cleo memory context <nodeId>` | **Shipped** |
| BRAIN graph 1-hop neighbors | `memory/graph-queries.ts` | `cleo memory related <nodeId>` | **Shipped** |
| BRAIN graph stats | `memory/graph-queries.ts` | `cleo memory graph-stats` | **Shipped** |
| Task→brain link (memory linked to task ID) | `memory/brain-links.ts` — `linkMemoryToTask()`, `getTaskLinks()` | `cleo memory link <taskId> <entryId>` | **Shipped** |
| Causal trace (task→upstream blocker→brain decisions) | `memory/brain-reasoning.ts` — `reasonWhy()` | `cleo memory reason-why <taskId>` | **Shipped** — task chain only, no symbol traversal |
| Semantic similarity across brain entries | `memory/brain-similarity.ts` | `cleo memory reason-similar <entryId>` | **Shipped** |
| NEXUS Tier-2 sentient proposals (orphaned callees, over-coupled nodes) | `sentient/ingesters/nexus-ingester.ts` — `runNexusIngester()` | Fires automatically via `cleo sentient tick` | **Shipped** — 2 detectors; no community fragmentation or entry-point erosion detector |
| BRAIN↔NEXUS Hebbian pair extraction from retrieval log | `memory/nexus-plasticity.ts` — `extractNexusPairsFromRetrievalLog()` | No CLI verb | **Shipped (code)** / Partial (0 pairs extracted — format bug + sparse log) |
| BRAIN `applies_to` edges (observation→task reference via text extraction) | `memory/graph-auto-populate.ts` | No direct CLI verb (fires on observe) | **Partial** — 120 live rows via text-ref backfill; dedicated decision→task writer missing |
| BRAIN `co_retrieved` edges (Hebbian co-retrieval within session) | `memory/brain-lifecycle.ts` — `strengthenCoRetrievedEdges()` | No direct CLI verb | **Partial** — 0 live rows (threshold ≥3 pairs not met; BUG-2) |
| NEXUS code symbol context (callers/callees/community/process) | `nexus/` via pipeline | `cleo nexus context <symbol>` | **Shipped** — no `--content` flag, no source retrieval |
| NEXUS code impact BFS (blast radius) | `packages/nexus/src/intelligence/impact.ts` — `analyzeImpact()` | `cleo nexus impact <symbol>` | **Shipped** — no task cross-reference |
| NEXUS community detection (Louvain) | `packages/nexus/src/pipeline/community-processor.ts` | `cleo nexus clusters` | **Shipped** — Louvain only; no Leiden; `member_of` edges not emitted |
| NEXUS execution flows | `packages/nexus/src/pipeline/process-processor.ts` | `cleo nexus flows` | **Shipped** |
| NEXUS incremental diff (git commit comparison) | `packages/cleo/src/cli/commands/nexus.ts` — `diffCommand` | `cleo nexus diff` | **Shipped** — cannot checkout git refs |
| NEXUS GEXF export with plasticity weights | `packages/cleo/src/cli/commands/nexus.ts` — `exportCommand` | `cleo nexus export` | **Shipped** |
| Source content retrieval (`smartUnfold`) | `packages/nexus/src/code/unfold.ts` — `smartUnfold()` | **NOT exposed** | **Unwired** — SDK function exists, no `cleo nexus context --content` |
| Code symbol search across live filesystem | `packages/nexus/src/code/search.ts` — `smartSearch()` | **NOT exposed** (only TASKS search in `cleo nexus search`) | **Unwired** — `smartSearch()` implemented, no CLI verb |
| NEXUS `documents`/`applies_to` edge writers | `nexus-schema.ts` — enum defined | None | **Missing** — enum declared in `NEXUS_RELATION_TYPES` (lines 275–276), 0 live rows, no writer |
| `modified_by` / `affects` / `mentions` edge writers | `memory/edge-types.ts` EDGE_TYPES constant | None | **Missing** — constants defined, no writer for any of the three |
| TASKS→NEXUS bridge (task touches symbol/file) | None | None | **Missing** — no schema, no writer, no query |
| CONDUIT→NEXUS ingestion (message NER → symbol linking) | None | None | **Missing** |
| `reason-why` extended to code symbols | Partial in `brain-reasoning.ts` | `cleo memory reason-why` (tasks only) | **Unwired** — BRAIN reasoning does not follow `code_reference` edges to symbol nodes |
| `getSymbolFullContext()` traversal primitive (symbol→tasks+memories+proposals) | None | None | **Missing** — the key living brain query primitive |
| Hook augmenter (PreToolUse→nexus context injection) | `packages/adapters/src/providers/claude-code/hooks.ts` — PreToolUse is wired to CAAMP but no nexus handler | None | **Missing** — CAAMP PreToolUse event infrastructure exists; no nexus injection handler |

---

## 3. V1 Corrections (Explicit)

### MCP Layer Misframing (Critical)

V1's P0 list included "MCP tool surface for code graph" rated CRITICAL and proposed `EP1-T5: MCP Tool Suite for Code Graph` as a standalone epic task. This is wrong on architecture. The package-boundary contract in AGENTS.md is explicit: `packages/core/` owns SDK runtime primitives, `packages/cleo/` owns CLI dispatch. There is no MCP layer in this stack. MCP overhead is explicitly rejected.

The corrected framing: agents access code graph operations via `cleo nexus <verb>` CLI calls (already how Pi harness agents operate). The hook augmenter writes a PreToolUse handler that shells to `cleo nexus augment` — not an MCP server. Every P0 primitive lives in `packages/core/src/nexus/` or `packages/nexus/src/` and is exposed via a CLI verb in `packages/cleo/src/cli/commands/nexus.ts`. No MCP server task is needed.

V1 tasks affected: EP1-T5 (entire task deleted), EP1-T2 acceptance criterion referencing `nexus_cypher` MCP tool (removed), EP2-T1 acceptance criterion referencing MCP tool (removed), EP3-T1 `--include_tasks` MCP parameter (removed), EP3-T2 MCP tools `nexus_hot_paths`/`nexus_hot_nodes` (removed), wiki generator MCP resource (removed).

### "Missing" Capabilities That Are Already Shipped

V1's feature matrix marked the following as MISSING-IN-CLEO when they are actually shipped:

- **"Zero MCP tools for code graph"** — the framing was correct in that no MCP layer exists, but the implication that code graph operations are inaccessible is wrong. `cleo nexus context`, `cleo nexus impact`, `cleo nexus clusters`, `cleo nexus flows`, `cleo nexus diff`, `cleo nexus export` are all CLI-accessible.
- **"No hybrid search for code"** — V1 compared against gitnexus's hybrid search and called it missing. In fact, `cleo memory search-hybrid` runs FTS5 + vector + graph RRF fusion over BRAIN entries. What is missing is that this search does NOT include nexus code symbols — the hybrid search operates only on brain.db. The gap is not building hybrid search from scratch; it is wiring existing `hybridSearch()` to also search `nexus_nodes` via the code_intelligence FTS index.
- **"No code↔memory bridge"** — V1's feature matrix listed `BRAIN integration` as SUPERIOR-IN-CLEO but did not enumerate the specific CLI verbs. The audit reveals 5 CLI verbs (`code-links`, `code-auto-link`, `code-memories-for-code`, `code-for-memory`, `search-hybrid`) already exist in `cleo memory`. V1's P0 and P2 sections treated these as if they needed to be built.
- **"No sentient nexus proposals"** — V1 listed this as SUPERIOR-IN-CLEO correctly, but the P2 decomposition (EP3-T3) proposed building "Extended Pattern Detectors" without acknowledging that the base ingester (`nexus-ingester.ts` with 2 detectors) already ships. The task is extension, not creation.

### P2 Was Too Shallow

V1's P2 section had 5 capability rows but none of them specified the exact SDK functions or the complete edge taxonomy needed. Specifically:

- V1 did not enumerate the 6 missing cross-substrate edge types: `task_touches_symbol`, `observation_about_symbol`, `decision_about_symbol`, `conduit_mentions_symbol`, `modified_by`, `affects`.
- V1 proposed `cleo nexus impact --show-tasks` as P2 but did not propose `getSymbolFullContext()` — the SDK primitive that answers the full living brain query (symbol + tasks + memories + decisions + proposals + conduit threads in one call).
- V1 did not mention the existing T-BRAIN-LIVING epic (Phase 1–2 shipped, Phase 5 STDP partially in-progress with known bugs) or its specific status in `docs/plans/brain-synaptic-visualization-research.md`.
- V1 proposed `reasonWhyChange(symbolId, fromCommit, toCommit)` as a future primitive but did not note that `cleo memory reason-why` already does causal trace for task chains — the gap is extending it through `code_reference` edges to symbol nodes, not building it from zero.

### Graph Engine Question Was Over-Scoped

V1's HITL-1 proposed evaluating LadybugDB, KuzuDB, and DuckDB-PGQ as potential replacements for SQLite. This contradicts the locked decision D-BRAIN-VIZ-09 in `docs/plans/brain-synaptic-visualization-research.md`: "Stay in-process SQLite for now — 2M edges ≈ 200MB, 10–50K UPDATEs/sec WAL, batch decay <10s — 10× margin." The graph engine question is settled. The P0 DSL should be implemented as SQLite recursive CTEs, not a new graph engine.

---

## 4. Revised Feature Matrix

| Capability | gitnexus | cleo nexus | Core Module Owner | Exposed Via | Notes |
|---|---|---|---|---|---|
| **Storage engine** | LadybugDB (native property graph) | SQLite via Drizzle ORM | `packages/core/src/store/nexus-sqlite.ts` | Internal | Decision locked: stay SQLite (D-BRAIN-VIZ-09) |
| **Graph query DSL** | Cypher (`gitnexus cypher`) | Partial: hardcoded BFS + SQL | `packages/core/src/nexus/query-dsl.ts` (NEW) | `cleo nexus query <sql-cte>` | Build SQLite recursive CTE layer |
| **Semantic symbol search** | BM25+HNSW+RRF | `smartSearch()` exists unwired | `packages/nexus/src/code/search.ts` (extend) | `cleo nexus search-code <q>` (NEW) | Wire existing `smartSearch()` |
| **Hybrid search over BRAIN** | None | `hybridSearch()` — FTS5+vector+graph | `packages/core/src/memory/brain-retrieval.ts` | `cleo memory search-hybrid` | Shipped; extend to include nexus symbols |
| **Source content retrieval** | `--content` flag on context | `smartUnfold()` exists unwired | `packages/nexus/src/code/unfold.ts` (extend) | `cleo nexus context --content` (NEW flag) | Wire existing unfold function |
| **Wiki / module doc generator** | 3-phase LLM pipeline | `docs-generator.ts` exists in core | `packages/core/src/docs/docs-generator.ts` (extend) | `cleo nexus wiki` (NEW) | Extend existing doc generator via LOOM |
| **Hook augmenter** | PreToolUse → graph context | PreToolUse wired in CAAMP adapters | `packages/cleo-os/src/hooks/nexus-augment.ts` (NEW) | `cleo nexus augment` (NEW); CAAMP PreToolUse handler | CAAMP event infrastructure exists |
| **Community detection** | Leiden (6,797 communities) | Louvain (513 communities) | `packages/nexus/src/pipeline/community-processor.ts` | `cleo nexus clusters` | Swap to Leiden; emit `member_of` edges |
| **MEMBER_OF edges** | First-class graph edges | Column only (`community_id`) | `packages/nexus/src/pipeline/community-processor.ts` | `cleo nexus clusters` (after fix) | Emit edges in addition to column |
| **External module nodes (IMPORTS)** | 390k IMPORTS edges | 0 persisted (discarded) | `packages/nexus/src/pipeline/import-processor.ts` | `cleo nexus analyze` (after fix) | Persist unresolved imports as ExternalModule nodes |
| **Route/API surface commands** | `route_map`, `shape_check`, `api_impact` MCP tools | `route` kind in schema, no commands | `packages/core/src/nexus/route-analysis.ts` (NEW) | `cleo nexus route-map`, `cleo nexus shape-check` (NEW) | route + handles_route already in schema |
| **Contract registry** | HTTP/gRPC/topic cross-linking | None | `packages/core/src/nexus/contracts/` (NEW) | `cleo nexus group sync`, `cleo nexus contracts` (NEW verbs) | Build after route-map |
| **BRAIN↔NEXUS code_reference edges** | None | `autoLinkMemories()` — 2,669 rows | `packages/core/src/memory/graph-memory-bridge.ts` | `cleo memory code-auto-link` | Shipped |
| **TASKS→NEXUS bridge** | None | Not present | `packages/core/src/nexus/tasks-bridge.ts` (NEW) | `cleo nexus impact --show-tasks` (NEW flag) | Core living brain primitive |
| **BRAIN `documents`/`modified_by`/`affects` edges** | None | Schema defined, 0 rows, no writer | `packages/core/src/memory/graph-memory-bridge.ts` (extend) | `cleo memory code-auto-link` (extend) | Complete the edge writers |
| **`getSymbolFullContext()` traversal** | None | Not present | `packages/core/src/nexus/living-brain.ts` (NEW) | `cleo nexus full-context <symbol>` (NEW) | Key living brain query primitive |
| **`getTaskCodeImpact()` traversal** | None | Not present | `packages/core/src/nexus/living-brain.ts` (NEW) | `cleo nexus task-footprint <taskId>` (NEW) | Task→symbol blast radius |
| **Plasticity query (hot-paths)** | None | `nexus_relations.weight` exists | `packages/core/src/nexus/query-dsl.ts` (NEW) | `cleo nexus hot-paths`, `cleo nexus hot-nodes` (NEW) | Weight column shipped T998 |
| **CONDUIT→NEXUS ingestion** | None | Not present | `packages/core/src/memory/graph-memory-bridge.ts` (extend) | `cleo nexus conduit-scan` (NEW) | NER pipeline for conduit messages |
| **Sentient nexus proposals (base)** | None | `nexus-ingester.ts` — 2 detectors | `packages/core/src/sentient/ingesters/nexus-ingester.ts` | `cleo sentient tick` | Shipped |
| **Sentient nexus proposals (extended)** | None | Not present | `packages/core/src/sentient/ingesters/nexus-ingester.ts` (extend) | `cleo sentient tick` (auto) | Add 3 new detectors |
| **`reason-why` through code symbols** | None | Tasks-only currently | `packages/core/src/memory/brain-reasoning.ts` (extend) | `cleo memory reason-why --include-code` (NEW flag) | Follow `code_reference` edges |
| **Cross-project code analysis** | Contract Registry | Task registry only | `packages/core/src/nexus/contracts/` (NEW) | `cleo nexus group query` (NEW) | Depends on contract registry |
| **Hebbian plasticity (code edges)** | None | `strengthenNexusCoAccess()` — BUG-2 | `packages/core/src/memory/nexus-plasticity.ts` | Consolidation pipeline | Fix BUG-2 (format mismatch) |
| **STDP wire-up** | None | Schema exists, 0 rows (BUG-1–3) | `packages/core/src/memory/brain-stdp.ts` | `cleo memory dream` | T673 epic in-progress |
| **5-substrate studio visualization** | None | Phase 1–2 shipped | `packages/studio/src/routes/brain/` | Studio UI | Phase 3b missing edge writers |

---

## 5. Revised P0 — Core Query Power (No MCP)

### P0-A: Graph Query DSL — SQLite Recursive CTEs

**Core module**: `packages/core/src/nexus/query-dsl.ts` (new file)

**CLI verb**: `cleo nexus query "<sql-cte-template>"` — executes a parameterized SQLite CTE against nexus.db and returns results as a markdown table. A small set of template aliases (e.g., `callers-of`, `callees-of`, `co-changed`, `path-between`) covers the 80% use case without requiring users to write raw SQL.

**What exists to extend**: `packages/core/src/store/nexus-sqlite.ts` already exposes `getNexusNativeDb()` — a raw `DatabaseSync` handle. `packages/nexus/src/intelligence/impact.ts` already does BFS traversal in JS. The DSL layer replaces the JS BFS with SQLite recursive CTEs for the common traversal patterns, keeping the JS BFS as fallback for complex multi-step walks.

**Do NOT adopt LadybugDB** — PolyForm Noncommercial license. D-BRAIN-VIZ-09 locks us to SQLite. The SQLite recursive CTE approach is sufficient for the cleocode index scale (12k nodes, 48k relations — far below the 2M ceiling).

**Example query the DSL must support**:
```sql
-- "All callers of loadConfig that are in community 3"
WITH RECURSIVE callers(id, depth) AS (
  SELECT source_id, 1 FROM nexus_relations WHERE target_id LIKE '%::loadConfig' AND type = 'calls'
  UNION ALL
  SELECT nr.source_id, c.depth + 1 FROM nexus_relations nr JOIN callers c ON nr.target_id = c.id WHERE c.depth < 3
)
SELECT n.name, n.file_path, n.community_id FROM nexus_nodes n JOIN callers c ON n.id = c.id WHERE n.community_id = 3
```

### P0-B: Semantic Code Symbol Search

**Core module**: `packages/nexus/src/code/search.ts` — `smartSearch()` already implemented.

**CLI verb**: `cleo nexus search-code <query>` — wraps `smartSearch()` with `--limit`, `--kinds` (function|class|interface), `--file-glob` filters.

**What exists**: `smartSearch()` is a fully implemented function in `packages/nexus/src/code/search.ts` that walks the filesystem, parses source, and scores symbols against a query string. It is NOT exposed in the current CLI. This is an unwiring fix, not a new build.

**Hybrid extension**: Also extend `cleo memory search-hybrid` to fan out to `nexus_nodes` via FTS5 over `name + doc_summary` columns. The `hybridSearch()` in `packages/core/src/memory/brain-retrieval.ts` already has the RRF fusion pattern — add nexus as a fourth source alongside decisions/patterns/learnings/observations. This wires the existing hybrid search engine to code symbols without rebuilding anything.

### P0-C: Source Content Retrieval

**Core module**: `packages/nexus/src/code/unfold.ts` — `smartUnfold()` already implemented.

**CLI verb**: Add `--content` flag to `cleo nexus context <symbol>` — calls `smartUnfold(filePath, symbolName)` and appends source inline after the callers/callees section.

**What exists**: `smartUnfold()` in `packages/nexus/src/code/unfold.ts` already extracts symbol body with leading docstring. It takes `filePath` and `symbolName`. The `cleo nexus context` command already retrieves `file_path` from nexus_nodes. The gap is one flag and three lines of code in `packages/cleo/src/cli/commands/nexus.ts`.

### P0-D: Wiki Generator

**Core module**: `packages/core/src/docs/docs-generator.ts` — extend this existing module, do not create a parallel pipeline.

**CLI verb**: `cleo nexus wiki [--output <dir>] [--community <id>]` — groups symbols by community, generates per-community module documentation via the existing LOOM LLM abstraction, assembles overview.

**What exists**: `packages/core/src/docs/docs-generator.ts` exists and is dispatched via `cleo docs generate`. The nexus wiki generator extends it: instead of operating on arbitrary files, it queries `nexus_nodes` grouped by `community_id`, uses `smartUnfold()` for symbol signatures, and feeds them to the LLM via LOOM. The wiki HITL question (Section 9) covers LLM provider choice.

**Do NOT build a separate pipeline** — reuse the existing docs-generator module. The git-diff incremental approach (only regenerate communities with changed symbols since last wiki) can be built on top of `cleo nexus diff`.

### P0-E: Hook Augmenter (PreToolUse → Graph Context)

**Core module**: `packages/cleo-os/src/hooks/nexus-augment.ts` (new file, harness concern)

**New CLI verb**: `cleo nexus augment <pattern>` — lightweight command (BM25 only, no embeddings, <500ms cold start target) that returns top 5 symbols matching `<pattern>` with callers/callees/community in plain text to stdout.

**Hook installation**: `cleo nexus setup` writes a handler file (`~/.cleo/hooks/nexus-augment.sh`) that intercepts PreToolUse for Grep/Glob/Read tool calls and calls `cleo nexus augment <extracted-pattern>`. Output is injected into tool result context via stderr. This is a shell script, not an MCP server.

**What exists**: `packages/adapters/src/providers/claude-code/hooks.ts` already maps the Claude Code `PreToolUse` event to the CAAMP canonical `PreToolUse` event. The `packages/cleo-os/` harness is the correct home for hook installation logic (per package-boundary: harness-specific code belongs in `packages/cleo-os/`). The `cleo nexus augment` verb's performance budget is served by the existing `code_intelligence` FTS index in nexus.db — no embeddings required for the augmenter path.

---

## 6. Revised P1 — Competitive Closure

Each gap uses audit findings from Section 2 to classify as wire-existing, extend-existing, or build-new.

### P1-A: External Module Nodes (IMPORTS persistence)

**Classification**: Extend-existing

**Gap**: 390k unresolved import edges discarded in `packages/nexus/src/pipeline/import-processor.ts`. gitnexus persists these as IMPORTS edges. The missing coverage is ~55% of the edge gap on openclaw.

**Fix**: In `import-processor.ts`, when a specifier cannot be resolved to a local symbol, emit an `ExternalModule` node (`kind: 'module'`, `name: specifier`, `is_external: true`) and an `imports` relation. Add `is_external` boolean column to `nexus_nodes` (migration). This is a policy change in one file, not an engine change.

### P1-B: Leiden Community Detection

**Classification**: Extend-existing

**Gap**: Louvain (513 communities) vs Leiden (expected ~6k communities) on same codebase. `member_of` edges are not emitted (community stored as column, not edge).

**Fix**: In `packages/nexus/src/pipeline/community-processor.ts`, swap the graphology Louvain call for a Leiden implementation. Also emit `member_of` edges for every symbol↔community pair — `NEXUS_RELATION_TYPES` already contains `member_of`.

### P1-C: Route-Map and Shape-Check Commands

**Classification**: Build-new (small)

**Gap**: `route` kind and `handles_route`/`fetches` relations already exist in nexus schema. No command surfaces them.

**Fix**: Two new commands in `packages/cleo/src/cli/commands/nexus.ts`: `cleo nexus route-map` (query all `route` nodes with their `handles_route` callers and `fetches` dependencies) and `cleo nexus shape-check <routeSymbol>` (compare inferred response shape to callers' expected shape using `meta_json` fields). Core logic in `packages/core/src/nexus/route-analysis.ts` (new module).

### P1-D: Contract Registry

**Classification**: Build-new (medium)

**Gap**: No cross-project code contract extraction. gitnexus's `group sync` extracts HTTP/gRPC/topic contracts and cross-links them across repos.

**Fix**: `packages/core/src/nexus/contracts/` — new module containing `HttpRouteExtractor`, extractors for gRPC service definitions, and a `contracts.json` manifest format. Integrated with `cleo nexus group sync --extract-contracts` and a new `cleo nexus contracts show <projectA> <projectB>` command. This builds on the existing cross-project `project_registry` table in `nexus.db`. The contract table `nexus_contracts` is new schema.

### P1-E: `member_of` Edges as First-Class Relations

**Classification**: Extend-existing (combined with P1-B)

**Gap**: `member_of` is in `NEXUS_RELATION_TYPES` but never emitted. Community membership is stored as `community_id` column on `nexus_nodes`.

**Fix**: Part of P1-B implementation — after Leiden detection, emit `member_of` relation for each symbol→community pair. This makes communities traversable in the recursive CTE DSL (P0-A): `MATCH (s)-[:member_of]->(c:community) WHERE c.label = 'Auth'`.

---

## 7. Revised P2 — Living Brain (The Heart)

This is the section V1 treated superficially. The living brain is not a bolt-on feature — it is the architectural thesis. Every P2 item below has a specific module home, edge type name, and SDK function signature.

### 7.1 Unified Edge Taxonomy

The following edge types are needed to complete the 5-substrate graph. Status from Section 2 audit:

| Edge | From→To | Substrate Boundary | Status | Schema Location |
|---|---|---|---|---|
| `code_reference` | brain_page_nodes → nexus_nodes | BRAIN→NEXUS | **Shipped** — 2,669 rows | `EDGE_TYPES.CODE_REFERENCE` in `memory/edge-types.ts` |
| `applies_to` | brain_page_nodes → nexus_nodes | BRAIN→NEXUS | **Partial** — 120 rows via text-ref; no dedicated writer | `EDGE_TYPES.APPLIES_TO` in `memory/edge-types.ts` |
| `documents` | brain_page_nodes → nexus_nodes | BRAIN→NEXUS | **Missing** — enum declared in `NEXUS_RELATION_TYPES` line 275; 0 rows; no writer | Add to `graph-memory-bridge.ts` |
| `modified_by` | brain_page_nodes (observation) → nexus_nodes (file/symbol) | BRAIN→NEXUS | **Missing** — `EDGE_TYPES.AFFECTS` exists, no writer | Add observation→files_modified_json extractor in `graph-memory-bridge.ts` |
| `mentions` | brain_page_nodes → nexus_nodes | BRAIN→NEXUS | **Missing** — `EDGE_TYPES.MENTIONS` exists, no writer | Add symbol-name NER extractor in `graph-memory-bridge.ts` |
| `task_touches_symbol` | tasks.files_json → nexus_nodes | TASKS→NEXUS | **Missing** — no schema, no writer | New: `nexus_task_edges` table OR write to `brain_page_edges` with type `task_touches_symbol` |
| `decision_about_symbol` | brain_decisions → nexus_nodes | BRAIN→NEXUS | **Missing** — no writer; `brain_decisions.context_task_id` links to tasks but not to symbols | Extend `decisions.ts` writer |
| `conduit_mentions_symbol` | conduit.messages → nexus_nodes | CONDUIT→NEXUS | **Missing** | New ingestion pipeline |
| `sentient_proposal_about_symbol` | sentient proposals → nexus_nodes | SENTIENT→NEXUS | **Partial** — nexus-ingester produces proposals with node `id` in description; no formal edge | Formalize as `brain_page_edge` type |

### 7.2 Traversal Primitives (SDK Functions in packages/core)

These are the SDK functions that expose the living brain graph to consumers. Each belongs in `packages/core/src/nexus/living-brain.ts` (new module):

**`getSymbolFullContext(symbolId: string, projectRoot: string): Promise<SymbolFullContext>`**

The primary living brain query primitive. Returns:
- NEXUS: callers, callees, community membership, process participation (from existing `nexus context` logic)
- BRAIN memories: observations/decisions/learnings that reference this symbol (via `code_reference` + `documents` + `mentions` edges from `brain_page_edges`)
- TASKS: tasks whose `files_json` contains the symbol's `file_path`, or whose `notes`/`acceptance` text references the symbol name
- Sentient proposals: `ProposalCandidate` entries whose `sourceId` matches the symbol
- CONDUIT threads: messages whose content references the symbol (via FTS5 search on `conduit.messages.content`)
- Plasticity signal: `nexus_relations.weight` aggregated for this node (co-access heat)

CLI verb: `cleo nexus full-context <symbol>` (new verb)

**`getTaskCodeImpact(taskId: string, projectRoot: string): Promise<TaskCodeImpact>`**

Returns:
- Files in task's `files_json` + symbols in those files (from nexus_nodes)
- BFS blast radius for each touched symbol (from `analyzeImpact()`)
- BRAIN observations recorded about those files (via `modified_by` edges)
- Decisions linked to this task (via `brain_memory_links` + `brain_decisions`)
- Risk score: MAX of impact risk tiers across all touched symbols

CLI verb: `cleo nexus task-footprint <taskId>` (new verb)

**`getBrainEntryCodeAnchors(entryId: string, projectRoot: string): Promise<CodeAnchorResult>`**

Returns:
- Nexus code nodes linked to this brain entry (via `code_reference`, `documents`, `applies_to` edges from `brain_page_edges`)
- For each code node: current callers, current community, current plasticity weight
- Tasks that touched those code nodes (via `task_touches_symbol` reverse-lookup)

CLI verb: `cleo nexus brain-anchors <entryId>` (new verb)

**`reasonWhyCodeIsThisWay(symbolId: string, projectRoot: string): Promise<CodeReasonTrace>`**

Extends the existing `reasonWhy()` in `brain-reasoning.ts`. Adds a code path: from the symbol, follow `code_reference` reverse edges to brain decisions about it, then follow `applies_to` from those decisions back to tasks that spawned the decisions, then follow `brain_memory_links` to see what was learned. Returns a narrative trace: "This function is structured this way because task T712 added auth checks per decision D-abc123 which was informed by learning L-xyz456."

CLI verb: `cleo nexus why <symbol>` (new verb; extends `cleo memory reason-why`)

### 7.3 Plasticity Query Primitives

All based on existing `nexus_relations.weight` column (shipped T998):

**Hot-paths**: `cleo nexus hot-paths [--limit 20]` — queries `nexus_relations ORDER BY weight DESC, co_accessed_count DESC`. SDK: `getHotPaths(projectRoot, limit)` in `packages/core/src/nexus/query-dsl.ts`.

**Hot-nodes**: `cleo nexus hot-nodes [--limit 20]` — aggregates `SUM(weight)` per node across all its edges. SDK: `getHotNodes(projectRoot, limit)`.

**Decaying relevance**: `cleo nexus cold-symbols [--days 30]` — symbols with `last_accessed_at < now - 30d AND weight < 0.1`. Candidates for archival or deprecation proposals. SDK: `getColdSymbols(projectRoot, thresholdDays)`.

**Fix Hebbian BUG-2 first**: Before any plasticity queries produce real data, the `entry_ids` format mismatch in `brain_retrieval_log` must be fixed (T673 BUG-2: comma-separated string vs JSON array). This is a prerequisite tracked in the T673 epic.

### 7.4 Reasoning Primitives

**`reasonImpactOfChange(symbolId, projectRoot)`** — merges structural impact (from `analyzeImpact()`), TASKS scope impact (from `getTaskCodeImpact()`), and BRAIN-recorded risk notes (observations with `modified_by` edges to the symbol). Returns: "Changing loadConfig will break 285 direct callers (d=1), likely affect 892 at d=2, and is referenced in 3 open tasks (T1003, T1007, T1012) and 2 risk observations (O-abc, O-def)."

CLI verb: `cleo nexus impact-full <symbol>` (extends `cleo nexus impact`)

### 7.5 Ingestion Pipelines

**Git-log→Task linking**: After `cleo nexus analyze`, run a git-log sweep that extracts task IDs (e.g., `T\d+`) from commit messages touching each file. Write `task_touches_symbol` edges for every symbol in touched files. Module: extend `packages/nexus/src/pipeline/` with a `git-task-linker.ts` pass. This is the primary source for `task_touches_symbol` edges.

**Conduit NER→Symbol linking**: `cleo nexus conduit-scan` — scans `conduit.messages.content` via FTS5 for symbol names present in `nexus_nodes`, writes `conduit_mentions_symbol` edges to `brain_page_edges`. Module: `packages/core/src/memory/graph-memory-bridge.ts` (extend `autoLinkMemories()` to also scan conduit).

**Brain observation entity extraction extension**: Extend existing `code-auto-link` pipeline in `graph-memory-bridge.ts` to also write `modified_by` edges when `files_modified_json` is populated on observations, and `mentions` edges when symbol names appear in observation text. Currently `autoLinkMemories()` only writes `code_reference` edges.

### 7.6 New CLI Verbs Summary (P2)

| Verb | Module | Purpose |
|---|---|---|
| `cleo nexus full-context <symbol>` | `packages/core/src/nexus/living-brain.ts` | 5-substrate symbol context |
| `cleo nexus task-footprint <taskId>` | `packages/core/src/nexus/living-brain.ts` | Task→code blast radius |
| `cleo nexus brain-anchors <entryId>` | `packages/core/src/nexus/living-brain.ts` | Memory entry→code nodes |
| `cleo nexus why <symbol>` | `packages/core/src/nexus/living-brain.ts` | Code causal trace |
| `cleo nexus impact-full <symbol>` | `packages/core/src/nexus/living-brain.ts` | Merged structural+task+brain impact |
| `cleo nexus hot-paths` | `packages/core/src/nexus/query-dsl.ts` | Plasticity-ranked call paths |
| `cleo nexus hot-nodes` | `packages/core/src/nexus/query-dsl.ts` | Plasticity-ranked symbols |
| `cleo nexus cold-symbols` | `packages/core/src/nexus/query-dsl.ts` | Decaying relevance candidates |
| `cleo nexus conduit-scan` | `packages/core/src/memory/graph-memory-bridge.ts` | Conduit→symbol ingestion |
| `cleo memory reason-why --include-code` | `packages/core/src/memory/brain-reasoning.ts` | Extend trace through code_reference |

---

## 8. Revised Decomposition (3 Epics)

### Epic 1 — Nexus P0: Core Query Power

**Goal**: Stop losing raw code-intelligence benchmarks. Give agents a DSL, semantic code search, source retrieval, wiki generation, and hook augmentation — all as core SDK primitives exposed via CLI.

**Dependency order**: T1→T2 (DSL before wiki uses it), T3 standalone, T4 standalone (extends T3), T5 (hook) standalone.

---

**EP1-T1: SQLite Recursive CTE Query DSL**

Size: medium

Rationale: Zero ad-hoc query surface is the single hardest gap against gitnexus. SQLite recursive CTEs are sufficient at current scale (D-BRAIN-VIZ-09 — no new engine).

Acceptance criteria:
- `packages/core/src/nexus/query-dsl.ts` — exports `runNexusCte(cte: string, params: unknown[]): NexusCteResult` using `getNexusNativeDb()` handle
- `cleo nexus query "<cte>"` executes against nexus.db, returns markdown table + `row_count`
- 6 named template aliases: `callers-of <sym>`, `callees-of <sym>`, `co-changed <sym>`, `co-cited <sym>`, `path-between <a> <b>`, `community-members <id>` — each compiles to a parameterized CTE
- Malformed CTEs return structured error with `E_NEXUS_QUERY_PARSE` code, not stack trace
- Code placed in `packages/core/src/nexus/` per Package-Boundary Check — verified against AGENTS.md
- Biome + build + test green | unit tests for each template alias against synthetic nexus.db

Dependencies: None (unblocks EP1-T2, EP2-T2)

---

**EP1-T2: Semantic Code Symbol Search**

Size: small

Rationale: `smartSearch()` in `packages/nexus/src/code/search.ts` is fully implemented but unexposed. This is an unwiring fix.

Acceptance criteria:
- `cleo nexus search-code <query> [--limit N] [--kinds function,class] [--file-glob "src/**"]` calls `smartSearch()` and returns name, file_path, kind, score as markdown table
- `cleo memory search-hybrid` extended to include nexus code symbols as a fourth source in the RRF fusion (query against `code_intelligence` FTS index in nexus.db if available, fall back to `smartSearch()`)
- `packages/nexus/src/code/search.ts` unchanged — no rewrites, only import and expose
- Code placed in `packages/cleo/src/cli/commands/nexus.ts` + `packages/nexus/` per Package-Boundary Check
- Biome + build + test green

Dependencies: None

---

**EP1-T3: Source Content Retrieval (`--content` flag)**

Size: small

Rationale: `smartUnfold()` in `packages/nexus/src/code/unfold.ts` is implemented but not wired to the context command. This is a two-line change in `nexus.ts` CLI.

Acceptance criteria:
- `cleo nexus context <symbol> --content` appends the full source of the symbol (from `smartUnfold()`) after the callers/callees section
- If the source file is unreadable or the symbol cannot be located, the command returns the standard context output without error (graceful degradation)
- Code placed in `packages/cleo/src/cli/commands/nexus.ts` per Package-Boundary Check
- Biome + build + test green

Dependencies: None

---

**EP1-T4: Wiki Generator (`cleo nexus wiki`)**

Size: medium

Rationale: Agents need auto-generated narrative docs. Extends `packages/core/src/docs/docs-generator.ts` rather than building a parallel pipeline.

Acceptance criteria:
- `cleo nexus wiki [--output docs/nexus-wiki/] [--community <id>]` groups symbols by community_id, uses `smartUnfold()` for signatures, calls LOOM LLM for per-community narrative, assembles `overview.md` + one file per community
- Incremental mode: `--incremental` only regenerates communities whose symbol `file_path` set changed since last wiki (detected via `cleo nexus diff` output)
- LLM call via existing LOOM abstraction — no direct API keys in nexus package
- Code placed in `packages/core/src/docs/docs-generator.ts` (extend) + `packages/cleo/src/cli/commands/nexus.ts` per Package-Boundary Check
- Biome + build + test green | test without LLM: `--dry-run` flag outputs symbol lists per community without LLM call

Dependencies: EP1-T1 (CTE queries for community grouping)

---

**EP1-T5: Hook Augmenter (PreToolUse Graph Context Injection)**

Size: medium

Rationale: gitnexus enriches every file operation with graph context transparently. The CAAMP PreToolUse event is already wired in `packages/adapters/`. The augmenter is a lightweight handler.

Acceptance criteria:
- `cleo nexus augment <pattern>` — new CLI verb, BM25-only (no embeddings), <500ms cold start, outputs top 5 symbols matching `<pattern>` with callers/callees/community as plain text to stdout
- `cleo nexus setup` writes `~/.cleo/hooks/nexus-augment.sh` (shell script, not MCP server) that intercepts PreToolUse for Grep/Glob/Read tool calls, extracts the pattern/file argument, calls `cleo nexus augment`, and emits to stderr for injection
- Hook handler logic in `packages/cleo-os/src/hooks/nexus-augment.ts` (new file, harness concern) — not in `packages/core/` or `packages/cleo/`
- `cleo nexus augment` gracefully no-ops if nexus.db is absent or stale (exit 0, empty output)
- Code placed in `packages/cleo-os/` (hook installation) + `packages/cleo/` (CLI verb) per Package-Boundary Check
- Biome + build + test green | integration test: augment returns results on cleocode index

Dependencies: EP1-T2 (uses `smartSearch()`)

---

### Epic 2 — Nexus P1: Competitive Closure

**Goal**: Close the evidence-based gaps from the openclaw benchmark. Edge coverage, community granularity, route surface, contract registry.

**Dependency order**: T1 (IMPORTS) → standalone; T2 (Leiden) → standalone; T3 (routes) → standalone; T4 (contracts) depends on T3.

---

**EP2-T1: External Module Nodes (Persist Unresolved IMPORTS)**

Size: medium

Rationale: 390k unresolved imports discarded = 55% of the edge gap vs gitnexus. Policy change in one file, not an engine change.

Acceptance criteria:
- `packages/nexus/src/pipeline/import-processor.ts` modified: when a specifier cannot be resolved locally, emit `ExternalModule` node (`kind: 'module'`, `is_external: true`) and `imports` relation targeting it
- Schema migration: add `is_external BOOLEAN DEFAULT 0` column to `nexus_nodes` in `packages/core/src/store/nexus-schema.ts`
- `cleo nexus status` shows `external_modules: N` count separately from local symbols
- `cleo nexus context <symbol>` shows `External imports:` section when the symbol imports from external modules
- No behavior regression on existing `calls`/`extends`/`implements` edge types
- Code placed in `packages/nexus/src/pipeline/` (extraction) + `packages/core/src/store/` (schema) per Package-Boundary Check
- Biome + build + test green | verify: openclaw re-analyze should show ~390k additional `imports` relations

Dependencies: None

---

**EP2-T2: Leiden Community Detection + MEMBER_OF Edges**

Size: medium

Rationale: 513 Louvain vs projected ~5k+ Leiden communities. MEMBER_OF edges as first-class relations make communities traversable via the CTE DSL.

Acceptance criteria:
- `packages/nexus/src/pipeline/community-processor.ts` swaps graphology Louvain call for a Leiden implementation (evaluate `@graphology/leiden` or port the algorithm)
- After Leiden detection, emit `member_of` relations (type already in `NEXUS_RELATION_TYPES`) for every symbol→community pair
- Existing `community_id` column preserved for backward compatibility; MEMBER_OF edges are additive
- `cleo nexus clusters` output shows updated community count and `member_of` edge count
- Automatic semantic label generation (currently ships on Louvain) preserved on Leiden output
- Code placed in `packages/nexus/src/pipeline/` per Package-Boundary Check
- Biome + build + test green | verify: community count on cleocode index should increase >3×

Dependencies: EP1-T1 (CTE aliases can use member_of edges)

---

**EP2-T3: Route-Map and Shape-Check Commands**

Size: small

Rationale: `route` kind and `handles_route`/`fetches` relations already in schema. Zero new schema needed; two new commands.

Acceptance criteria:
- `cleo nexus route-map` queries all `route` kind nodes, their `handles_route` callers, and `fetches` dependencies; outputs a markdown route table with handler chain
- `cleo nexus shape-check <routeSymbol>` compares `meta_json.responseKeys` between the route node and its consumers' expected shape; reports mismatches
- Core logic in `packages/core/src/nexus/route-analysis.ts` (new module, exported from `packages/core`)
- Code placed in `packages/core/src/nexus/route-analysis.ts` (SDK) + `packages/cleo/src/cli/commands/nexus.ts` (CLI) per Package-Boundary Check
- Biome + build + test green

Dependencies: None

---

**EP2-T4: Contract Registry**

Size: large

Rationale: Cross-project code contract extraction for HTTP/gRPC/topic APIs. Depends on route-map (EP2-T3) as the extractor foundation.

Acceptance criteria:
- `packages/core/src/nexus/contracts/` — new module: `HttpRouteExtractor`, `GrpcExtractor`, `TopicExtractor`, `ContractMatcher` (exact→name→fuzzy cascade)
- New `nexus_contracts` table in nexus.db schema: `(contract_id, project_id, type, path, method, schema_json, created_at)`
- `cleo nexus group sync --extract-contracts` populates `nexus_contracts` for all registered projects
- `cleo nexus contracts show [--project-a <p>] [--project-b <p>]` shows contract compatibility matrix between two projects
- Contract-task linkage: `cleo nexus contracts link-tasks` walks contracts for changes and links affected tasks across projects
- Code placed in `packages/core/src/nexus/contracts/` (SDK) + `packages/cleo/` (CLI) per Package-Boundary Check
- Biome + build + test green | at least 2 HTTP contracts extracted from cleocode codebase

Dependencies: EP2-T3 (route extraction)

---

### Epic 3 — Nexus P2: Living Brain Completion

**Goal**: Complete the cross-substrate graph wiring and expose the traversal primitives that are cleo's permanent competitive moat. No competitor can build this without a co-located task management and memory system.

**Dependency order**: T1 (edge writers) first, T2 (TASKS bridge) first, T3 (SDK primitives) depends on T1+T2, T4 (extended reasoner) depends on T3, T5 (sentient detectors) independent, T6 (conduit ingestion) independent, T7 (Hebbian bug fix + STDP) foundational.

---

**EP3-T1: Complete BRAIN→NEXUS Edge Writers**

Size: medium

Rationale: Four edge types (`documents`, `modified_by`, `affects`, `mentions`) are declared in `EDGE_TYPES` constants and `NEXUS_RELATION_TYPES` schema but have 0 live rows. Closing this gap completes the BRAIN→NEXUS link surface.

Acceptance criteria:
- `packages/core/src/memory/graph-memory-bridge.ts` extended with three new writer functions:
  - `linkObservationToModifiedFiles(obsId, filesModifiedJson)` — writes `modified_by` edges from file nodes to observation nodes for each path in `files_modified_json`
  - `linkObservationToMentionedSymbols(obsId, text)` — scans observation text for symbol names present in `nexus_nodes`; writes `mentions` edges
  - `linkDecisionToSymbols(decisionId, contextText)` — writes `documents` edges from decision nodes to referenced symbols
- `autoLinkMemories()` extended to call all three new writers in addition to existing `code_reference` logic
- `cleo memory code-auto-link` triggers all four edge types
- Verify: after running `code-auto-link` on cleocode, `documents`, `modified_by`, `affects`, `mentions` row counts > 0
- Code placed in `packages/core/src/memory/graph-memory-bridge.ts` per Package-Boundary Check
- Biome + build + test green

Dependencies: None

---

**EP3-T2: TASKS→NEXUS Bridge (task_touches_symbol edges)**

Size: medium

Rationale: The most differentiated P2 capability. "Which tasks touched this symbol?" is unanswerable today. Zero other code intelligence tools can answer it.

Acceptance criteria:
- New `packages/core/src/nexus/tasks-bridge.ts` module exporting:
  - `linkTaskToSymbols(taskId, filesJson, projectRoot)` — for each file in `files_json`, queries `nexus_nodes` for symbols in that file, writes `task_touches_symbol` edges to `brain_page_edges` (using `EDGE_TYPES.TASK_TOUCHES_SYMBOL` — add new constant)
  - `getTasksForSymbol(symbolId, projectRoot)` — reverse-lookup: find all task IDs linked to a symbol
  - `getSymbolsForTask(taskId, projectRoot)` — forward-lookup: all symbols a task touched
- Git-log sweeper: `cleo nexus analyze` post-hook runs git log since last analyze, extracts task IDs from commit messages (pattern `T\d+`), calls `linkTaskToSymbols()` for each
- `cleo nexus task-symbols <taskId>` — new verb showing symbols touched by a task
- Add `TASK_TOUCHES_SYMBOL = 'task_touches_symbol'` to `EDGE_TYPES` in `memory/edge-types.ts`
- Add `'task_touches_symbol'` to `BRAIN_EDGE_TYPES` in `memory-schema.ts`
- Code placed in `packages/core/src/nexus/tasks-bridge.ts` per Package-Boundary Check
- Biome + build + test green | unit test with mock tasks.db + nexus.db

Dependencies: None

---

**EP3-T3: Living Brain SDK Traversal Primitives**

Size: large

Rationale: The unified 5-substrate query primitives. `getSymbolFullContext()`, `getTaskCodeImpact()`, `getBrainEntryCodeAnchors()` are the living brain's primary API.

Acceptance criteria:
- New `packages/core/src/nexus/living-brain.ts` module with TSDoc on all exports
- `getSymbolFullContext(symbolId, projectRoot)` — returns typed `SymbolFullContext` interface with: nexus (callers/callees/community), brainMemories, tasks, sentientProposals, conduitThreads (stub if conduit unindexed), plasticityWeight
- `getTaskCodeImpact(taskId, projectRoot)` — returns `TaskCodeImpact`: files, symbols, blastRadius, brainObservations, decisions, riskScore
- `getBrainEntryCodeAnchors(entryId, projectRoot)` — returns `CodeAnchorResult`: nexusNodes, tasksForNodes, plasticitySignal
- `cleo nexus full-context <symbol>` — renders `SymbolFullContext` as rich CLI output
- `cleo nexus task-footprint <taskId>` — renders `TaskCodeImpact`
- `cleo nexus brain-anchors <entryId>` — renders `CodeAnchorResult`
- Type contracts exported from `packages/contracts/src/` (new file `nexus-living-brain-ops.ts`)
- Code placed in `packages/core/src/nexus/living-brain.ts` per Package-Boundary Check
- Biome + build + test green | integration test: `full-context createSqliteDataAccessor` returns >0 rows in each substrate on cleocode

Dependencies: EP3-T1 (edge writers), EP3-T2 (task bridge)

---

**EP3-T4: Extended Code Reasoning (`cleo nexus why` + `impact-full`)**

Size: medium

Rationale: Extends existing `reasonWhy()` to follow `code_reference` edges. Merges structural + task + brain impact into one command.

Acceptance criteria:
- `packages/core/src/memory/brain-reasoning.ts` extended: `reasonWhySymbol(symbolId, projectRoot)` walks BRAIN observations→decisions→tasks linked to the symbol via `code_reference` + `applies_to` edges; returns `CodeReasonTrace` (narrative + chain)
- `cleo nexus why <symbol>` — calls `reasonWhySymbol()`, renders narrative trace
- `cleo nexus impact-full <symbol>` — calls `analyzeImpact()` + `getTaskCodeImpact()` + queries BRAIN observations with `modified_by` edges to the symbol; renders merged risk report
- `packages/core/src/nexus/living-brain.ts` exports `reasonImpactOfChange(symbolId, projectRoot)` combining all three sources
- Code placed in `packages/core/src/memory/brain-reasoning.ts` (extend) + `packages/core/src/nexus/living-brain.ts` (new) per Package-Boundary Check
- Biome + build + test green

Dependencies: EP3-T3 (living-brain module)

---

**EP3-T5: Sentient Nexus Ingester Extensions**

Size: medium

Rationale: Current ingester has 2 detectors. Adding 3 more (community fragmentation, entry-point erosion, cross-community coupling spike) closes the gap against graph-drift detection.

Acceptance criteria:
- `packages/core/src/sentient/ingesters/nexus-ingester.ts` extended with three new detectors (Query C, D, E):
  - **Community fragmentation** (Query C): community `symbolCount` dropped >20% since last snapshot → `ProposalCandidate` weight 0.4
  - **Entry-point erosion** (Query D): process node with `entry_point_of` source now unexported → weight 0.5
  - **Cross-community coupling spike** (Query E): symbol with `degree > 30 AND cross_community_edge_count > 15` → weight 0.35
- Each new detector logs to `nexus_audit_log` with `action = 'sentient.nexus.proposal.<type>'`
- Post-analyze hook: detectors auto-run after every `cleo nexus analyze` (add to analyze command pipeline)
- Code placed in `packages/core/src/sentient/ingesters/nexus-ingester.ts` per Package-Boundary Check
- Biome + build + test green | unit tests for each detector with synthetic nexus.db

Dependencies: None

---

**EP3-T6: Conduit→Symbol Ingestion Pipeline**

Size: medium

Rationale: Conduit messages referencing symbols are dark data today. NER extraction completes the CONDUIT→NEXUS substrate link.

Acceptance criteria:
- `packages/core/src/memory/graph-memory-bridge.ts` extended with `linkConduitMessagesToSymbols(projectRoot)`:
  - Queries `conduit.messages.content` via FTS5 for symbol names present in `nexus_nodes.name`
  - Writes `conduit_mentions_symbol` edges to `brain_page_edges` (add `CONDUIT_MENTIONS_SYMBOL = 'conduit_mentions_symbol'` to `EDGE_TYPES` and `BRAIN_EDGE_TYPES`)
- `cleo nexus conduit-scan` — new verb that triggers `linkConduitMessagesToSymbols()` for current project; reports `linked: N` count
- Graceful no-op when conduit.db is absent (conduit not initialized)
- Code placed in `packages/core/src/memory/graph-memory-bridge.ts` per Package-Boundary Check
- Biome + build + test green

Dependencies: None

---

**EP3-T7: Hebbian BUG-2 Fix + STDP Wire-Up**

Size: medium

Rationale: Plasticity produces 0 co_retrieved edges due to BUG-2 (comma-separated `entry_ids` vs JSON.parse). This is the foundational fix for all plasticity-dependent features (hot-paths, hot-nodes, cold-symbols). STDP wire-up is tracked in T673 — this task wraps the prerequisite fix.

Acceptance criteria:
- BUG-2 fix: `packages/core/src/memory/brain-lifecycle.ts` `strengthenCoRetrievedEdges()` — fix `entry_ids` parsing to handle both comma-separated and JSON array formats
- BUG-1 fix: `extractNexusPairsFromRetrievalLog()` — fix the 5-min vs 30-day lookback conflation (separate the `brain_retrieval_log` insertion timestamp from the consolidation lookback window)
- After fix: `brain_page_edges` co_retrieved row count > 0 after a `cleo memory dream` run
- `cleo nexus hot-paths` returns non-empty results after a code retrieval session (verify against cleocode)
- Code placed in `packages/core/src/memory/` per Package-Boundary Check
- Biome + build + test green | existing T673 test suite must pass

Dependencies: None (prerequisite, not dependent)

---

**EP3-T8: IVTR Breaking-Change Gate (restores V1 coverage)**

Size: small

Rationale: Restores the V1 P2 capability dropped during V2 revision. When a task touches code symbols and `impact-full` reports CRITICAL risk, the IVTR Test stage must block `cleo complete` unless the worker explicitly acknowledges. This makes the living brain enforce code-change discipline at the orchestration layer — another capability no external code-intelligence tool can replicate because none of them sit inside the task-lifecycle pipeline.

Acceptance criteria:
- Extend `packages/core/src/engine/gate-validators.ts` (or equivalent gate module) to add a `nexusImpact` gate validator that reads `files` from the task, calls `analyzeImpact()` for all symbols in those files, and returns FAIL if any symbol has risk=CRITICAL
- `cleo verify <taskId> --gate nexusImpact --evidence "tool:nexus-impact-full"` runs the validator and writes the gate result
- `cleo complete <taskId>` rejects with `E_NEXUS_IMPACT_CRITICAL` if gate fails and `--acknowledge-risk` flag absent
- `--acknowledge-risk "<reason>"` flag on `cleo complete` bypasses the gate and audits the acknowledgment to `.cleo/audit/nexus-risk-ack.jsonl` (same pattern as force-bypass audit)
- Gate is opt-in via `CLEO_NEXUS_IMPACT_GATE=1` env var initially (default off) to prevent surprise breakage on existing workflows
- `tool:nexus-impact-full` added as a valid evidence atom under ADR-051 / T832
- Code placed in `packages/core/src/engine/` per Package-Boundary Check
- Biome + build + test green | integration test: create synthetic task with high-impact file change, verify gate fires and `--acknowledge-risk` bypasses

Dependencies: EP3-T4 (impact-full must exist before gate can call it)

---

### Summary

| Epic | Tasks | Sizes | Key Deliverable |
|---|---|---|---|
| **Epic 1 — P0 Core Query Power** | 5 (EP1-T1..T5) | 2 medium, 2 small, 1 medium | DSL, semantic search, source retrieval, wiki, hook augmenter |
| **Epic 2 — P1 Competitive Closure** | 4 (EP2-T1..T4) | 1 medium, 1 medium, 1 small, 1 large | IMPORTS persistence, Leiden, route-map, contract registry |
| **Epic 3 — P2 Living Brain** | 8 (EP3-T1..T8) | 2 medium, 1 large, 4 medium, 1 small | Edge writers, task bridge, traversal primitives, reasoners, sentient detectors, conduit scan, Hebbian fix, IVTR gate |
| **Total** | **17 tasks** | — | 5-substrate living brain query surface + orchestration gate |

---

## 9. Open HITL Decisions (3–5 Items Max)

### HITL-1: Embeddings Model for Code Symbol Vector Index

`smartSearch()` today is keyword-based (no embeddings). The hybrid search extension (EP1-T2) can add a vector component via the existing `sqlite-vec` extension (already loaded, per D-BRAIN-VIZ-10). The question is: which model generates the embeddings?

Options:
- (A) `@huggingface/transformers` `Xenova/all-MiniLM-L6-v2` — local, runs in-process, 23MB, already used for BRAIN vector embeddings. Consistent with existing embedding pipeline.
- (B) `snowflake-arctic-embed-xs` — what gitnexus uses (384-dim). Not currently in the dependency tree.
- (C) Optional/off-by-default — only generate code symbol embeddings when `--embeddings` flag passed to `cleo nexus analyze`. Zero cost when not needed.

**Recommendation**: Option A + C (use existing model, make it opt-in). Owner decision needed on whether code symbol embeddings are a priority for v1 of EP1-T2.

### HITL-2: Wiki LLM Provider via LOOM

The wiki generator (EP1-T4) needs to call an LLM for per-community narrative generation. LOOM is the abstraction layer but the specific provider needs a default.

Options:
- (A) Anthropic Claude (via existing ANTHROPIC_API_KEY resolution in `llm-backend-resolver.ts`) — same path as brain `reflect` and `dream` operations.
- (B) No LLM call by default — generate structured outlines only (symbol list + signatures per community) unless `--llm` flag is passed. Pure structural output, no narrative.
- (C) Pluggable via LOOM provider config.

**Recommendation**: Option B as default (structural outline always works), Option A when `--llm` is passed. This mirrors the `cleo memory reflect` pattern.

### HITL-3: Cross-Substrate Plasticity Decay Rates

Once BUG-2 is fixed (EP3-T7), the Hebbian strengthening will start producing `co_retrieved` edges. The decay rate (how fast weights decay without access) needs to be set. Currently `WEIGHT_INCREMENT = 0.05` and cap = 1.0. No decay function exists yet.

The question is the half-life of a code edge's relevance: how many days of non-access before weight decays to 0.1 (the "cold" threshold)?

**Recommendation**: Start with 90-day half-life (halve weight every 90 days via a scheduled decay job in `brain-lifecycle.ts` consolidation). Owner should validate this matches the project's development cadence — a fast-moving codebase may need 30-day decay; a stable codebase may want 180-day.

### HITL-4: Conduit Ingestion Scope

The conduit→symbol ingestion (EP3-T6) can range from lightweight (FTS5 exact-match on symbol names in messages) to heavy (NER model extraction). Owner decision needed on scope:

- (A) FTS5 exact match only — fast, no model, misses paraphrases.
- (B) FTS5 + fuzzy symbol name match (Levenshtein distance ≤ 2 on 6+ char names) — moderate coverage.
- (C) LLM-assisted entity extraction — same pipeline as brain `auto-extract.ts`, but on conduit messages. Slow, costly, high coverage.

**Recommendation**: Option B for v1. Option C deferred until conduit delivery loop is fixed (it is currently write-complete but read-broken per MEMORY.md "BROKEN" section).

---

## Appendix: Evidence Sources Used

| Source | Verified |
|---|---|
| `cleo memory --help` + all subcommand `--help` output | Yes — direct CLI introspection |
| `cleo nexus --help` + subcommand help output | Yes |
| `packages/core/src/memory/nexus-plasticity.ts` | Read |
| `packages/core/src/memory/brain-links.ts` | Read |
| `packages/core/src/memory/graph-memory-bridge.ts` (first 80 lines) | Read |
| `packages/core/src/memory/edge-types.ts` | Read |
| `packages/core/src/memory/brain-reasoning.ts` (first 80 lines) | Read |
| `packages/core/src/memory/brain-search.ts` (first 50 lines) | Read |
| `packages/core/src/memory/brain-retrieval.ts` (lines 215–265) | Read |
| `packages/core/src/sentient/ingesters/nexus-ingester.ts` (first 100 lines) | Read |
| `packages/core/src/memory/graph-auto-populate.ts` (first 60 lines) | Read |
| `packages/core/src/store/nexus-schema.ts` (lines 90–165, 244–350) | Read |
| `packages/nexus/src/intelligence/impact.ts` (first 50 lines) | Read |
| `packages/nexus/src/code/outline.ts`, `unfold.ts`, `search.ts` (headers) | Read |
| `packages/nexus/src/intelligence/index.ts` | Read |
| `packages/adapters/src/providers/claude-code/hooks.ts` (first 50 lines) | Read |
| `packages/cleo/src/cli/commands/memory.ts` (grep key lines) | Read |
| `packages/cleo/src/cli/commands/nexus.ts` (grep key lines) | Read |
| `docs/plans/brain-synaptic-visualization-research.md` (§0–§5) | Read |
| `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` (first 50 lines) | Read |
| V1 `RECOMMENDATION.md` | Scanned |
