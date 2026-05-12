# T1473 — nexus.ts Decomposition Plan

**Source file**: `packages/cleo/src/cli/commands/nexus.ts` (5366 LOC)  
**Target**: CLI < 500 LOC | New Core files under `packages/core/src/nexus/`  
**Author**: sonnet research worker | **Date**: 2026-04-26

---

## Section 1 — File Anatomy

Every `defineCommand` block classified by what the action body does.

| # | Command | LOC Range | Classification | Notes |
|---|---------|-----------|---------------|-------|
| 0 | (helpers) `generateGexf` | 73–222 | **Business logic** | GEXF XML builder — Core |
| 0 | (helpers) `escapeXml` | 227–238 | **Formatting** | Core-level utility |
| 0 | (helpers) `hexToRgb` | 243–252 | **Formatting** | Core-level utility |
| 0 | (helpers) `sortMatchingNodes` | 259–277 | **Business logic** | Ranking/sorting — Core |
| 0 | `NODE_KIND_PRIORITY` const | 28–61 | **Business logic** | Ranking config — Core |
| 1 | `init` | 282–287 | **Pure CLI** | dispatch only |
| 2 | `register` | 290–321 | **Pure CLI** | dispatch only |
| 3 | `unregister` | 324–342 | **Pure CLI** | dispatch only |
| 4 | `list` | 345–350 | **Pure CLI** | dispatch only |
| 5 | `status` | 353–458 | **Business logic + Formatting** | Direct DB access + LAFS shaping; bypass dispatch |
| 6 | `show` | 460–472 | **Pure CLI** | dispatch only |
| 7 | `resolve` | 475–496 | **Pure CLI** | dispatch only |
| 8 | `discover` | 499–531 | **Pure CLI** | dispatch only |
| 9 | `augment` | 542–574 | **Pure CLI** | dispatch only |
| 10 | `setup` | 584–610 | **Pure CLI** | calls `installNexusAugmentHook` from core |
| 11 | `search` | 613–644 | **Pure CLI** | dispatch only |
| 12 | `deps` | 647–672 | **Pure CLI** | dispatch only |
| 13 | `critical-path` | 675–683 | **Pure CLI** | dispatch only |
| 14 | `blocking` | 686–703 | **Pure CLI** | dispatch only |
| 15 | `orphans` | 707–711 | **Pure CLI** | dispatch only |
| 16 | `sync` | 715–737 | **Pure CLI** | dispatch only |
| 17 | `reconcile` | 740–761 | **Pure CLI** | dispatch only |
| 18 | `graph` | 764–769 | **Pure CLI** | dispatch only |
| 19 | `share-status` | 772–780 | **Pure CLI** | dispatch only |
| 20 | `transfer-preview` | 783–830 | **Pure CLI** | dispatch only |
| 21 | `transfer` | 833–888 | **Pure CLI** | dispatch only |
| 22 | `permission set` | 891–917 | **Pure CLI** | dispatch only |
| 23 | `permission` | 920–925 | **Pure CLI** | group only |
| 24 | `share export` | 928–945 | **Pure CLI** | dispatch only |
| 25 | `share import` | 948–966 | **Pure CLI** | dispatch only |
| 26 | `share` | 969–975 | **Pure CLI** | group only |
| 27 | `clusters` | 978–1110 | **Business logic + Formatting** | Direct DB scan; no dispatch path |
| 28 | `flows` | 1113–1241 | **Business logic + Formatting** | Direct DB scan; no dispatch path |
| 29 | `context` | 1242–1604 | **Business logic + Formatting** | Graph traversal (callers/callees/processes), source unfold; no dispatch path |
| 30 | `impact` | 1607–1930 | **Business logic + Formatting** | BFS upstream traversal, risk scoring; no dispatch path |
| 31 | `analyze` | 1933–2127 | **Business logic + Formatting** | Calls `runPipeline`, `refreshNexusBridge`, `nexusUpdateIndexStats`, `runGitLogTaskLinker`; needs thin wrapper |
| 32 | `projects list` | 2132–2199 | **Business logic + Formatting** | Calls `nexusList`; direct core call, no dispatch |
| 33 | `projects register` | 2202–2278 | **Business logic + Formatting** | Calls `nexusRegister`; direct core call |
| 34 | `projects remove` | 2281–2347 | **Business logic + Formatting** | Calls `nexusUnregister`; direct core call |
| 35 | `projects scan` | 2350–2656 | **Business logic + Formatting** | Filesystem walk + registry cross-ref + auto-register + audit log; entirely inline |
| 36 | `projects clean` | 2657–3012 | **Business logic + Formatting** | Regex filter + bulk DB delete + readline confirmation + audit log; entirely inline |
| 37 | `projects` | 3015–3026 | **Pure CLI** | group only |
| 38 | `refresh-bridge` | 3027–3105 | **Pure CLI** (thin) | calls `writeNexusBridge` from core |
| 39 | `export` | 3115–3223 | **Business logic + Formatting** | DB load + `generateGexf` call; GEXF generation is business logic |
| 40 | `diff` | 3235–3471 | **Business logic + Formatting** | git exec + pipeline run + count comparison + regression classifier; entirely inline |
| 41 | `query` | 3481–3559 | **Pure CLI** (thin) | delegates to `compileCteAlias`/`runNexusCte`/`formatCteResultAsMarkdown` in Core |
| 42 | `route-map` | 3564–3666 | **Pure CLI** (thin) | calls `getRouteMap` from Core |
| 43 | `shape-check` | 3671–3781 | **Pure CLI** (thin) | calls `shapeCheck` from Core |
| 44 | `full-context` | 3795–3896 | **Pure CLI** (thin) | calls `getLivingBrainContext` from Core |
| 45 | `task-footprint` | 3897–3971 | **Pure CLI** (thin) | calls `getTaskCodeImpact` from Core |
| 46 | `brain-anchors` | 3974–4044 | **Pure CLI** (thin) | calls `getBrainEntryCodeAnchors` from Core |
| 47 | `why` | 4051–4124 | **Pure CLI** (thin) | calls `reasonWhySymbol` from Core |
| 48 | `impact-full` | 4127–4208 | **Pure CLI** (thin) | calls `reasonImpactOfChange` from Core |
| 49 | `conduit-scan` | 4223–4290 | **Pure CLI** (thin) | calls `linkConduitMessagesToSymbols` from Core |
| 50 | `task-symbols` | 4304–4387 | **Pure CLI** (thin) | calls `getSymbolsForTask` from Core |
| 51 | `search-code` | 4402–4442 | **Pure CLI** | dispatch alias for `augment` |
| 52 | `contracts sync` | 4449–4553 | **Business logic + Formatting** | calls extractors directly inline |
| 53 | `contracts show` | 4556–4693 | **Business logic + Formatting** | calls extractors + `matchContracts` inline |
| 54 | `contracts link-tasks` | 4694–4775 | **Pure CLI** (thin) | calls Core linkage fn |
| 55 | `contracts` / `group` | 4776–4796 | **Pure CLI** | group aliases |
| 56 | `wiki` | 4799–4938 | **Business logic + Formatting** | resolves LOOM provider, calls `generateNexusWikiIndex`; LLM wiring is CLI concern |
| 57 | `hot-paths` | 4953–5022 | **Pure CLI** (thin) | calls `getHotPaths` from Core |
| 58 | `hot-nodes` | 5033–5101 | **Pure CLI** (thin) | calls `getHotNodes` from Core |
| 59 | `cold-symbols` | 5113–5188 | **Pure CLI** (thin) | calls `getColdSymbols` from Core |
| 60 | `sigil sync` | 5208–5223 | **Pure CLI** | dispatch only |
| 61 | `sigil list` | 5226–5247 | **Pure CLI** | dispatch only |
| 62 | `sigil` | 5250–5260 | **Pure CLI** | group only |
| 63 | `top-entries` | 5262–5295 | **Pure CLI** | dispatch only |
| 64 | `nexusCommand` | 5297–5366 | **Pure CLI** | root registration |

---

## Section 2 — Functions Extractable to Core

| Name | Source LOC | Action | Proposed Target Path | Contract Type Needed? |
|------|-----------|--------|----------------------|----------------------|
| `NODE_KIND_PRIORITY` | 28–61 | **MOVE** | `packages/core/src/nexus/symbol-ranking.ts` | No (internal constant) |
| `generateGexf` | 73–222 | **MOVE** | `packages/core/src/nexus/gexf-export.ts` | Yes — `GexfExportInput` (nodes[], relations[]) |
| `escapeXml` | 227–238 | **MOVE** | `packages/core/src/nexus/gexf-export.ts` (same file) | No (internal util) |
| `hexToRgb` | 243–252 | **MOVE** | `packages/core/src/nexus/gexf-export.ts` (same file) | No (internal util) |
| `sortMatchingNodes` | 259–277 | **MOVE** | `packages/core/src/nexus/symbol-ranking.ts` | No (internal util) |
| `status` action body (DB query + stats shaping) | 374–458 | **MOVE** | `packages/core/src/nexus/status.ts` → `getProjectStatus(projectId, repoPath)` | Yes — `NexusStatusResult` |
| `clusters` action body (DB filter + community shaping) | 998–1110 | **MOVE** | `packages/core/src/nexus/clusters.ts` → `getProjectClusters(projectId, repoPath)` | Yes — `NexusClustersResult` |
| `flows` action body (DB filter + process shaping) | 1133–1241 | **MOVE** | `packages/core/src/nexus/flows.ts` → `getProjectFlows(projectId, repoPath)` | Yes — `NexusFlowsResult` |
| `context` action body (node lookup + caller/callee traversal + source unfold) | 1272–1603 | **MOVE** | `packages/core/src/nexus/context.ts` → `getSymbolContext(symbolName, projectId, repoPath, opts)` | Yes — `NexusContextResult` (already partially exists via dispatch) |
| `impact` action body (BFS traversal + risk scoring) | 1641–1930 | **MOVE** | `packages/core/src/nexus/impact.ts` → `getSymbolImpact(symbolName, projectId, repoPath, opts)` | Yes — `NexusImpactResult` (already partially exists via dispatch) |
| `analyze` action body (pipeline orchestration: clear, runPipeline, refreshBridge, nexusUpdateIndexStats, runGitLogTaskLinker) | 1957–2126 | **MOVE** | `packages/core/src/nexus/analyze.ts` → `runAnalyze(repoPath, opts)` | Yes — `NexusAnalyzeResult` |
| `projects scan` filesystem walker (`walkForCleo`, `getDevice`, registry cross-ref logic) | 2379–2660 | **MOVE** | `packages/core/src/nexus/projects-scan.ts` → `scanForProjects(roots, opts)` | Yes — `ProjectsScanResult` |
| `projects clean` (filter + bulk delete + audit) | 2697–3012 | **MOVE** | `packages/core/src/nexus/projects-clean.ts` → `cleanProjects(opts)` | Yes — `ProjectsCleanResult` |
| `export` action body (DB load + format dispatch) | 3132–3222 | **MOVE** (partially) | `generateGexf` already moves; add `exportGraph(projectId, format)` to `packages/core/src/nexus/gexf-export.ts` | Yes — `NexusExportResult` |
| `diff` action body (git exec + incremental pipeline + count comparison + regression classifier) | 3264–3471 | **MOVE** | `packages/core/src/nexus/diff.ts` → `diffNexusIndex(repoPath, beforeRef, afterRef, opts)` | Yes — `NexusDiffResult` |
| `contracts sync` action body (parallel extractor calls + count aggregation) | 4469–4553 | **MOVE** (already uses Core extractors; add orchestration fn) | `packages/core/src/nexus/api-extractors/contracts-sync.ts` → `syncContracts(projectId, repoPath)` | Yes — `ContractsSyncResult` |
| `contracts show` action body (extractor calls + matcher + matrix rendering logic) | 4577–4693 | **MOVE** (logic part) | `packages/core/src/nexus/api-extractors/contracts-show.ts` → `showContracts(projectA, projectB, repoPath)` | Yes — `ContractsShowResult` |
| `wiki` LLM wiring (`resolveLlmBackend` + `ai` generateText) | 4836–4864 | **KEEP** in CLI — it's a CLI-level provider resolution | N/A | No |

**Functions to KEEP in CLI**:
- All `defineCommand` scaffolding (args declaration, `run()` dispatch delegation)
- `wiki` LLM backend wiring (CLI concern: LOOM backend resolver)
- All `process.stdout.write` / `process.stderr.write` formatting blocks (move formatting to separate render fns within each command, not Core)

---

## Section 3 — Dispatch Additions

| Core Function | Existing Dispatch Op | Action |
|--------------|---------------------|--------|
| `getProjectStatus` | `nexus.status` — already exists in dispatch domain (line 452 has dispatch fallback) | Route `status` command fully through dispatch; move DB logic to Core handler |
| `getProjectClusters` | None | Add new op `nexus.clusters` to dispatch; becomes new contract op |
| `getProjectFlows` | None | Add new op `nexus.flows` to dispatch; becomes new contract op |
| `getSymbolContext` | None (bypasses dispatch) | Add new op `nexus.context` to dispatch; Core fn already nearly complete |
| `getSymbolImpact` | None (bypasses dispatch) | Add new op `nexus.impact` to dispatch; Core fn already nearly complete |
| `runAnalyze` | None (bypasses dispatch with explicit comment at line 1–12) | Keep as direct Core call — comment explains coupling rationale; NOT dispatched |
| `scanForProjects` | None | Add new op `nexus.projects.scan` to dispatch |
| `cleanProjects` | None | Add new op `nexus.projects.clean` to dispatch |
| `exportGraph` | None | Add new op `nexus.export` to dispatch |
| `diffNexusIndex` | None | Add new op `nexus.diff` to dispatch |
| `syncContracts` | None | Add new op `nexus.contracts.sync` to dispatch |
| `showContracts` | None | Add new op `nexus.contracts.show` to dispatch |

**Ops that bypass dispatch with good reason**: `analyze` (requires `@cleocode/nexus` pipeline + DB together — acknowledged in file header). Keep as direct Core call.

---

## Section 4 — Decomposition Target

### Final CLI file
`packages/cleo/src/cli/commands/nexus.ts` → **~400 LOC**

All `defineCommand` blocks remain. Each `run()` body reduced to: parse flags → call dispatch or thin Core fn → render LAFS envelope. No DB access, no traversal, no filesystem walking in CLI.

### New Core files

| File | Est. LOC | Contents |
|------|---------|---------|
| `packages/core/src/nexus/symbol-ranking.ts` | ~60 | `NODE_KIND_PRIORITY`, `sortMatchingNodes` |
| `packages/core/src/nexus/gexf-export.ts` | ~200 | `generateGexf`, `escapeXml`, `hexToRgb`, `exportGraph` |
| `packages/core/src/nexus/status.ts` | ~100 | `getProjectStatus` (DB query + stats shaping) |
| `packages/core/src/nexus/clusters.ts` | ~80 | `getProjectClusters` (DB filter + community shaping) |
| `packages/core/src/nexus/flows.ts` | ~80 | `getProjectFlows` (DB filter + process shaping) |
| `packages/core/src/nexus/context.ts` | ~250 | `getSymbolContext` (caller/callee/process traversal + source unfold) |
| `packages/core/src/nexus/impact.ts` | ~180 | `getSymbolImpact` (BFS traversal + risk scoring) |
| `packages/core/src/nexus/analyze.ts` | ~120 | `runAnalyze` (pipeline orchestration wrapper) |
| `packages/core/src/nexus/diff.ts` | ~180 | `diffNexusIndex` (git exec + count delta + regression classifier) |
| `packages/core/src/nexus/projects-scan.ts` | ~150 | `scanForProjects`, `walkForCleo`, `getDevice` |
| `packages/core/src/nexus/projects-clean.ts` | ~120 | `cleanProjects` (filter + bulk delete + audit) |
| `packages/core/src/nexus/api-extractors/contracts-sync.ts` | ~60 | `syncContracts` orchestration |
| `packages/core/src/nexus/api-extractors/contracts-show.ts` | ~80 | `showContracts` with `matchContracts` logic |

**Total new Core LOC**: ~1,660 (moving out of CLI, not duplicating)

### Contract additions needed
File: `packages/contracts/src/operations/nexus.ts`

Add types:
- `NexusStatusResult`, `NexusClustersResult`, `NexusFlowsResult`
- `NexusContextResult`, `NexusImpactResult`, `NexusAnalyzeResult`
- `NexusDiffResult`, `NexusExportResult`
- `ProjectsScanResult`, `ProjectsCleanResult`
- `ContractsSyncResult`, `ContractsShowResult`

### Test reorganization
- New Core fns get unit tests at `packages/core/src/nexus/__tests__/`
- Priority: `symbol-ranking`, `gexf-export`, `impact`, `context` (pure functions, easy to unit test)
- `analyze`, `diff` require integration test fixtures (minimal git repo)

---

## Section 5 — Risks and Mitigations

### R1 — CLI-only state coupling in business logic

| Location | Coupling | Mitigation |
|----------|---------|-----------|
| `status` (353–458) | `process.cwd()`, `process.stdout.write` | Extract DB logic to `getProjectStatus()`; CLI renders result |
| `clusters` / `flows` (978–1241) | `process.stdout.write` inline | Extract query to Core; CLI renders table |
| `context` / `impact` (1242–1930) | `process.cwd()`, inline write | Extract traversal to Core; return plain data; CLI renders |
| `analyze` (1957–2126) | `process.stderr.write` progress callback | Progress callback is already a parameter to `runPipeline`; pass `undefined` from Core fn, wire only from CLI |
| `projects scan` (2350–2656) | `process.stdout.write`, `readline` (via projects clean) | Extract walker to Core as pure function; CLI handles readline confirmation |
| `projects clean` (2657–3012) | `readline.createInterface` for confirmation prompt | Confirmation is CLI concern; Core `cleanProjects` takes `dryRun: boolean` only, no stdin |
| `diff` (3235–3471) | `process.stderr.write` progress | Move business logic (git exec, count delta) to Core; CLI renders |

### R2 — Dispatch bypass patterns

Three commands explicitly bypass dispatch for acknowledged reasons:
1. `analyze` — comment at line 1–12 explains: requires both `@cleocode/nexus` pipeline and `@cleocode/core` DB together; routing through dispatch would create awkward coupling. **Accepted; keep as direct Core call.**
2. `context` and `impact` — no comment explains bypass. These load DB directly inline. **Must route through dispatch after extraction** to restore parity with other transport layers (TUI, agents).
3. `clusters`, `flows` — direct DB reads not in dispatch. **Add dispatch ops.**

### R3 — T1042 parity overlap (gitnexus-vs-cleo nexus)

`packages/cleo/src/cli/commands/nexus.ts` header references `@epic T1042`. Commands `augment` (542), `setup` (584), `search-code` (4402), `task-symbols` (4304), `conduit-scan` (4223) all carry `@epic T1042` tags. These commands are thin wrappers to Core functions already extracted (`augment.ts`, `tasks-bridge.ts`, `graph-memory-bridge.ts`). **No decomposition risk** — they are already pure-CLI.

The graph traversal commands (`context`, `impact`) are the ones T1042 parity testing exercises. Moving them to Core and routing through dispatch **must not change the LAFS envelope shape** emitted by `dispatchFromCli`. Backward-compat: existing envelope keys (`impactByDepth`, `callers`, `callees`, `processes`, `riskLevel`) must be preserved exactly.

### R4 — `projects scan` nested function definitions

`walkForCleo` and `getDevice` (lines 2445–2499) are defined as nested `function` declarations inside the `run()` body. They will need to be hoisted to module scope in the new Core file. No functional risk; just restructuring.

### R5 — `projects clean` interactive readline

`readline.createInterface` is used at line 2911 for a confirmation prompt. This is CLI-only state. The `cleanProjects` Core function must accept `{ dryRun: boolean; skipPrompt: boolean }` and return a dry-run-safe result. The CLI layer handles the `readline` prompt before calling `cleanProjects`.
