# T554: Nexus Query Layer Fix

**Date**: 2026-04-13  
**Status**: complete  
**File changed**: `packages/cleo/src/cli/commands/nexus.ts`

## Root Cause

**File**: `packages/cleo/src/cli/commands/nexus.ts`

The `nexus context` and `nexus impact` commands filter nodes by name (`name LIKE '%<symbol>%'`) then take the first N results with `.slice(0, 5)` / `[0]`. The DB returns nodes in insertion order — file and folder nodes (kind `file`, `folder`) come first because they are indexed in the structural pass before symbol extraction. These structural nodes have **zero `calls` relations** (only `contains` relations), so callers/callees always return empty and impact BFS finds nothing.

`nexus clusters` was already working correctly (250 communities returned) — no fix needed there.

## What Changed

Added two new functions before `registerNexusCommand`:

1. **`NODE_KIND_PRIORITY`** — a priority map scoring each node kind. Callable symbols (function=0, method=1, class=3) score lower (higher priority) than structural nodes (file=40, folder=41).

2. **`sortMatchingNodes(nodes, symbolName)`** — sorts filtered nodes by kind priority, then by exact-name match within the same kind.

Applied `sortMatchingNodes()` in two places:
- `nexus context <symbol>` — before `.slice(0, 5)` (line ~822)
- `nexus impact <symbol>` — before taking `matchingNodes[0]` as the target (line ~1104)

Changed `const matchingNodes = allNodes.filter(...)` to `const rawMatchingNodes = ...` + `const matchingNodes = sortMatchingNodes(rawMatchingNodes, symbolName)` in both commands.

## Verification

```
node packages/cleo/dist/cli/index.js nexus context addTask --json
  -> matchCount: 3, symbol=addTask kind=function callers=10 callees=0

node packages/cleo/dist/cli/index.js nexus impact addTask --json
  -> targetName=addTask targetKind=function riskLevel=HIGH totalImpactedNodes=16
     depth=1 WILL BREAK (direct callers) nodes=10
     depth=2 LIKELY AFFECTED nodes=4
     depth=3 MAY NEED TESTING nodes=2

node packages/cleo/dist/cli/index.js nexus clusters --json
  -> count: 250
     label=Commands symbols=230 cohesion=0.892
     label=Sessions symbols=204 cohesion=0.915
     label=Engines symbols=171 cohesion=0.819
```

## Test Results

`pnpm dlx vitest run`: **396 passed, 0 failures**, 7135 tests, 10 skipped, 32 todo.

## What Was Not Changed

- Database path (`getNexusDb` → `~/.local/share/cleo/nexus.db`) was already correct.
- `nexus analyze` pipeline was not touched.
- DB schema was not changed.
- `nexus clusters` and `nexus flows` logic was not changed (communities were always returning correctly via Drizzle camelCase field access).
