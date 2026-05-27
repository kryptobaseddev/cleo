# T535 — Brain Graph Traversal CLI Commands

**Task**: Wave F-1: Brain graph traversal CLI commands
**Status**: complete
**Date**: 2026-04-12

## Summary

Implemented four new `cleo memory` commands for traversing the brain knowledge graph
(populated by T528+T530: 281 nodes, 228 edges). All commands use LAFS envelope output,
follow existing memory command patterns, and pass through the dispatch layer.

## Files Created / Modified

### New
- `packages/core/src/memory/graph-queries.ts` — core query functions using native SQLite for recursive CTEs

### Modified
- `packages/core/src/memory/engine-compat.ts` — added 4 new engine functions
- `packages/core/src/internal.ts` — exported new functions + types
- `packages/cleo/src/dispatch/engines/memory-engine.ts` — re-exported from core
- `packages/cleo/src/dispatch/lib/engine.ts` — barrel export
- `packages/cleo/src/dispatch/domains/memory.ts` — dispatch cases + getSupportedOperations
- `packages/cleo/src/dispatch/registry.ts` — 4 new OPERATIONS entries
- `packages/cleo/src/cli/commands/memory-brain.ts` — 4 new CLI subcommands
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — updated operation counts (133→137 query, 232→236 total)

## Commands Implemented

### `cleo memory graph-stats`
Returns node and edge counts by type.
```json
{
  "success": true,
  "data": {
    "nodesByType": [
      {"nodeType": "task", "count": 112},
      {"nodeType": "pattern", "count": 111},
      {"nodeType": "observation", "count": 43},
      {"nodeType": "sticky", "count": 7},
      {"nodeType": "learning", "count": 5},
      {"nodeType": "session", "count": 2},
      {"nodeType": "decision", "count": 1}
    ],
    "edgesByType": [
      {"edgeType": "applies_to", "count": 119},
      {"edgeType": "derived_from", "count": 107},
      {"edgeType": "produced_by", "count": 2}
    ],
    "totalNodes": 281,
    "totalEdges": 228
  },
  "meta": {"operation": "memory.graph.stats", "timestamp": "..."}
}
```

### `cleo memory trace <nodeId> [--depth N]`
BFS traversal via recursive CTE, bidirectional, cycle-safe.
```json
{
  "success": true,
  "data": {
    "nodes": [
      {"id": "observation:O-mndnelcq-0", "depth": 0, "nodeType": "observation", ...},
      {"id": "task:T191", "depth": 1, "nodeType": "task", ...},
      {"id": "task:T192", "depth": 1, "nodeType": "task", ...},
      {"id": "task:T201", "depth": 1, "nodeType": "task", ...},
      {"id": "pattern:P-1024821a", "depth": 2, "nodeType": "pattern", ...},
      {"id": "pattern:P-32746e4c", "depth": 2, "nodeType": "pattern", ...}
    ],
    "total": 6,
    "seed": "observation:O-mndnelcq-0"
  }
}
```

### `cleo memory related <nodeId> [--type <edgeType>]`
1-hop neighbours with edge type, direction, and weight.
```json
{
  "success": true,
  "data": {
    "related": [
      {"node": {"id": "task:T191", ...}, "edgeType": "applies_to", "direction": "out", "weight": 1},
      {"node": {"id": "task:T192", ...}, "edgeType": "applies_to", "direction": "out", "weight": 1},
      {"node": {"id": "task:T201", ...}, "edgeType": "applies_to", "direction": "out", "weight": 1}
    ],
    "total": 3,
    "seed": "observation:O-mndnelcq-0"
  }
}
```

### `cleo memory context <nodeId>`
360-degree view: node + in-edges + out-edges + deduplicated neighbours.
```json
{
  "success": true,
  "data": {
    "node": {"id": "observation:O-mndnelcq-0", "nodeType": "observation", ...},
    "inEdges": [],
    "outEdges": [
      {"fromId": "observation:O-mndnelcq-0", "toId": "task:T191", "edgeType": "applies_to", ...}
    ],
    "neighbors": [
      {"node": {"id": "task:T191", ...}, "edgeType": "applies_to", "direction": "out", "weight": 1}
    ]
  }
}
```

## Dispatch Operations Added

| Operation | Gateway | Domain | requiredParams |
|-----------|---------|--------|----------------|
| `graph.trace` | query | memory | `nodeId` |
| `graph.related` | query | memory | `nodeId` |
| `graph.context` | query | memory | `nodeId` |
| `graph.stats` | query | memory | (none) |

## Quality Gates

- `pnpm biome check --write` — clean
- `pnpm run build` — clean (core + cleo packages)
- `pnpm run test` — 7043 passed, 1 pre-existing failure (nexus.test.ts from T534 working-tree, unrelated to T535)
- Manual test — all 4 commands verified against live brain.db (281 nodes, 228 edges)
