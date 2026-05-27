# T1488 Decomp Plan — nexus.ts Bypass Routing

**Date**: 2026-04-27  
**File**: `packages/cleo/src/cli/commands/nexus.ts`  
**Current LOC**: 4084  
**Target**: <500  

## Phase 1 Audit Results

### Top-level imports from `@cleocode/core/nexus` (bypass)

| Import | Used by | Dispatch op? | Action |
|--------|---------|-------------|--------|
| `cleanProjects` | `projectsCleanCommand` | None | SSoT-EXEMPT + new op needed |
| `diffNexusIndex` | `diffCommand` | None | SSoT-EXEMPT + new op needed |
| `generateGexf` | `exportCommand` | None | SSoT-EXEMPT + new op needed |
| `getProjectClusters` | `clustersCommand` | None | SSoT-EXEMPT + new op needed |
| `getProjectFlows` | `flowsCommand` | None | SSoT-EXEMPT + new op needed |
| `getSymbolContext` | `contextCommand` | None | SSoT-EXEMPT + new op needed |
| `getSymbolImpact` | `impactCommand` | `impact` EXISTS | Convert to `dispatchRaw` |
| `InvalidPatternError` | `projectsCleanCommand` | n/a (error class) | SSoT-EXEMPT (type import) |
| `NoCriteriaError` | `projectsCleanCommand` | n/a (error class) | SSoT-EXEMPT (type import) |
| `scanForProjects` | `projectsScanCommand` | None | SSoT-EXEMPT + new op needed |

### Dynamic imports (inline business logic)

#### Commands with dispatch ops already — Phase 1A (convert to dispatchRaw)

| Command | Lines | Import | Dispatch op | Status |
|---------|-------|--------|-------------|--------|
| `impactCommand` | 1054-1165 | `getSymbolImpact` | `impact` | CONVERT |
| `fullContextCommand` | 2530-2612 | `@cleocode/core/nexus/living-brain.js` | `full-context` | CONVERT |
| `taskFootprintCommand` | 2632-2689 | `@cleocode/core/nexus/living-brain.js` | `task-footprint` | CONVERT |
| `brainAnchorsCommand` | 2709-2762 | `@cleocode/core/nexus/living-brain.js` | `brain-anchors` | CONVERT |
| `whyCommand` | 2786-2842 | `@cleocode/core/memory/brain-reasoning.js` | `why` | CONVERT |
| `impactFullCommand` | 2862-2926 | `@cleocode/core/nexus/living-brain.js` | `impact-full` | CONVERT |
| `conduitScanCommand` | 2953-3008 | `@cleocode/core/memory/graph-memory-bridge.js` | `conduit-scan` | CONVERT |
| `taskSymbolsCommand` | 3038-3105 | `@cleocode/core/nexus/tasks-bridge.js` | `task-symbols` | CONVERT |
| `routeMapCommand` | 2282-2384 | `@cleocode/core/nexus/route-analysis.js` | `route-map` | CONVERT |
| `shapeCheckCommand` | 2389-2499 | `@cleocode/core/nexus/route-analysis.js` | `shape-check` | CONVERT |
| `wikiCommand` | 3516-3656 | `@cleocode/core/nexus/wiki-index.js` + LOOM | `wiki` | PARTIAL: LOOM SSoT-EXEMPT |
| `contractsSyncCommand` | 3167-3271 | `api-extractors/*` | `contracts-sync` | CONVERT |
| `contractsShowCommand` | 3273-3409 | `api-extractors/*` | `contracts-show` | CONVERT |
| `contractsLinkTasksCommand` | 3411-3491 | `@cleocode/core/nexus/tasks-bridge.js` | `contracts-link-tasks` | CONVERT |
| `queryCommand` | 2199-2277 | `@cleocode/core/nexus/query-dsl.js` | None | NEEDS NEW OP |
| `hotPathsCommand` | 3671-3740 | `@cleocode/core/internal` (getHotPaths) | None | NEEDS NEW OP |
| `hotNodesCommand` | 3751-3819 | `@cleocode/core/internal` (getHotNodes) | None | NEEDS NEW OP |
| `coldSymbolsCommand` | 3831-3906 | `@cleocode/core/internal` (getColdSymbols) | None | NEEDS NEW OP |

#### Commands requiring new dispatch ops — Phase 1B (SSoT-EXEMPT or new ops)

| Command | Lines | Import | Reason |
|---------|-------|--------|--------|
| `statusCommand` | 126-208 | `nexus-sqlite`, `pipeline` | Complex: `getIndexStats` + fallback to registry status |
| `analyzeCommand` | 1192-1362 | `nexus-sqlite`, `pipeline`, `core/nexus` | Complex: progress callbacks + pipeline wiring (CLI-SIDE-CONCERN) |
| `clustersCommand` | 750-814 | `getProjectClusters` | Needs new `clusters` dispatch op |
| `flowsCommand` | 834-898 | `getProjectFlows` | Needs new `flows` dispatch op |
| `contextCommand` | 917-1035 | `getSymbolContext` | Needs new `context` dispatch op |
| `projectsListCommand` | 1378-1434 | `nexusList` from internal | Needs new `projects.list` dispatch op |
| `projectsRegisterCommand` | 1457-1513 | `nexusRegister` from internal | Needs new `projects.register` dispatch op |
| `projectsRemoveCommand` | 1532-1582 | `nexusUnregister` from internal | Needs new `projects.remove` dispatch op |
| `projectsScanCommand` | 1611-1689 | `scanForProjects` | Needs new `projects.scan` dispatch op |
| `projectsCleanCommand` | 1732-1882 | `cleanProjects` + error classes | Needs new `projects.clean` dispatch op |
| `refreshBridgeCommand` | 1918-1975 | `writeNexusBridge` from internal | Needs new `refresh-bridge` dispatch op |
| `exportCommand` | 2002-2093 | `getNexusDb`, `nexusSchema`, `generateGexf` | Complex gexf serialization (CLI-SIDE-CONCERN) |
| `diffCommand` | 2099-2189 | `diffNexusIndex` | Needs new `diff` dispatch op |
| `setupCommand` | 336-362 | `installNexusAugmentHook` | CLI-side install, SSoT-EXEMPT |

## Phase 2 Plan (new dispatch ops)

### New ops to add

For each: contracts param/result type → engine function → dispatch handler → ops.ts entry → QUERY_OPS/MUTATE_OPS registration

| Op | Params | Result | Engine fn | Priority |
|----|--------|--------|-----------|---------|
| `clusters` | `{projectId?, path?}` | `NexusClustersResult` | `nexusClusters()` | HIGH |
| `flows` | `{projectId?, path?}` | `NexusFlowsResult` | `nexusFlows()` | HIGH |
| `context` | `{symbol, projectId?, limit?, content?}` | `NexusContextResult` | `nexusContext()` | HIGH |
| `diff` | `{beforeRef?, afterRef?, path?, projectId?}` | `NexusDiffResult` | `nexusDiff()` | MEDIUM |
| `projects.list` | `{}` | project list | `nexusProjectsList()` | MEDIUM |
| `projects.register` | `{path, name?}` | `{hash, path}` | `nexusProjectsRegister()` | MEDIUM |
| `projects.remove` | `{nameOrHash}` | `{removed}` | `nexusProjectsRemove()` | MEDIUM |
| `projects.scan` | scan opts | `ProjectsScanResult` | `nexusProjectsScan()` | LOW |
| `projects.clean` | clean opts | `CleanProjectsResult` | `nexusProjectsClean()` | LOW |
| `refresh-bridge` | `{path?, projectId?}` | `{path, written}` | `nexusRefreshBridge()` | LOW |
| `hot-paths` | `{limit?}` | hot paths result | `nexusHotPaths()` | LOW |
| `hot-nodes` | `{limit?}` | hot nodes result | `nexusHotNodes()` | LOW |
| `cold-symbols` | `{days?}` | cold symbols result | `nexusColdSymbols()` | LOW |
| `query-cte` | `{cte, params?}` | CTE result | `nexusQueryCte()` | LOW |

## SSoT-EXEMPT Annotations (CLI-side concerns)

These remain in the CLI with `// SSoT-EXEMPT:<reason>` annotations:

| Location | Reason |
|----------|--------|
| `analyzeCommand` progress callback (line ~1258) | `// SSoT-EXEMPT:progress-callback — pipeline progress reporting is CLI-only rendering concern, cannot be routed through dispatch` |
| `wikiCommand` LOOM provider wiring (line ~3554) | `// SSoT-EXEMPT:loom-provider — LLM backend resolution for wiki generation requires CLI-side async provider wiring` |
| `projectsCleanCommand` readline prompt (line ~1803) | `// SSoT-EXEMPT:interactive-prompt — confirmation prompt requires CLI-side stdin interaction` |
| `exportCommand` GEXF serialization | `// SSoT-EXEMPT:file-serialization — GEXF export writes raw bytes to stdout/file, not a LAFS envelope op` |
| `setupCommand` hook install | `// SSoT-EXEMPT:cli-install — installs filesystem hook, not a domain operation` |

## Current Phase 1A Implementation

Converting 14 commands to use `dispatchRaw` + existing render logic.
This removes the inline `@cleocode/core` imports from these command bodies.
