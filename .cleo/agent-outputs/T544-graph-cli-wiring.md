# T544 — Graph Traversal CLI Commands Wired into Dispatch

**Date**: 2026-04-13
**Task**: T544
**Epic**: T542
**Status**: complete

## Summary

Investigated the wiring of `traceBrainGraph`, `relatedBrainNodes`, `contextBrainNode`, and `graphStats` functions from `packages/core/src/memory/graph-queries.ts` into the CLI dispatch layer.

## Findings

All four graph traversal commands were already fully wired across the entire dispatch stack. No code changes were required. The implementation was complete from prior work (T535/T523 epic).

### Full Wiring Verified

| Layer | Location | Status |
|-------|----------|--------|
| Core functions | `packages/core/src/memory/graph-queries.ts` | Present |
| Engine compat wrappers | `packages/core/src/memory/engine-compat.ts` | Present (`memoryGraphTrace`, `memoryGraphRelated`, `memoryGraphContext`, `memoryGraphStatsFull`) |
| Core internal exports | `packages/core/src/internal.ts` | Present (all 4 exported) |
| Engine re-exports | `packages/cleo/src/dispatch/engines/memory-engine.ts` | Present (all 4 re-exported) |
| Registry operations | `packages/cleo/src/dispatch/registry.ts` | Present (`memory.graph.trace`, `memory.graph.related`, `memory.graph.context`, `memory.graph.stats`) |
| Domain dispatch | `packages/cleo/src/dispatch/domains/memory.ts` | Present (all 4 case handlers) |
| CLI commands | `packages/cleo/src/cli/commands/memory-brain.ts` | Present (`trace`, `related`, `context`, `graph-stats`) |

### CLI Commands Available

```bash
# BFS traversal from seed node
cleo memory trace <nodeId> [--depth N] [--json]

# 1-hop neighbours with edge metadata
cleo memory related <nodeId> [--type <edgeType>] [--json]

# 360-degree context view
cleo memory context <nodeId> [--json]

# Aggregate node/edge counts
cleo memory graph-stats [--json]
```

### Manual Test Results

All four commands verified working via local compiled binary (`packages/cleo/dist/cli/index.js`):

**graph-stats**: Returns `{"success":true,"data":{"nodesByType":[...],"edgesByType":[...],"totalNodes":283,"totalEdges":229},...}`

**trace**: Returns BFS traversal nodes with depth annotation, LAFS envelope

**related**: Returns 1-hop neighbours with edge direction and weight, LAFS envelope

**context**: Returns node + inEdges + outEdges + neighbors, LAFS envelope

### Note on Installed Binary

The globally installed `cleo` binary (`~/.npm-global/bin/cleo`) points to the published npm package which predates this code. The compiled local build at `packages/cleo/dist/cli/index.js` includes all commands and works correctly. When published, the installed binary will pick up these commands automatically.

## Quality Gates

- `pnpm run build`: PASS
- `pnpm run test`: PASS (396 files, 7129 tests, 0 failures)
