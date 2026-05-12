# CLEO Nexus Run Summary — openclaw

**Task**: T1046
**Date**: 2026-04-20
**Target**: /mnt/projects/openclaw
**CLEO Version**: v2026.4.100
**Analyze Duration**: ~24 seconds (24006ms)

---

## Indexed Statistics (from `cleo nexus analyze`)

| Metric | Value |
|--------|-------|
| Files scanned | 14,888 total (14,114 indexed after filter) |
| Files skipped (>512KB) | 11 |
| Nodes (symbols + files) | 64,637 |
| Relations | 166,257 |
| Barrel files with re-export chains | 1,395 |
| Call relations (tier1/tier2a/tier3) | 53,906 / 71,781 / 25,475 |
| Unresolved calls | 390,191 |
| Heritage: extends | 136 |
| Heritage: implements | 30 |
| Class members: has_method | 1,231 |
| Class members: has_property | 1,068 |
| Communities (Louvain, filtered) | 513 detected (307 shown in output) |
| Louvain modularity | 0.733 |
| Louvain nodes used | 26,945 |
| Execution flows (processes) | 75 (118 unique endpoint pairs before dedup) |
| Cross-community flows | 62 |
| Average flow steps | 6.1 |
| Project ID (base64) | L21udC9wcm9qZWN0cy9vcGVuY2xhdw |

**Status command confirms**: 64,421 nodes, 166,257 relations, last indexed 2026-04-20T16:15:38Z, staleness = up to date.

---

## Commands Attempted vs Succeeded

| # | Command | Status | Notes |
|---|---------|--------|-------|
| 1 | `cleo nexus analyze .` | SUCCESS | 24s, 64,637 nodes, 166,257 relations |
| 2 | `cleo nexus status` | SUCCESS | Confirms freshness, node/relation counts |
| 3 | `cleo nexus clusters` | SUCCESS | 307 communities listed (513 total detected) |
| 4 | `cleo nexus flows` | SUCCESS | 75 execution flows listed |
| 5a | `cleo nexus context loadConfig` | SUCCESS | 32 matches, 20 callers, process participation shown |
| 5b | `cleo nexus context resolveGatewayAuthSecretRef` | SUCCESS | 3 matches, callers/callees |
| 5c | `cleo nexus context deriveSessionChatType` | SUCCESS | 3 matches, callers/callees |
| 5d | `cleo nexus context createAuthRateLimiter` | SUCCESS | 1 match, 6 callers, 7 callees |
| 5e | `cleo nexus context resolveAssistantIdentity` | SUCCESS | 1 match, 4 callers, 8 callees |
| 5f | `cleo nexus context runLegacyCliEntry` | SUCCESS | 1 match, 1 caller, 2 callees |
| 6a | `cleo nexus impact loadConfig` | SUCCESS | CRITICAL risk, 1108 impacted nodes (285/418/405 across d=1/2/3) |
| 6b | `cleo nexus impact resolveGatewayAuthSecretRef` | SUCCESS | MEDIUM risk, 5 impacted nodes |
| 6c | `cleo nexus impact deriveSessionChatType` | SUCCESS | HIGH risk, 12 impacted nodes |
| 6d | `cleo nexus impact createAuthRateLimiter` | SUCCESS | HIGH risk, 12 impacted nodes |
| 6e | `cleo nexus impact resolveAssistantIdentity` | SUCCESS | MEDIUM risk, 7 impacted nodes |
| 6f | `cleo nexus impact runLegacyCliEntry` | SUCCESS | LOW risk, 1 impacted node |
| 7 | `cleo nexus graph` | HUNG/TIMEOUT | Task-graph command — operates on cross-project TASK dependency graph, not code graph. 37,303 registered projects caused hang. |
| 8a | `cleo nexus export --format gexf` | SUCCESS | Produces valid GEXF XML with node kind, filePath, language, startLine, endLine, isExported, relationType, confidence |
| 8b | `cleo nexus export --format json` | SUCCESS | Produces JSON with same attributes; full graph ~64k nodes |
| 9 | `cleo nexus diff d2e2d971b6 eb4a9f2a2a` | SUCCESS | Detected 761 symbols removed, REGRESSIONS_DETECTED; changed files identified |
| 10 | `cleo nexus projects list` | SUCCESS | 37,303 registered projects |
| 10 | `cleo nexus list` | SUCCESS (alias) | Lists registered projects (same as projects list) |
| 11 | `cleo nexus search "authentication"` | WRONG DOMAIN | Task-search only (cross-project task text search), NOT code symbol search |
| 12 | `cleo nexus discover "error handling"` | ERROR (exit 2) | Task-reference resolver only; expects T-ID format (T001, project:T001). No semantic code query. |
| 13 | Raw Cypher / graph query | NOT AVAILABLE | No Cypher, GQL, SPARQL, or GraphQL surface exposed |

---

## Notable Capabilities Demonstrated

### 1. Multi-Scale Community Detection (Louvain)
513 communities detected on openclaw's 14,114-file codebase. Communities are semantically labeled (Reply, Secrets, Outbound, Agents, Auth-profiles, Plugins, etc.). Cohesion scores range from 0.365 (loose) to 1.000 (perfectly dense). The largest community (Reply, 581 symbols, cohesion=0.432) represents a loosely coupled but topically unified cluster.

### 2. Impact Analysis with Risk Tiers
Three-depth blast radius: d=1 (WILL BREAK), d=2 (LIKELY AFFECTED), d=3 (MAY NEED TESTING). `loadConfig` scores CRITICAL with 1,108 total impacted nodes — a hub function. `runLegacyCliEntry` scores LOW (1 node) — a well-isolated entry point. Risk classifications are auto-derived from fan-out counts.

### 3. Execution Flow Tracing
75 named processes traced end-to-end across community boundaries. Flow names (e.g., `HandleAcpDoctorAction → Normalize`, `HandleOpenAiHttpRequest → SerializeConfigForm`) reveal actual execution paths between entry handlers and leaf utilities. `cross` vs `intra` type classification shows 62/75 are cross-community.

### 4. Incremental Diff Between Commits
`cleo nexus diff <A> <B>` runs an incremental re-index against the commit range, reports new/removed nodes and relations, and classifies health (REGRESSIONS_DETECTED when symbols are removed). In the tested commit pair, 761 symbols were removed (shared test helpers refactored out), relations unchanged.

### 5. GEXF / JSON Export for Visualization
Full code-intelligence graph exportable in Gephi-compatible GEXF XML and JSON. Node attributes include: kind (file/function/method/etc.), filePath, language, startLine, endLine, isExported, projectId. Edge attributes include: relationType (calls/imports/extends), confidence, reason. Ready for external graph tools.

### 6. Cross-Project Registry
37,303 projects registered globally. `analyze` auto-registers the project. Registry supports: list, register, unregister, scan, clean. Projects show task counts and indexed node/relation counts.

### 7. Community Labels are Auto-Derived
Labels like `Auth-profiles`, `Memory-lancedb`, `Anthropic-vertex`, `Pi-embedded-runner` show the analyzer derives semantically meaningful community names from the dominant symbols/files in each cluster. Not just `Cluster_N` labels.

---

## Missing Capabilities / Gaps

### 1. No Raw Graph Query Language
There is NO Cypher, GQL, SPARQL, GraphQL, or SQL query surface against the code graph. All queries are pre-defined operations (context, impact, clusters, flows). You cannot ask: "find all functions that call X AND are in community Y AND were added after commit Z."

### 2. No Semantic Code Symbol Search
`cleo nexus search` and `cleo nexus discover` are task-management operations (cross-project task text search and task-reference resolution). They do NOT search code symbols. To find symbols by behavior/name you must know the exact symbol name for `context`/`impact`.

### 3. No Path Finding Between Two Symbols
There is no `cleo nexus path <A> <B>` command. You can see callers/callees at depth 1 from `context`, and blast-radius at depth 1/2/3 from `impact`, but you cannot enumerate all paths between two arbitrary symbols.

### 4. No MCP Tools for Code Graph
The CLEO NEXUS code-intelligence graph is not exposed as MCP tools. There is no way for an agent to query the code graph via MCP protocol — only via the CLI. This means agents cannot embed code-graph queries inline in LLM tool-calling workflows.

### 5. No Wiki / Documentation Linkage
No linkage between code symbols and documentation pages, ADRs, or task notes. The graph is pure structural (calls/imports/extends). Community membership provides grouping but no narrative documentation.

### 6. Context Output Truncated at 5 Matches
`cleo nexus context <symbol>` for multi-match symbols (e.g., `loadConfig` with 32 matches) shows only 5 and says "use --json for full list." The `--json` flag would expose machine-readable output but is not tested here; full enumeration requires JSON mode.

### 7. `cleo nexus graph` Hangs on Large Registry
`cleo nexus graph` is a task-dependency cross-project graph viewer. With 37,303 registered projects it hung in background. This is a scalability limitation — the command lacks pagination or project-scope filtering.

---

## Failures / Limitations Encountered

| Issue | Details |
|-------|---------|
| `cleo focus set T1046` | `focus` is not a valid top-level cleo command (used `cleo start` equivalent is N/A here; task T1046 doesn't exist in openclaw's tasks.db) |
| `cleo nexus graph` hang | 37,303 registered projects in global nexus.db causes cross-project task graph to hang |
| `cleo nexus search "authentication"` | Long-running background process; task-search semantics only, not code search |
| `cleo nexus discover "error handling"` | E_INVALID_INPUT exit 2 — only accepts T-ID syntax |
| Export output is cleocode-indexed | GEXF/JSON export shows `projectId: L21udC9wcm9qZWN0cy9jbGVvY29kZS9w` (cleocode), not openclaw. Likely because the global nexus.db context defaults to current cwd at time of export. This needs investigation — may need `--project` flag to scope correctly. |
| Unresolved calls (390,191) | High unresolved call count relative to resolved (151,162 total resolved) suggests barrel re-exports and dynamic dispatch reduce precision. gitnexus comparison will show whether this is a fundamental limitation. |

---

## Symbols Used (Shared with T1045/gitnexus)

From `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/gitnexus-runs/symbols.txt`:
1. `loadConfig`
2. `resolveGatewayAuthSecretRef`
3. `deriveSessionChatType`
4. `createAuthRateLimiter`
5. `resolveAssistantIdentity`
6. `runLegacyCliEntry`

All 6 symbols found and queried successfully with both `context` and `impact`.

---

## Output Files

| File | Description |
|------|-------------|
| `01-analyze.log` | Full analyze pipeline output (~450 lines) |
| `02-status.log` | Index freshness report |
| `03-clusters.log` | All 307 communities with sizes and cohesion |
| `04-flows.log` | All 75 execution flows |
| `05-context-*.log` | Context (callers/callees/community/processes) for each of 6 symbols |
| `06-impact-*.log` | Blast radius at d=1/2/3 for each of 6 symbols |
| `07-graph.log` | Note: command hung (task-graph domain, not code graph) |
| `08-export-gexf.log` | GEXF XML export (truncated to 50 lines) |
| `08-export-json.log` | JSON export (truncated to 50 lines) |
| `09-diff.log` | Diff between commits d2e2d971b6..eb4a9f2a2a |
| `10-registry.log` | Projects list (37,303 entries) |
| `11-search.log` | Task search — wrong domain, not code search |
| `12-discover.log` | Task reference resolver — E_INVALID_INPUT for semantic queries |
| `13-raw-query-gap.log` | Documentation of missing raw/cypher query surface |
| `symbols.txt` | Shared symbol list for apples-to-apples comparison with T1045 |
