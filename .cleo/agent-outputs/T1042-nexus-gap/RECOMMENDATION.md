# cleo nexus vs gitnexus — Definitive Gap Analysis & Far-Exceed Decomposition Plan

**Task**: T1047 (Lead/Synthesizer)
**Epic**: T1042
**Date**: 2026-04-20
**Wave 0 Sources**: T1043 (gitnexus surface), T1044 (cleo nexus surface), T1045 (gitnexus run on openclaw), T1046 (cleo nexus run on openclaw)

---

## 1. Executive Summary

cleo nexus today is a capable cross-project task-registry and structural code-graph tool with unique differentiators no competitor can replicate: Hebbian plasticity on relation weights, sentient Tier-2 proposals driven by graph anomalies, and TASKS×code co-index with stable project identity. However, on raw code-intelligence power — the primary use-case for an agent embedded in a coding workflow — it trails gitnexus across every dimension that matters: query expressiveness (zero DSL vs. raw Cypher), semantic retrieval (zero embeddings vs. BM25+HNSW+RRF), agent integration (no MCP tools vs. 15 tools + hook augmenter), and coverage fidelity (166k vs. 615k edges on the same codebase). To far-exceed gitnexus, cleo must execute three parallel epics: (1) close the P0 parity gaps (Cypher DSL, embeddings+semantic search, MCP tool surface, wiki generator, hook augmenter) to stop losing head-to-head comparisons; (2) close P1 competitive gaps (contract registry, edge-type coverage, node content retrieval, community granularity) to match gitnexus feature-for-feature; and (3) exploit its unique structural advantages in P2 differentiation (TASKS×nexus join queries, BRAIN plasticity-ranked code paths, sentient nexus proposals, IVTR-enforced breaking-change gates, cross-project code-contract chains traceable to cross-project tasks). No other code intelligence tool in the ecosystem can offer the BRAIN+TASKS+NEXUS unified graph — this is cleo's only sustainable moat and every architectural decision must amplify it.

---

## 2. Feature Matrix

| Capability | gitnexus (v1.5.3) | cleo nexus (v2026.4.100) | Annotation |
|---|---|---|---|
| **Storage engine** | LadybugDB (property graph, native Node addon, Kuzu-compatible Cypher) | SQLite via Drizzle ORM + JS in-memory graph walks | MISSING-IN-CLEO: native graph engine |
| **Raw query DSL** | Cypher (`gitnexus cypher <query>`) — full openCypher subset on live graph | None — all traversal is hardcoded BFS or SQL+JS | MISSING-IN-CLEO |
| **Semantic search (embeddings)** | BM25 FTS + HNSW 384-dim (snowflake-arctic-embed-xs) + RRF k=60 merge | None — name substring match (case-insensitive `String.includes`) | MISSING-IN-CLEO |
| **Embeddings layer** | Per-symbol `Embedding` node table, HNSW cosine index, opt-in via `--embeddings` | Not present; no embedding storage, no vector index | MISSING-IN-CLEO |
| **MCP tool surface (code graph)** | 15 MCP tools + 6 resource templates + 2 prompts (stdio transport) | Zero MCP tools for code graph; dispatch layer only | MISSING-IN-CLEO |
| **Hook augmenter** | PreToolUse intercepts Grep/Glob/Bash → injects graph context (target <500ms) | None; no Claude Code hook integration | MISSING-IN-CLEO |
| **Wiki generator** | 3-phase LLM pipeline (module grouping → per-module → overview), incremental via git-diff, Cursor/OpenAI backends | None — no wiki or doc generation command | MISSING-IN-CLEO |
| **Context 360 (symbol view)** | `context` with `--uid`, `--content` (full source inline), process participation, ambiguity resolution; 22 edge types | `context` with kind-priority sort, callers/callees, community + process; no source inline; name-only disambiguation | PARITY (functional) / MISSING-IN-CLEO (`--content`, UID addressing) |
| **Impact analysis** | BFS with typed confidence floors, d=1/2/3 depth labels, JVM class seed fix, process coverage, `api_impact` pre-change report | BFS with risk tiers (NONE/LOW/MEDIUM/HIGH/CRITICAL), same depth labels; no process coverage report; no pre-change combined report | PARITY (functional) / gitnexus richer |
| **Community detection** | Leiden algorithm, 6,797 communities on openclaw (6,193 Community nodes + 604 process clusters) | Louvain via graphology, 513 communities on same codebase; modularity 0.733; auto-derived semantic labels | MISSING-IN-CLEO: Leiden scale; SUPERIOR-IN-CLEO: semantic auto-labels |
| **Execution flows** | 300 (hard-capped) Process nodes, STEP_IN_PROCESS edges, process participation in context/impact | 75 execution flows traced, entry-point scoring (export + name pattern + test-file filter), cross-community flow classification | PARITY (process concept exists in both) |
| **Node content retrieval** | `--content` flag on `context` returns full source of symbol inline | Not present — no way to retrieve source from graph query | MISSING-IN-CLEO |
| **Cross-project code analysis** | `group sync` builds Contract Registry; cross-repo BFS; `group_query` RRF merge | Cross-project registry at code-node level: NOT present (code graph is per-project only) | MISSING-IN-CLEO |
| **Cross-project task analysis** | None — gitnexus has no task layer | `deps`, `critical-path`, `blocking`, `orphans`, `discover`, `search`, `transfer`, `resolve`; stable projectId reconcile | SUPERIOR-IN-CLEO |
| **Contract registry** | HTTP/gRPC/topic extractor + exact→manifest→BM25→embedding cascade matching, `contracts.json` | None — no cross-project code contract extraction | MISSING-IN-CLEO |
| **BRAIN integration** | None | Hebbian plasticity on relation weights, living brain substrate adapter, `documents`/`applies_to` cross-graph relations, `top-entries` op | SUPERIOR-IN-CLEO |
| **Sentient proposals from code graph** | None | Tier-2 ingester: orphaned-callee + over-coupled-node → auto `ProposalCandidate` entries | SUPERIOR-IN-CLEO |
| **GEXF / graph export** | None (no export command) | `export --format gexf|json` with Gephi color coding, edge weights, full metadata | SUPERIOR-IN-CLEO |
| **Diff (git commit compare)** | `detect_changes` MCP tool: maps changed lines → processes; no full graph diff | `diff --before --after` incremental pipeline with regression detection; limitation: does not checkout git refs | PARITY (different angles); both partial |
| **Route / API schema nodes** | First-class `Route`, `Tool` node tables; `route_map`, `shape_check`, `api_impact`, `tool_map` MCP tools | `route` kind in node schema + `handles_route`/`fetches` relations; no `route_map` or `shape_check` command | MISSING-IN-CLEO: route/tool MCP tools |
| **Multi-language support** | 16 languages: TS/JS/Py/Java/C/C++/C#/Go/Ruby/Rust/PHP/Kotlin/Swift/Dart/Vue/COBOL | TypeScript, Rust, JS (confirmed); schema supports `language` field | PARITY for TS/Rust; MISSING-IN-CLEO for Java/C#/Go/Python |
| **Audit log** | None | Append-only `nexus_audit_log` on all registry operations | SUPERIOR-IN-CLEO |
| **Eval server** | `eval-server` (port 4848, LLM-friendly text, next-step hints, SWE-bench target) | None | MISSING-IN-CLEO |
| **Plasticity weights on relations** | None | `weight`, `co_accessed_count`, `last_accessed_at` on `nexus_relations` (T998); `co_changed`, `co_cited_in_task` relation types | SUPERIOR-IN-CLEO |

---

## 3. Evidence on openclaw — The 4× Edge Gap and 13× Community Gap

### Raw numbers (same codebase, /mnt/projects/openclaw, commit d2e2d97)

| Metric | gitnexus | cleo nexus | Ratio |
|---|---|---|---|
| Files indexed | 13,927 | 14,114 | ~same |
| Total nodes/symbols | 84,530 | 64,637 | 1.3× |
| Total edges/relations | 615,963 | 166,257 | **3.7× (≈4×)** |
| Functional communities | 6,797 | 513 | **13.2×** |
| Execution flows | 300 (hard cap) | 75 | 4× |

### Hypothesis A — IMPORTS resolution is the primary edge gap

The gitnexus edge distribution shows IMPORTS as the dominant edge type with 390,924 edges — by itself, 2.4× the total cleo nexus edge count. The T1046 SUMMARY explicitly logs 390,191 **unresolved** call relations in cleo nexus. This is not a coincidence: cleo nexus resolves barrel re-export chains (1,395 counted) but still fails to resolve 390k calls to external/node_modules/cross-package specifiers. gitnexus logs these as IMPORTS edges even when the target is not a local symbol; cleo nexus discards unresolved imports rather than persisting them.

**Impact**: cleo nexus's "unresolved calls" are gitnexus's IMPORTS edges. If cleo nexus persisted unresolved import stubs as `ExternalModule` nodes with IMPORTS edges, its edge count would roughly match gitnexus. This is a policy difference, not a fundamental capability gap — but it means cleo nexus's blast-radius analysis is missing all indirect paths through unresolved imports, understating impact for cross-package dependencies.

### Hypothesis B — Section nodes inflate gitnexus symbol count

gitnexus reports 7,783 `Section` nodes (code blocks / subsections within files). cleo nexus has no `section` kind. These nodes add both nodes and CONTAINS edges. Removing them from gitnexus count gives ~76,747 non-section nodes — still 18% more than cleo nexus's 64,637 but not dramatically different.

### Hypothesis C — Community detection granularity (Leiden vs Louvain at different resolution)

6,797 gitnexus communities vs 513 cleo nexus communities — a 13× gap — is not explained by symbol count alone. Leiden typically produces finer-grained partitions than Louvain at the same resolution parameter. Additionally, gitnexus counts 6,193 Community nodes separately from Process (300) — its "clusters" include both graph communities AND process clusters as community-labeled entities. cleo nexus detects 513 communities (307 shown) using Louvain at default resolution. Two sub-causes:
1. Leiden produces ~10–15× more communities at default settings than Louvain for large sparse graphs
2. gitnexus includes MEMBER_OF edges (33,885) linking symbols to communities as graph citizens; cleo nexus stores `community_id` as a column, not as a first-class `member_of` relation — this reduces community visibility in traversal queries

### Hypothesis D — cleo nexus loadConfig impact shows MORE nodes (1,108 vs 168)

Notably, cleo nexus's `impact loadConfig` returned 1,108 impacted nodes vs gitnexus's 168 (downstream direction). This shows cleo nexus's CALLS resolution within the local TypeScript import graph is actually more complete than gitnexus for intra-project transitive calls. gitnexus shows 0 upstream callers for loadConfig (the dynamic dispatch problem), while cleo nexus shows 285 direct callers. The edge gap is therefore entirely in cross-module IMPORTS edges, not in intra-project CALLS.

### Summary of edge gap root causes

| Cause | Estimated contribution to gap |
|---|---|
| Unresolved import stubs not persisted in cleo nexus | ~55% of gap (390k IMPORTS in gitnexus vs 0 persisted in cleo nexus) |
| Section nodes (gitnexus) adding CONTAINS edges | ~10% of gap |
| MEMBER_OF edges (gitnexus community membership as edges) | ~15% of gap |
| DEFINES edges (55,550 in gitnexus; cleo nexus uses `parent_id` column not edges) | ~10% of gap |
| Remaining difference: edge resolution depth, `ACCESSES` coverage | ~10% of gap |

The community gap is almost entirely Leiden vs Louvain algorithm choice plus MEMBER_OF edges as first-class relations.

---

## 4. Storage & Schema Gaps

### 4.1 gitnexus node/edge types absent from cleo nexus — and what they enable

| gitnexus type | What it enables | cleo nexus storage change needed |
|---|---|---|
| **`Section` nodes** | Sub-file granularity (code blocks, doc sections); allows wiki generator to reference specific sections rather than whole-file | New `section` kind in `NEXUS_NODE_KINDS`; `CONTAINS` edges from `File` → `Section` |
| **`Embedding` node table** (FLOAT[384], HNSW index) | Semantic similarity search (snowflake-arctic-embed-xs); powers `query` hybrid BM25+HNSW+RRF | New `nexus_embeddings` table: `(node_id TEXT PK, project_id, embedding BLOB/F32 array)`; SQLite vector extension (sqlite-vec or similar) for HNSW, OR offload to LanceDB/hnswlib |
| **`Route` node (first-class, with `responseKeys`, `middleware`)** | `route_map`, `shape_check`, `api_impact`; API shape mismatch detection across consumers | `route` kind already in schema; missing: `responseKeys` and `middleware` in `meta_json`; need route extractor in pipeline Phase 3 |
| **`Tool` node** | First-class MCP/RPC tool definitions in the graph; `tool_map` queries | `tool` kind already in schema; need tool extractor; no current extractor |
| **`MEMBER_OF` edge** (symbol → community as edge, not column) | Community membership traversable in Cypher/graph queries; enables "find all symbols in community X that also call Y" | New `member_of` relation type (already listed in `NEXUS_RELATION_TYPES` as `member_of`); Phase 5 must emit these edges in addition to setting `community_id` column |
| **`DEFINES` edge** (file → symbol) | Allows file-level traversal queries without joining on `file_path`; enables "what does this file export" in pure graph terms | New `defines` relation type in `NEXUS_RELATION_TYPES` (currently absent); Phase 2/3 must emit `File -[defines]-> Symbol` edges |
| **`DECORATES` edge** | Decorator → decorated symbol tracking (TypeScript `@decorator`); needed for NestJS/Nest-style codebases | New `decorates` relation type; decorator extractor in Phase 4 |
| **Cross-repo `contracts.json`** | HTTP/gRPC/topic cross-linking with cascade matching (exact→manifest→BM25→embedding) | New `nexus_contracts` table in `nexus.db`; `HttpRouteExtractor`, `GrpcExtractor`, `TopicExtractor`; group config YAML schema |
| **LadybugDB / native graph engine** | Kuzu-compatible Cypher; HNSW vector index; FTS/BM25 natively; connection pooling; no full-graph load into JS memory | This is the deepest storage gap: SQLite + JS in-memory walks do not scale past ~100k relations. Options: adopt LadybugDB, adopt KuzuDB, adopt DuckDB-PGQ, or implement SQLite recursive CTEs as lightweight Cypher substitute (see HITL §7.1) |

### 4.2 cleo nexus features gitnexus cannot replicate

| cleo nexus feature | Why gitnexus cannot replicate it |
|---|---|
| **Cross-project TASKS registry** (`deps`, `critical-path`, `blocking`, `orphans`, `transfer`) | gitnexus has no task layer; it is purely a code intelligence tool. The TASKS×code co-index is architecturally impossible in gitnexus without a project management subsystem |
| **Hebbian plasticity** (`weight`, `co_accessed_count`, `last_accessed_at` on relations) | gitnexus has no memory/usage tracking on edges; edges are static post-index. cleo BRAIN co-access events automatically strengthen relation weights — a live signal absent from gitnexus |
| **Sentient Tier-2 nexus proposals** | gitnexus has no autonomous proposal loop. It is a CLI tool, not a sentient system. Orphaned-callee and over-coupled-node proposals feed into the sentient loop — a closed-loop architecture gitnexus cannot replicate |
| **BRAIN `documents`/`applies_to` cross-graph relations** | gitnexus has no memory substrate; brain entries cannot annotate code symbols in a shared graph |
| **Stable projectId-based reconciliation** (4-scenario policy across filesystem moves) | gitnexus stores repos by filesystem path in `~/.gitnexus/registry.json`; moved repos break links. cleo uses a UUID from `project-info.json` as stable key |
| **`nexus_audit_log`** | gitnexus has no operation audit trail |
| **GEXF export with plasticity weights** | gitnexus has no export command; no edge weight concept |
| **IVTR-enforced breaking-change gates** (proposed in P2) | gitnexus has no verification/testing gate integration; no concept of IVTR |

---

## 5. P0 / P1 / P2 Classification

### P0 — Parity Blockers (cleo MUST absorb to stop losing head-to-head comparisons)

These are the features agents will ask for first when choosing a code intelligence tool. Their absence causes cleo to lose every benchmark where raw code query power is evaluated.

| Gap | Evidence | Urgency |
|---|---|---|
| **Raw graph query DSL (Cypher or equivalent)** | cleo nexus has zero ad-hoc query surface. Every "find all callers of X that also import Y" query requires writing new TypeScript code. gitnexus answers it in a single Cypher statement. The T1046 run explicitly logged "NOT AVAILABLE" for this capability. | CRITICAL |
| **Embeddings + semantic hybrid search** | `cleo nexus search "authentication"` returned task-management results, not code symbols. gitnexus `query "authentication flow"` returned process-grouped execution flows. Agents need "find code that does X" — cleo cannot answer this. | CRITICAL |
| **MCP tool surface for code graph** | 15 gitnexus MCP tools vs 0 cleo nexus MCP tools for code graph. Agents running via MCP (Claude Code, Cursor) cannot call `context`, `impact`, `clusters`, or `flows` as tool calls — they must shell out. This is the primary integration friction point. | CRITICAL |
| **Wiki / module documentation generator** | gitnexus generates browsable wiki from graph in one command. cleo has `doc_summary` fields but no aggregation pipeline. Without a wiki, agents have no auto-generated narrative documentation of the codebase. | HIGH |
| **Hook augmenter (PreToolUse Grep/Glob/Bash interception)** | gitnexus silently enriches every file search with caller/callee/flow context. cleo has no equivalent. Agents using cleo for code work miss graph context on every file operation. | HIGH |

### P1 — Competitive Parity+ (match gitnexus feature-for-feature, required within 2 epics)

| Gap | Evidence | Urgency |
|---|---|---|
| **Contract registry (cross-repo HTTP/gRPC/topic)** | gitnexus `group sync` extracts and cross-links contracts across repos with cascade matching. cleo has zero cross-project code contract analysis. This is required for any multi-service monorepo or microservice architecture. | HIGH |
| **Edge-type coverage audit (IMPORTS persistence)** | 390k unresolved calls in cleo nexus vs 390k IMPORTS edges in gitnexus on the same codebase. Persisting unresolved import stubs as `ExternalModule` nodes would close ~55% of the 4× edge gap with minimal engine change. | HIGH |
| **Node content retrieval (`--content` flag)** | gitnexus `context --content <uid>` returns full source code of the symbol inline. cleo nexus context has no source retrieval. Agents performing code review or refactoring need source inline with graph context. | MEDIUM |
| **Richer community detection (Leiden + MEMBER_OF edges)** | 513 Louvain communities vs 6,797 Leiden communities on same codebase. MEMBER_OF edges as first-class relations enable community-constrained graph queries. Auto-labels are already a cleo strength — the algorithm needs upgrading. | MEDIUM |
| **Route/Tool node MCP tools** (`route_map`, `shape_check`, `api_impact`) | gitnexus has first-class API surface analysis. cleo's `route` kind and `handles_route` relation exist in schema but no surface commands. A `cleo nexus route-map` and `cleo nexus shape-check` would match gitnexus. | MEDIUM |
| **Section nodes (sub-file granularity)** | gitnexus 7,783 section nodes enable per-section wiki generation and more precise code navigation. cleo has no sub-file granularity beyond `start_line`/`end_line` on symbols. | LOW |

### P2 — Far-Exceed Differentiators (exploit cleo's unique structural advantages)

These are capabilities gitnexus cannot build without a task management and memory system. They represent cleo's permanent competitive moat.

| Capability | Why it far-exceeds | Implementation path |
|---|---|---|
| **TASKS×Nexus join queries** | Show all open tasks that reference files/functions in the blast radius of a proposed change. No code intelligence tool can answer "will this change break any active task's acceptance criteria?" | `cleo nexus impact --show-tasks` flag: after BFS, JOIN impacted node file_paths against tasks.db notes/acceptance fields for the project |
| **BRAIN plasticity-ranked code paths** | Query "what are the hottest execution paths in this codebase based on co-access patterns?" — a unique signal gitnexus cannot produce because it has no memory | New query op: `query nexus hot-paths --project` reads `nexus_relations ORDER BY weight DESC, co_accessed_count DESC`; surfaces top N edges as "frequently traversed paths" |
| **Sentient nexus proposals on code-graph drift** | Auto-propose tasks when graph metrics drift: new over-coupled nodes, orphaned callees, vanishing entry points, community fragmentation. Close the loop between static analysis and autonomous task queue | Extend `nexus-ingester.ts`: add community fragmentation detector (community that lost >20% of its symbols), entry-point erosion detector (process nodes with no entry_point_of edges), emit proposals with NEXUS_BASE_WEIGHT escalation |
| **IVTR-enforced breaking-change gates** | Before a task is marked complete, run `cleo nexus diff` + `cleo nexus impact` on changed symbols; if CRITICAL risk with no test coverage, block completion until author acknowledges | New `tasks complete` pre-hook: call `nexusBreakingChangeGate(changedFiles)` → emit structured warning; integrate with IVTR verification step |
| **Cross-project code-contract cascade traceable to cross-project TASKS** | "Service A changed its auth contract — which tasks in Services B, C, D are now at risk?" Links gitnexus-style contract registry with cleo's cross-project task registry. No tool in market can answer this. | Build on P1 contract registry: add `contract_task_linkage` table mapping contract_id → task_ids in affected projects; populate via `cleo nexus group sync --link-tasks` |

---

## 6. Decomposition Plan

### Epic 1 — Nexus P0: Core Query Power

**Goal**: Close the hard parity blockers that cause cleo to lose every head-to-head code intelligence benchmark. Agents must be able to query the code graph ad-hoc, find symbols semantically, and access graph operations as MCP tools without shelling out.

**Dependency order**: Task 1 (DSL engine choice) must resolve before Task 2 (Cypher implementation). Tasks 3 and 4 (embeddings) are independent of Task 1. Tasks 5–7 depend on Tasks 1–4 being stable.

---

**EP1-T1: Graph Engine Decision + Proof of Concept**

Size: medium

Rationale: The current SQLite + JS in-memory walk approach does not scale past ~100k relations (T1044 G5). Every P0 capability (Cypher, semantic hybrid search) depends on the engine decision. This task must resolve the HITL question before any implementation begins.

Acceptance criteria:
- Benchmark three options on openclaw (166k relations): (a) SQLite recursive CTEs, (b) KuzuDB embedded, (c) LadybugDB — measuring cold-start time | query latency for BFS at depth 3 | memory footprint | JS interop complexity
- Produce ADR documenting chosen engine, migration path from current `nexus.db` SQLite schema, and licensing implications (LadybugDB is PolyForm Noncommercial — may require commercial license)
- PoC: one working `MATCH (a)-[r:CALLS]->(b) WHERE b.name = 'X' RETURN a.name` query executing against openclaw index using chosen engine
- ADR committed to `docs/decisions/` | PoC code in `packages/core/src/nexus/engine/` under feature flag

Dependencies: None (unblocks EP1-T2)

---

**EP1-T2: Cypher / Graph Query DSL Surface**

Size: large

Rationale: The single highest-impact gap. Every "find all callers of X that also import Y" query requires the DSL. MCP tools, semantic search, and wiki generator all benefit from a live query surface.

Acceptance criteria:
- `cleo nexus cypher "<query>"` executes against the chosen graph engine (EP1-T1) | returns markdown table + row_count | supports MATCH/WHERE/RETURN/ORDER BY/LIMIT
- Schema documented: node labels map to cleo node kinds; `CodeRelation` label with `type` property for edges (same convention as gitnexus for LLM writability)
- Query validation: malformed queries return structured error with `E_NEXUS_CYPHER_PARSE` code, not stack trace
- MCP tool `nexus_cypher` added (see EP1-T5)
- `packages/core/src/nexus/` contains `cypher-executor.ts` with TSDoc; `packages/contracts/src/` contains `NexusCypherResult` type
- Biome + build + test green | zero `any` types

Dependencies: EP1-T1 resolved

---

**EP1-T3: Embeddings Pipeline + Vector Index**

Size: large

Rationale: Semantic hybrid search (BM25 + HNSW + RRF) is required to answer "find code that does X" queries. Without it, cleo nexus cannot serve discovery use cases that are the primary driver of agent code navigation.

Acceptance criteria:
- `cleo nexus analyze --embeddings` generates 384-dim embeddings for all Function/Class/Method nodes using a local-first model (snowflake-arctic-embed-xs via transformers.js or ONNX, matching gitnexus's model for comparability)
- Embeddings stored in `nexus_embeddings(node_id, project_id, embedding BLOB)` table in `nexus.db`; HNSW index built via sqlite-vec extension OR hnswlib sidecar file under `~/.cleo/nexus/hnsw/`
- `--embeddings` is opt-in (default off) to avoid 24s→?s analyze regression for users without GPU/CPU time
- Embedding freshness tracked: node `indexed_at` vs embedding `embedded_at`; stale embeddings re-generated on next `--embeddings` run
- Schema migration handled by Drizzle migration file
- Biome + build + test green

Dependencies: EP1-T1 for storage layer (can use SQLite sqlite-vec regardless of graph engine decision)

---

**EP1-T4: Semantic Hybrid Search Command**

Size: medium

Rationale: The user-facing surface for EP1-T3. Replaces the current name-substring search with a BM25+HNSW+RRF pipeline matching gitnexus `query` behavior.

Acceptance criteria:
- `cleo nexus query "<natural language>"` runs BM25 keyword search over `doc_summary` + `label` + `name` fields via SQLite FTS5 | when `--embeddings` index exists, also runs HNSW cosine search | merges via RRF (k=60) | returns top N symbols grouped by process participation
- `--limit N` flag (default 10) | `--context "<task description>"` flag to bias BM25 toward task context | `--content` flag to include full source (see EP1-T6)
- `--semantic` flag requires embeddings; gracefully degrades to BM25-only if embeddings absent with a logged warning
- `cleo nexus query "authentication flow"` on openclaw returns auth-domain symbols (not task-flow code as currently happens with task-search misrouting)
- MCP tool `nexus_query` added (see EP1-T5)
- Biome + build + test green

Dependencies: EP1-T3 (for semantic path); BM25-only path has no dependency

---

**EP1-T5: MCP Tool Suite for Code Graph**

Size: large

Rationale: 15 gitnexus MCP tools vs 0 cleo nexus MCP tools for code graph. Agents embedded in Claude Code, Cursor, or OpenCode cannot call graph ops inline. This is the primary agent-integration gap.

Acceptance criteria:
- `cleo nexus mcp` starts an MCP server (stdio transport) exposing these tools: `nexus_context`, `nexus_impact`, `nexus_query`, `nexus_cypher`, `nexus_clusters`, `nexus_flows`, `nexus_diff`, `nexus_export`, `nexus_list_repos`, `nexus_status`
- Resource templates: `nexus://repos`, `nexus://repo/{name}/clusters`, `nexus://repo/{name}/flows`, `nexus://repo/{name}/schema`
- Prompts: `detect_impact` (guided pre-commit analysis), `explain_cluster` (community narrative)
- All tool inputs/outputs use `packages/contracts/src/nexus/` types (no inline types)
- MCP server registered in `packages/cleo-os/` per package boundary check (harness concern)
- `gitnexus setup`-equivalent: `cleo nexus setup` writes MCP server config to `~/.claude/mcp.json` or Claude Code settings
- Biome + build + test green | integration test: at least 3 tools called against openclaw via MCP stdio

Dependencies: EP1-T2 (cypher tool), EP1-T4 (query tool); other tools can be built from existing CLI ops in parallel

---

**EP1-T6: Node Content Retrieval (`--content` flag)**

Size: small

Rationale: gitnexus `context --content <uid>` returns full source code of a symbol inline. cleo nexus has `start_line`/`end_line` on all nodes but no source retrieval command. Agents performing code review need this.

Acceptance criteria:
- `cleo nexus context <symbol> --content` reads `file_path` + `start_line` + `end_line` from `nexus_nodes`, opens the source file, extracts the line range, and appends to context output
- `--uid <node_id>` flag enables zero-ambiguity lookup (bypass name search)
- `nexus_context` MCP tool accepts optional `include_content: boolean` parameter
- Gracefully handles: file deleted since last index (returns warning, not crash); binary files (skips content, notes in output)
- Biome + build + test green (unit test: mock file read, verify correct line extraction)

Dependencies: EP1-T5 (for MCP tool integration)

---

**EP1-T7: Hook Augmenter (PreToolUse Grep/Glob/Bash)**

Size: medium

Rationale: gitnexus transparently enriches every file search with graph context via a Claude Code hook. This zero-friction codebase awareness injection is the highest-impact UX feature for agents doing code work. cleo has no equivalent.

Acceptance criteria:
- `cleo nexus setup` installs `~/.claude/hooks/cleo-nexus-hook.cjs` (CJS to avoid ESM/native stdout capture issues, matching gitnexus's approach)
- Hook intercepts PreToolUse for `Grep`, `Glob`, and `Bash` (grep/rg) tool calls
- Extracts search pattern, calls `cleo nexus augment <pattern>` (new lightweight command: BM25-only, no embeddings, <500ms cold start target)
- Injects result as `additionalContext` on the tool call
- PostToolUse: detects git mutations (commit/merge/rebase/pull), notifies agent to run `cleo nexus analyze --incremental`
- `cleo nexus augment <pattern>` returns top 5 symbols with callers/callees/community in plain text to stderr (matching gitnexus architecture)
- Hook is idempotent (re-running `setup` does not duplicate hook entries)
- Biome + build + test green | manual smoke test documented in acceptance

Dependencies: EP1-T4 (augment uses BM25 path)

---

**EP1-T8: Wiki / Module Documentation Generator**

Size: large

Rationale: gitnexus generates a browsable LLM-authored wiki from the graph in one command. cleo has `doc_summary` fields but no aggregation pipeline. Agents need auto-generated narrative documentation.

Acceptance criteria:
- `cleo nexus wiki [path]` runs a 3-phase LLM pipeline: (1) module grouping from community nodes → `module_tree.json`; (2) per-module pages (parallel, `--concurrency 3`) using community symbols + call edges + process participation; (3) overview page with inter-module summary
- `--provider openai|cursor` | `--model <model>` | `--api-key` | `--base-url` flags for OpenAI-compatible backends
- Output: `.cleo/nexus-wiki/overview.md`, `.cleo/nexus-wiki/<module-slug>.md`, `module_tree.json`, `index.html`
- Incremental rebuild: `--force` re-generates all; default uses `git diff` to find changed files → affected communities → only those modules regenerated
- SKILL.md files generated per community (matching gitnexus `--skills` flag): written to `.cleo/nexus-skills/<community-slug>.md`; appended to `AGENTS.md` injection section
- Requires embeddings index OR gracefully degrades to BM25-only module grouping
- Biome + build + test green | LLM calls mocked in unit tests

Dependencies: EP1-T3 (embeddings for module grouping quality), EP1-T5 (MCP resource `nexus://repo/{name}/clusters`)

---

### Epic 2 — Nexus P1: Competitive Completeness

**Goal**: Achieve full feature parity with gitnexus on the dimensions where cleo currently lags, and resolve the edge coverage gap.

---

**EP2-T1: IMPORTS Edge Persistence (Unresolved Import Stubs)**

Size: medium

Rationale: 390k unresolved calls in cleo nexus are silently discarded. gitnexus logs these as IMPORTS edges (390,924 on openclaw). Persisting them as `ExternalModule` nodes with `imports` edges would close ~55% of the 4× edge gap and enable cross-package blast-radius analysis.

Acceptance criteria:
- Phase 3 (import resolution) emits `ExternalModule` nodes for unresolved specifiers (npm packages, relative paths outside project root, Node built-ins)
- `imports` edges created: `File/Symbol -[imports]-> ExternalModule` with `confidence=0.9` (matching gitnexus convention)
- `ExternalModule` nodes are NOT shown by default in `context`/`impact` output (too noisy); shown when `--include-external` flag is passed
- Post-implementation: openclaw edge count should reach ≥350k (gitnexus parity within 10%)
- `nexus_nodes.kind = 'external_module'` added to `NEXUS_NODE_KINDS`
- Migration: existing indices untouched; new nodes inserted on next full re-index
- Biome + build + test green

Dependencies: None

---

**EP2-T2: Leiden Community Detection + MEMBER_OF Edges**

Size: medium

Rationale: Leiden produces ~10–15× finer partitions than Louvain for large sparse graphs. Emitting MEMBER_OF edges as first-class relations enables community-constrained Cypher queries. Auto-labels are already a cleo strength; the algorithm upgrade is the gap.

Acceptance criteria:
- Phase 5 (community detection) replaced with Leiden algorithm via `leidenalg` JS binding or Rust implementation (via `@cleocode/core/nexus/leiden.rs` if Rust is available) — fallback to Louvain if Leiden not available, with logged warning
- `member_of` relation emitted in Phase 5: `Symbol -[member_of]-> Community` for every symbol assigned to a community (in addition to setting `community_id` column)
- openclaw community count should reach ≥3,000 post-implementation (Leiden at default resolution)
- `cleo nexus clusters` output unchanged (reads community nodes); no CLI surface change
- Modularity score logged post-detection; regression check: modularity must remain ≥0.5 on cleocode
- Biome + build + test green

Dependencies: EP1-T1 (if graph engine changes affect Phase 5 input format)

---

**EP2-T3: Contract Registry (Cross-Repo HTTP/gRPC/Topic)**

Size: large

Rationale: gitnexus `group sync` extracts and cross-links API contracts across repos with cascade matching. cleo has zero cross-project code contract analysis. Required for multi-service architectures.

Acceptance criteria:
- `cleo nexus group create <name>` creates `~/.cleo/nexus/groups/<name>/group.yaml` with template
- `cleo nexus group add <group> <path> <registry>` registers a repo in the group
- `cleo nexus group sync <name>` runs: (1) `HttpRouteExtractor` (Route nodes → HTTP contracts); (2) `GrpcExtractor`; (3) `TopicExtractor`; (4) cascade matching (exact → manifest → BM25 → embedding if available) → writes `contracts.json`
- `cleo nexus group contracts <name>` displays contract registry with cross-links and confidence scores
- `cleo nexus group query <name> "<query>"` runs semantic query across all member repos, RRF-merges results
- `nexus_contracts` table added to `nexus.db`: `(contract_id, group_name, repo_path, contract_type, path_or_topic, role, crossLinks_json)`
- MCP tools: `nexus_group_sync`, `nexus_group_contracts`, `nexus_group_query` added to EP1-T5 MCP server
- Biome + build + test green | integration test with 2 mock repos

Dependencies: EP1-T4 (for `group query` semantic merge)

---

**EP2-T4: Route Map, Shape Check, and API Impact Commands**

Size: medium

Rationale: `route` kind and `handles_route`/`fetches` relations already exist in cleo nexus schema. gitnexus exposes `route_map`, `shape_check`, and `api_impact` as first-class tools. cleo needs commands to surface this existing data.

Acceptance criteria:
- `cleo nexus route-map [--project]` lists all Route nodes with handler function, HTTP method, path, middleware; groups by module/community
- `cleo nexus shape-check <route-path>` checks response key claims of route handler against consuming ACCESSES patterns on those keys; reports mismatches
- `cleo nexus api-impact <route-path>` combines route_map + shape_check + impact BFS: "if this route changes, what breaks?"
- Route extractor in pipeline Phase 3 must populate `meta_json.method`, `meta_json.path`, `meta_json.responseKeys` (currently missing per T1044 surface doc)
- MCP tools: `nexus_route_map`, `nexus_shape_check`, `nexus_api_impact` added to EP1-T5 MCP server
- Biome + build + test green

Dependencies: EP1-T5 (MCP tools)

---

**EP2-T5: DEFINES Edges + Incremental Community/Flow Re-detection**

Size: small

Rationale: gitnexus emits 55,550 DEFINES edges (file → symbol), enabling pure-graph "what does this file export?" queries without joining on `file_path`. cleo uses `parent_id` column which is not traversable in Cypher. Also fixes T1044 G8 (community/flow always full re-run on incremental).

Acceptance criteria:
- Phase 2 (structure processor) emits `File -[defines]-> Symbol` edges for all indexed symbols
- `defines` added to `NEXUS_RELATION_TYPES` (currently absent from the 27-type list per T1044 surface doc)
- Incremental mode: community detection (Phase 5) and process detection (Phase 6) run only on sub-graphs containing changed nodes (approximation: re-run communities for any community that had ≥1 changed member)
- openclaw DEFINES edge count should reach ~55k (matching gitnexus)
- Biome + build + test green

Dependencies: None

---

### Epic 3 — Nexus P2: Far-Exceed Differentiators

**Goal**: Build the capabilities that no competitor can replicate, anchored in cleo's unique BRAIN+TASKS+NEXUS unified graph.

---

**EP3-T1: TASKS×Nexus Impact Join (`--show-tasks` flag)**

Size: medium

Rationale: The single most differentiated P2 feature. "Will this code change break any active task?" is a question no code intelligence tool can answer — only cleo, because it co-indexes code graphs and task databases.

Acceptance criteria:
- `cleo nexus impact <symbol> --show-tasks` — after BFS, for each impacted node: extract `file_path`, query current project's `tasks.db` for tasks whose `notes`, `description`, or acceptance criteria contain the `file_path` or symbol name
- Output section appended: "Potentially affected tasks: T123 (in progress) — references `auth-config-utils.ts`"
- `--cross-project` flag: also queries all registered projects' `tasks.db` files for the same file_path matches
- MCP tool `nexus_impact` updated to accept `include_tasks: boolean` parameter (EP1-T5 dependency)
- `packages/core/src/nexus/tasks-bridge.ts` module isolates the cross-db join logic; TSDoc on all exports
- Biome + build + test green | unit test with mock tasks.db

Dependencies: EP1-T5 (MCP integration)

---

**EP3-T2: BRAIN Plasticity-Ranked Code Path Queries**

Size: medium

Rationale: `nexus_relations.weight` accumulates co-access signal from BRAIN retrievals (T998 Hebbian plasticity). This is a unique live signal — "the code paths agents have actually navigated most" — that gitnexus cannot produce.

Acceptance criteria:
- `cleo nexus hot-paths [--project] [--limit 20]` queries `nexus_relations ORDER BY weight DESC, co_accessed_count DESC` and returns top N edges as a ranked "frequently traversed call graph" section
- `cleo nexus hot-nodes [--project] [--limit 20]` aggregates by node: SUM(weight) of all incoming/outgoing relations → "hottest symbols by agent co-access"
- T1044 G9 fixed: `query nexus top-entries` updated to read `nexus_relations.weight` directly (not `brain_page_nodes.quality_score` proxy) after T998 shipped
- Both commands exposed as MCP tools `nexus_hot_paths`, `nexus_hot_nodes` (EP1-T5 dependency)
- `nexus-bridge.md` updated to include "Top plasticity-weighted paths" section (top 5 by weight)
- Biome + build + test green

Dependencies: EP1-T5 (MCP tools); T998 weight column already present (no schema change)

---

**EP3-T3: Sentient Nexus Proposals — Extended Pattern Detectors**

Size: medium

Rationale: The existing `nexus-ingester.ts` detects orphaned callees and over-coupled nodes. Expanding the detector set to include community fragmentation, entry-point erosion, and cross-community coupling spikes closes the loop between structural drift and autonomous task proposals.

Acceptance criteria:
- `nexus-ingester.ts` extended with three new detectors:
  - **Community fragmentation**: community whose `symbolCount` dropped >20% since last analyze → propose "Investigate community fragmentation in <label>"
  - **Entry-point erosion**: process node whose `entry_point_of` source was removed or became unexported → propose "Restore or replace lost entry point <name>"
  - **Cross-community coupling spike**: any symbol with `degree > 30 AND cross_community_edges > 15` → propose "Decouple over-reaching symbol <name>"
- Each detector produces `ProposalCandidate` with `NEXUS_BASE_WEIGHT` escalation (fragmentation=0.4, erosion=0.5, coupling_spike=0.35) — above the existing 0.3 base
- Detector results logged to `nexus_audit_log` with `action='sentient.nexus.proposal'`
- Post-analyze hook: detectors run automatically after every successful `cleo nexus analyze`
- Biome + build + test green | unit tests for each detector with synthetic graph data

Dependencies: None (extends existing ingester); EP1-T2 (Cypher queries can replace some JS BFS in detectors)

---

**EP3-T4: IVTR Breaking-Change Gate (pre-`tasks complete` hook)**

Size: medium

Rationale: Before a task is marked complete, automatically detect if changed files contain CRITICAL-risk symbols with no associated test coverage. This closes the loop between code intelligence and task verification — a capability that cannot exist in a code-only tool like gitnexus.

Acceptance criteria:
- `cleo tasks complete <TASK_ID>` triggers a new pre-complete hook: `nexusBreakingChangeGate(taskId)`
- Gate: (1) reads task's changed files from git diff against task's branch base; (2) calls `cleo nexus impact` on each changed exported symbol; (3) if any symbol scores CRITICAL or HIGH risk AND has no associated test files in the impact set → emits structured warning `E_NEXUS_BREAKING_CHANGE_RISK`
- Warning is non-blocking by default; `--breaking-change-gate=strict` config flag makes it blocking (requires human override)
- Override: `cleo tasks complete <TASK_ID> --acknowledge-breaking-change` bypasses the gate with a logged reason
- Gate result stored in `nexus_audit_log` with `action='ivtr.breaking_change_gate'`
- `packages/core/src/nexus/breaking-change-gate.ts` isolates gate logic; TSDoc on all exports
- Biome + build + test green | unit test: mock impact output, verify gate fires correctly

Dependencies: EP1-T6 (content retrieval for test file detection)

---

**EP3-T5: Cross-Project Code-Contract Cascade Linked to Cross-Project Tasks**

Size: large

Rationale: The apex differentiator. "Service A changed its auth contract — which tasks in Services B, C, D are at risk?" Links the P1 contract registry (EP2-T3) with cleo's cross-project task registry. No tool in the market can answer this question.

Acceptance criteria:
- `cleo nexus group impact <group-name> <contract-path>` runs: (1) identify changed contract in group's Contract Registry; (2) find all repos that consume this contract (crossLinks in `contracts.json`); (3) for each consuming repo, run `cleo nexus impact` on the consuming symbol; (4) for each impacted node, query that repo's `tasks.db` for affected tasks
- Output: per-repo impact report with affected tasks list and their status
- `nexus_contract_task_links` table: `(contract_id, repo_path, task_id, link_type, detected_at)` — populated by `group sync --link-tasks`
- MCP tool `nexus_group_impact` exposes this as a single call
- `cleo nexus group sync --link-tasks` runs contract extraction + task linking in one pass
- Biome + build + test green | integration test with 2 mock repos + 2 mock tasks.db files

Dependencies: EP2-T3 (contract registry); EP3-T1 (TASKS×Nexus join)

---

### Summary of Proposed Epics and Task Counts

| Epic | Tasks | Total Size | Primary Outcome |
|---|---|---|---|
| Epic 1 — Nexus P0: Core Query Power | 8 (T1–T8) | 3× large + 3× medium + 2× small | Stop losing benchmarks; Cypher DSL, embeddings, MCP tools, wiki, hooks |
| Epic 2 — Nexus P1: Competitive Completeness | 5 (T1–T5) | 2× large + 2× medium + 1× small | Match gitnexus feature-for-feature; edge coverage, contract registry, route tools |
| Epic 3 — Nexus P2: Far-Exceed Differentiators | 5 (T1–T5) | 1× large + 4× medium | Moat features: TASKS×code join, plasticity queries, sentient proposals, IVTR gate, cross-project contracts→tasks |

Total: 18 child tasks across 3 epics.

---

## 7. Open Questions for HITL

The following decisions require owner judgment before Epic 1 work begins. Each is a meaningful architectural or strategic fork.

### HITL-1: Graph Engine — LadybugDB, KuzuDB, DuckDB-PGQ, or SQLite Recursive CTEs?

LadybugDB is PolyForm Noncommercial — using it in CLEO (a commercial or future-commercial product) requires a paid license. KuzuDB is MIT. DuckDB-PGQ is MIT. SQLite recursive CTEs avoid a new engine entirely but are limited to pattern-matching that maps to CTEs (no full Cypher). The owner must decide: (a) negotiate a LadybugDB commercial license for parity with gitnexus's exact engine; (b) adopt KuzuDB (MIT, Cypher-native, well-maintained); (c) stay on SQLite with a lightweight Cypher-to-CTE transpiler; (d) adopt DuckDB (in-process OLAP with graph pattern matching via PGQ extension, not full Cypher). This decision gates EP1-T1 and must be resolved before EP1-T2 can begin.

### HITL-2: Embeddings Model — Local (transformers.js) vs. Remote API vs. Optional?

gitnexus uses `snowflake-arctic-embed-xs` (384-dim) which runs on-device via ONNX. This model adds ~50MB to the dependency footprint and requires ONNX Runtime. The alternative is using the same model via a remote API (e.g., OpenAI `text-embedding-3-small`). A third option is making embeddings entirely optional (as gitnexus does with `--embeddings` flag). The owner should decide: (a) bundle transformers.js + snowflake-arctic-embed-xs for full offline capability; (b) support both local and remote with the same `--embeddings` flag; (c) keep it optional but make the default behavior BM25-only, with a clear upgrade path. This decision gates EP1-T3.

### HITL-3: Wiki Generator — LLM Provider Strategy

gitnexus supports `--provider openai` and `--provider cursor`. cleo has a broader LLM abstraction (LOOM). Should the wiki generator use the LOOM abstraction (consistent with cleo's architecture) or implement a direct OpenAI-compatible client (simpler, faster to ship, matches gitnexus behavior)? If LOOM is used, wiki generation benefits from provider switching and any future LOOM improvements. If direct client, it's a faster ship but creates a second LLM call path. This decision gates EP1-T8.

### HITL-4: MCP Server Package Placement

Per the package boundary check in AGENTS.md, harness-specific code belongs in `packages/cleo-os/`. An MCP server is a harness concern. However, the NEXUS domain logic must remain in `packages/core/`. Should the MCP server live in `packages/cleo-os/src/mcp/nexus-mcp-server.ts` (correct boundary) or in `packages/cleo/` alongside the existing CLI (faster to ship, but violates boundary)? This decision gates EP1-T5.

### HITL-5: Backward Compatibility on Edge Schema Expansion

Adding IMPORTS stubs (EP2-T1), DEFINES edges (EP2-T5), and MEMBER_OF edges (EP2-T2) will roughly triple the edge count in `nexus.db` for large repos. For a repo like cleocode (~48k relations today), this becomes ~150k. For openclaw, this becomes ~500k+. Does the owner want a migration gate (ask before expanding edge count) or automatic on next re-index? Also: should old indexes be purged before re-index to avoid stale rows, or should the reconcile policy handle it incrementally? This decision gates EP2-T1/T2/T5.

### HITL-6: Community Detection — Leiden Library Choice

The `leidenalg` Python library is widely used but requires Python interop from Node.js. A pure-JS implementation (`graphology-leiden` does not exist as of April 2026). A Rust implementation could be built in `packages/core/` using the `leiden` crate (MIT). Alternatively, stay on Louvain but increase resolution parameter (gets closer to Leiden output volume without algorithm change). The owner should decide: (a) Rust Leiden implementation (best quality, fits Rust+TS monorepo); (b) Python subprocess for `leidenalg` (works but adds Python dependency); (c) Louvain at higher resolution (fast ship, approximation). This decision gates EP2-T2.

### HITL-7: Breaking-Change Gate Severity Default

EP3-T4 proposes a non-blocking warning by default. The owner must decide: (a) non-blocking (warning only, agent can proceed) — safest for adoption; (b) blocking by default for CRITICAL-risk changes — highest quality enforcement; (c) configurable per project in `.cleo/config.json`. The chosen default affects task completion UX across all projects using cleo. If blocking, the gate needs an explicit override path with a logged reason.
