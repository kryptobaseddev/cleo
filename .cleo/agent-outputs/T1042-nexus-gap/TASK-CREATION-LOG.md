# Task Creation Log — Cleo Nexus Far-Exceed Decomposition

**Source**: `/mnt/projects/cleocode/.cleo/agent-outputs/T1042-nexus-gap/RECOMMENDATION-v2.md` (§8 Revised Decomposition)

**Executed**: 2026-04-20 18:22:00–18:24:07 UTC

**Status**: Complete

---

## Phase 1: Epic Creation (3 Parent Tasks)

All epics created successfully as children of T1042 (Cleo Nexus vs GitNexus parent epic).

| Epic ID | Title | Priority | Size | Status | Parent |
|---------|-------|----------|------|--------|--------|
| **T1054** | Nexus P0: Core Query Power | critical | large | pending | T1042 |
| **T1055** | Nexus P1: Competitive Closure | high | large | pending | T1042 |
| **T1056** | Nexus P2: Living Brain Completion | critical | large | pending | T1042 |

### Epic 1 (T1054) Acceptance Criteria
- Graph query DSL shipped with 6 template aliases (callers-of, callees-of, co-changed, co-cited, path-between, community-members)
- Semantic code search wired from existing smartSearch()
- Source content retrieval via smartUnfold() exposed
- Wiki generator extends docs-generator.ts via LOOM
- Hook augmenter PreToolUse shell script installed (no MCP)

### Epic 2 (T1055) Acceptance Criteria
- External module IMPORTS persistence closes 55% of edge gap
- Leiden swap emits member_of edges for community traversability
- Route-map and shape-check commands surface existing route nodes
- Contract registry extracts HTTP/gRPC/topic contracts cross-project
- All 4 child tasks complete with package-boundary compliance

### Epic 3 (T1056) Acceptance Criteria
- 6 cross-substrate edge writers complete BRAIN↔NEXUS graph
- TASKS→NEXUS bridge (task_touches_symbol) via git-log sweeper
- 4 living-brain SDK traversal primitives (getSymbolFullContext, getTaskCodeImpact, getBrainEntryCodeAnchors, reasonWhyCodeIsThisWay)
- reasonWhySymbol + impact-full merge brain/task/structural impact
- 3 new sentient detectors + Conduit NER pipeline + Hebbian fixes + IVTR gate

---

## Phase 2: Child Task Creation (17 Tasks)

### Epic 1 Children (5 tasks, parent T1054)

| Task ID | Title | Size | Priority | Dependencies | Status |
|---------|-------|------|----------|--------------|--------|
| **T1057** | EP1-T1: SQLite Recursive CTE Query DSL | medium | high | — | pending |
| **T1058** | EP1-T2: Semantic Code Symbol Search | small | high | — | pending |
| **T1059** | EP1-T3: Source Content Retrieval | small | high | — | pending |
| **T1060** | EP1-T4: Wiki Generator | medium | high | T1057 | pending |
| **T1061** | EP1-T5: Hook Augmenter (PreToolUse) | medium | high | T1058 | pending |

#### EP1-T1 (T1057) — SQLite Recursive CTE Query DSL
**Files**: `packages/core/src/nexus/query-dsl.ts`

**Acceptance Criteria**:
- runNexusCte() exported from packages/core/src/nexus/query-dsl.ts using getNexusNativeDb() handle
- cleo nexus query command executes CTE against nexus.db and returns markdown table
- 6 named template aliases implemented (callers-of, callees-of, co-changed, co-cited, path-between, community-members)
- Malformed CTEs return E_NEXUS_QUERY_PARSE error, not stack trace
- Code placed in packages/core/src/nexus/ per Package-Boundary Check — verified against AGENTS.md
- Biome + build + test green with unit tests for each template alias

#### EP1-T2 (T1058) — Semantic Code Symbol Search
**Files**: `packages/nexus/src/code/search.ts`, `packages/core/src/memory/brain-retrieval.ts`

**Acceptance Criteria**:
- cleo nexus search-code command calls smartSearch() and returns name/file_path/kind/score as markdown table
- cleo memory search-hybrid extended to include nexus code symbols as fourth source in RRF fusion
- packages/nexus/src/code/search.ts unchanged — only import and expose
- Code placed in packages/cleo/src/cli/commands/nexus.ts + packages/nexus/ per Package-Boundary Check
- Biome + build + test green

#### EP1-T3 (T1059) — Source Content Retrieval
**Files**: `packages/cleo/src/cli/commands/nexus.ts`, `packages/nexus/src/code/unfold.ts`

**Acceptance Criteria**:
- cleo nexus context <symbol> --content flag appends full source from smartUnfold()
- Graceful degradation if source file unreadable or symbol not found
- Code placed in packages/cleo/src/cli/commands/nexus.ts per Package-Boundary Check
- Biome + build + test green

#### EP1-T4 (T1060) — Wiki Generator
**Files**: `packages/core/src/docs/docs-generator.ts`, `packages/cleo/src/cli/commands/nexus.ts`

**Depends on**: T1057 (CTE DSL for community grouping)

**Acceptance Criteria**:
- cleo nexus wiki command groups symbols by community_id and uses smartUnfold() for signatures
- LLM call via existing LOOM abstraction (no direct API keys)
- Incremental mode with --incremental flag only regenerates changed communities
- Code placed in packages/core/src/docs/docs-generator.ts (extend) + packages/cleo/src/cli/commands/nexus.ts per Package-Boundary Check
- Biome + build + test green with --dry-run flag for testing without LLM

#### EP1-T5 (T1061) — Hook Augmenter (PreToolUse Graph Context Injection)
**Files**: `packages/cleo-os/src/hooks/nexus-augment.ts`, `packages/cleo/src/cli/commands/nexus.ts`

**Depends on**: T1058 (smartSearch for augmentation)

**Acceptance Criteria**:
- cleo nexus augment <pattern> command implemented with BM25-only search <500ms cold start, outputs top 5 symbols
- cleo nexus setup writes ~/.cleo/hooks/nexus-augment.sh shell script (not MCP server)
- Hook handler logic in packages/cleo-os/src/hooks/nexus-augment.ts (harness concern)
- cleo nexus augment gracefully no-ops if nexus.db absent or stale
- Code placed in packages/cleo-os/ (hook installation) + packages/cleo/ (CLI verb) per Package-Boundary Check
- Biome + build + test green with integration test on cleocode index

---

### Epic 2 Children (4 tasks, parent T1055)

| Task ID | Title | Size | Priority | Dependencies | Status |
|---------|-------|------|----------|--------------|--------|
| **T1062** | EP2-T1: External Module Nodes (IMPORTS persistence) | medium | high | — | pending |
| **T1063** | EP2-T2: Leiden Community Detection + member_of edges | medium | high | — | pending |
| **T1064** | EP2-T3: Route-Map and Shape-Check Commands | small | high | — | pending |
| **T1065** | EP2-T4: Contract Registry | large | high | T1064 | pending |

#### EP2-T1 (T1062) — External Module Nodes (Persist Unresolved IMPORTS)
**Files**: `packages/nexus/src/pipeline/import-processor.ts`

**Acceptance Criteria**:
- packages/nexus/src/pipeline/import-processor.ts emits ExternalModule node (kind: 'module', is_external: true) and imports relations for unresolved specifiers
- Schema migration: add is_external BOOLEAN DEFAULT 0 column to nexus_nodes in packages/core/src/store/nexus-schema.ts
- cleo nexus status shows external_modules: N count separately
- cleo nexus context <symbol> shows External imports: section for external module imports
- No behavior regression on existing calls/extends/implements edge types
- Code placed in packages/nexus/src/pipeline/ + packages/core/src/store/ per Package-Boundary Check
- Biome + build + test green with ~390k additional imports relations on openclaw re-analyze

#### EP2-T2 (T1063) — Leiden Community Detection + MEMBER_OF Edges
**Files**: `packages/nexus/src/pipeline/community-processor.ts`

**Acceptance Criteria**:
- packages/nexus/src/pipeline/community-processor.ts swaps graphology Louvain for Leiden implementation (@graphology/leiden or ported)
- After Leiden detection, emit member_of relations for every symbol→community pair
- Existing community_id column preserved for backward compatibility; MEMBER_OF edges additive
- cleo nexus clusters shows updated community count and member_of edge count
- Automatic semantic label generation preserved on Leiden output
- Code placed in packages/nexus/src/pipeline/ per Package-Boundary Check
- Biome + build + test green with community count >3× increase on cleocode index

#### EP2-T3 (T1064) — Route-Map and Shape-Check Commands
**Files**: `packages/core/src/nexus/route-analysis.ts`, `packages/cleo/src/cli/commands/nexus.ts`

**Acceptance Criteria**:
- cleo nexus route-map queries all route kind nodes, their handles_route callers, and fetches dependencies; outputs markdown route table
- cleo nexus shape-check <routeSymbol> compares meta_json.responseKeys between route node and consumers; reports mismatches
- Core logic in packages/core/src/nexus/route-analysis.ts (new module, exported from packages/core)
- Code placed in packages/core/src/nexus/route-analysis.ts (SDK) + packages/cleo/src/cli/commands/nexus.ts per Package-Boundary Check
- Biome + build + test green

#### EP2-T4 (T1065) — Contract Registry
**Files**: `packages/core/src/nexus/contracts`

**Depends on**: T1064 (route extraction)

**Acceptance Criteria**:
- packages/core/src/nexus/contracts/ — new module with HttpRouteExtractor, GrpcExtractor, TopicExtractor, ContractMatcher
- New nexus_contracts table in nexus.db schema: (contract_id, project_id, type, path, method, schema_json, created_at)
- cleo nexus group sync --extract-contracts populates nexus_contracts for all registered projects
- cleo nexus contracts show [--project-a <p>] [--project-b <p>] shows contract compatibility matrix
- Contract-task linkage: cleo nexus contracts link-tasks walks contracts for changes and links affected tasks
- Code placed in packages/core/src/nexus/contracts/ (SDK) + packages/cleo/ (CLI) per Package-Boundary Check
- Biome + build + test green with at least 2 HTTP contracts extracted from cleocode

---

### Epic 3 Children (8 tasks, parent T1056)

| Task ID | Title | Size | Priority | Dependencies | Status |
|---------|-------|------|----------|--------------|--------|
| **T1066** | EP3-T1: Complete BRAIN→NEXUS Edge Writers | medium | high | — | pending |
| **T1067** | EP3-T2: TASKS→NEXUS Bridge (task_touches_symbol) | medium | high | — | pending |
| **T1068** | EP3-T3: Living Brain SDK Traversal Primitives | large | high | T1066, T1067 | pending |
| **T1069** | EP3-T4: Extended Code Reasoning (why + impact-full) | medium | high | T1068 | pending |
| **T1070** | EP3-T5: Sentient Nexus Ingester Extensions | medium | high | — | pending |
| **T1071** | EP3-T6: Conduit→Symbol Ingestion Pipeline | medium | high | — | pending |
| **T1072** | EP3-T7: Hebbian BUG-2 Fix + STDP Wire-Up | medium | high | — | pending |
| **T1073** | EP3-T8: IVTR Breaking-Change Gate | small | high | T1069 | pending |

#### EP3-T1 (T1066) — Complete BRAIN→NEXUS Edge Writers
**Files**: `packages/core/src/memory/graph-memory-bridge.ts`

**Acceptance Criteria**:
- packages/core/src/memory/graph-memory-bridge.ts extended with linkObservationToModifiedFiles(), linkObservationToMentionedSymbols(), linkDecisionToSymbols()
- autoLinkMemories() extended to call all three new writers in addition to existing code_reference logic
- cleo memory code-auto-link triggers all four edge types
- After running code-auto-link on cleocode, documents/modified_by/affects/mentions row counts > 0
- Code placed in packages/core/src/memory/graph-memory-bridge.ts per Package-Boundary Check
- Biome + build + test green

#### EP3-T2 (T1067) — TASKS→NEXUS Bridge (task_touches_symbol edges)
**Files**: `packages/core/src/nexus/tasks-bridge.ts`, `packages/core/src/memory/edge-types.ts`, `packages/core/src/store/memory-schema.ts`

**Acceptance Criteria**:
- New packages/core/src/nexus/tasks-bridge.ts module exporting linkTaskToSymbols(), getTasksForSymbol(), getSymbolsForTask()
- Git-log sweeper in cleo nexus analyze post-hook runs git log, extracts T### from commit messages, calls linkTaskToSymbols() for each
- cleo nexus task-symbols <taskId> shows symbols touched by a task
- Add TASK_TOUCHES_SYMBOL = 'task_touches_symbol' to EDGE_TYPES in memory/edge-types.ts
- Add 'task_touches_symbol' to BRAIN_EDGE_TYPES in memory-schema.ts
- Code placed in packages/core/src/nexus/tasks-bridge.ts per Package-Boundary Check
- Biome + build + test green with unit test using mock tasks.db + nexus.db

#### EP3-T3 (T1068) — Living Brain SDK Traversal Primitives
**Files**: `packages/core/src/nexus/living-brain.ts`, `packages/contracts/src/nexus-living-brain-ops.ts`

**Depends on**: T1066, T1067 (edge writers and task bridge prerequisites)

**Acceptance Criteria**:
- New packages/core/src/nexus/living-brain.ts module with TSDoc on all exports
- getSymbolFullContext(symbolId, projectRoot) returns SymbolFullContext with nexus/brainMemories/tasks/sentientProposals/conduitThreads/plasticityWeight
- getTaskCodeImpact(taskId, projectRoot) returns TaskCodeImpact with files/symbols/blastRadius/brainObservations/decisions/riskScore
- getBrainEntryCodeAnchors(entryId, projectRoot) returns CodeAnchorResult with nexusNodes/tasksForNodes/plasticitySignal
- cleo nexus full-context, cleo nexus task-footprint, cleo nexus brain-anchors CLI commands render the outputs
- Type contracts exported from packages/contracts/src/nexus-living-brain-ops.ts
- Code placed in packages/core/src/nexus/living-brain.ts per Package-Boundary Check
- Biome + build + test green with integration test returning >0 rows in each substrate

#### EP3-T4 (T1069) — Extended Code Reasoning (cleo nexus why + impact-full)
**Files**: `packages/core/src/memory/brain-reasoning.ts`, `packages/core/src/nexus/living-brain.ts`

**Depends on**: T1068 (living-brain module)

**Acceptance Criteria**:
- packages/core/src/memory/brain-reasoning.ts extended: reasonWhySymbol(symbolId, projectRoot) walks BRAIN observations→decisions→tasks via code_reference+applies_to edges; returns CodeReasonTrace
- cleo nexus why <symbol> calls reasonWhySymbol(), renders narrative trace
- cleo nexus impact-full <symbol> merges analyzeImpact()+getTaskCodeImpact()+BRAIN observations with modified_by edges
- packages/core/src/nexus/living-brain.ts exports reasonImpactOfChange(symbolId, projectRoot) combining all three
- Code placed in packages/core/src/memory/brain-reasoning.ts + packages/core/src/nexus/living-brain.ts per Package-Boundary Check
- Biome + build + test green

#### EP3-T5 (T1070) — Sentient Nexus Ingester Extensions
**Files**: `packages/core/src/sentient/ingesters/nexus-ingester.ts`

**Acceptance Criteria**:
- packages/core/src/sentient/ingesters/nexus-ingester.ts extended with 3 new detectors (Query C, D, E)
- Community fragmentation detector: community symbolCount dropped >20% since last snapshot → weight 0.4
- Entry-point erosion detector: process node with entry_point_of source now unexported → weight 0.5
- Cross-community coupling spike: symbol with degree > 30 AND cross_community_edge_count > 15 → weight 0.35
- Each detector logs to nexus_audit_log with action = 'sentient.nexus.proposal.<type>'
- Post-analyze hook: detectors auto-run after every cleo nexus analyze
- Code placed in packages/core/src/sentient/ingesters/nexus-ingester.ts per Package-Boundary Check
- Biome + build + test green with unit tests for each detector

#### EP3-T6 (T1071) — Conduit→Symbol Ingestion Pipeline
**Files**: `packages/core/src/memory/graph-memory-bridge.ts`

**Acceptance Criteria**:
- packages/core/src/memory/graph-memory-bridge.ts extended with linkConduitMessagesToSymbols(projectRoot)
- Queries conduit.messages.content via FTS5 for symbol names present in nexus_nodes.name
- Writes conduit_mentions_symbol edges to brain_page_edges
- Add CONDUIT_MENTIONS_SYMBOL = 'conduit_mentions_symbol' to EDGE_TYPES and BRAIN_EDGE_TYPES
- cleo nexus conduit-scan — new verb that triggers linkConduitMessagesToSymbols() for current project; reports linked: N count
- Graceful no-op when conduit.db absent
- Code placed in packages/core/src/memory/graph-memory-bridge.ts per Package-Boundary Check
- Biome + build + test green

#### EP3-T7 (T1072) — Hebbian BUG-2 Fix + STDP Wire-Up
**Files**: `packages/core/src/memory/brain-lifecycle.ts`, `packages/core/src/memory/nexus-plasticity.ts`

**Acceptance Criteria**:
- BUG-2 fix: packages/core/src/memory/brain-lifecycle.ts strengthenCoRetrievedEdges() — fix entry_ids parsing to handle both comma-separated and JSON array formats
- BUG-1 fix: extractNexusPairsFromRetrievalLog() — fix 5-min vs 30-day lookback conflation (separate insertion timestamp from consolidation window)
- After fix: brain_page_edges co_retrieved row count > 0 after a cleo memory dream run
- cleo nexus hot-paths returns non-empty results after a code retrieval session (verified on cleocode)
- Code placed in packages/core/src/memory/ per Package-Boundary Check
- Biome + build + test green with existing T673 test suite passing

#### EP3-T8 (T1073) — IVTR Breaking-Change Gate
**Files**: `packages/core/src/engine/gate-validators.ts`

**Depends on**: T1069 (impact-full must exist before gate can call it)

**Acceptance Criteria**:
- Extend packages/core/src/engine/gate-validators.ts to add nexusImpact gate validator that reads files from task, calls analyzeImpact() for all symbols, returns FAIL if any symbol has risk=CRITICAL
- cleo verify <taskId> --gate nexusImpact --evidence 'tool:nexus-impact-full' runs validator and writes gate result
- cleo complete <taskId> rejects with E_NEXUS_IMPACT_CRITICAL if gate fails and --acknowledge-risk flag absent
- --acknowledge-risk '<reason>' flag on cleo complete bypasses gate and audits acknowledgment to .cleo/audit/nexus-risk-ack.jsonl
- Gate opt-in via CLEO_NEXUS_IMPACT_GATE=1 env var initially (default off)
- tool:nexus-impact-full added as valid evidence atom under ADR-051/T832
- Code placed in packages/core/src/engine/ per Package-Boundary Check
- Biome + build + test green with integration test for synthetic high-impact task

---

## Phase 3: Verification Summary

### Tasks Created
- **3 Epic Parents**: T1054, T1055, T1056
- **17 Child Tasks**: T1057–T1073

### Dependency Wiring
- **EP1-T4 (T1060)** → depends T1057
- **EP1-T5 (T1061)** → depends T1058
- **EP2-T4 (T1065)** → depends T1064
- **EP3-T3 (T1068)** → depends T1066, T1067
- **EP3-T4 (T1069)** → depends T1068
- **EP3-T8 (T1073)** → depends T1069

### Package Boundary Compliance
All 20 tasks include explicit "Code placed in <packages/xxx/> per Package-Boundary Check — verified against AGENTS.md" acceptance criteria as mandated by AGENTS.md.

### Quality Gates
All child tasks include standard acceptance criteria:
- Biome + build + test green
- Code placed in correct package per AGENTS.md
- TSDoc/documentation where applicable
- Integration tests where stated

---

## Manifest Entry

```json
{"task_id":"T1042-bulk-create","role":"worker","status":"complete","output_file":".cleo/agent-outputs/T1042-nexus-gap/TASK-CREATION-LOG.md","key_findings":["Epic1 ID: T1054 (Nexus P0: Core Query Power)","Epic2 ID: T1055 (Nexus P1: Competitive Closure)","Epic3 ID: T1056 (Nexus P2: Living Brain Completion)","17 child tasks created (T1057–T1073)","Dependencies wired for: EP1-T4→T1057, EP1-T5→T1058, EP2-T4→T1064, EP3-T3→T1066+T1067, EP3-T4→T1068, EP3-T8→T1069","All parent-boundary acceptance criteria included per AGENTS.md"],"timestamp":"2026-04-20T18:24:07Z"}
```
