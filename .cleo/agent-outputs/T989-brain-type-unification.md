# T989 — Unify BrainNode / BrainEdge types (single canonical shape)

**Status**: complete
**Date**: 2026-04-20

## Summary

Unified three duplicate definitions of `BrainNode`, `BrainEdge`, `BrainGraph` into a
single canonical source at `packages/contracts/src/brain-graph.ts`.

## Canonical Location

`packages/contracts/src/brain-graph.ts` — new file, 230 lines

Exports:
- `BrainNode` — unified runtime node shape
- `BrainEdge` — unified runtime edge shape
- `BrainGraph` — unified graph response
- `BrainNodeKind` — node kind union
- `BrainSubstrate` — substrate name union
- `BrainQueryOptions` — query parameter bag (references `BrainProjectContext`)
- `BrainProjectContext` — minimal project context interface (replaces the
  forward-import of `./project-context.js` that would have created a circular dep)
- `BrainStreamEvent` — SSE event union
- `BrainConnectionStatus` — SSE connection state

All types are exported from `packages/contracts/src/index.ts` under the
`=== Brain Unified-Graph Types ===` section.

## Duplicates Deleted / Replaced

| File | Before | After |
|------|--------|-------|
| `packages/brain/src/types.ts` | Defined all 8 types (230 lines) | Re-exports from `@cleocode/contracts` (35 lines) |
| `packages/contracts/src/operations/brain.ts` | Defined `BrainNode`, `BrainEdge`, `BrainStreamEvent` | Renamed to `BrainNodeWire`, `BrainEdgeWire`, `BrainStreamEventWire` (wire-format only) |
| `packages/studio/src/routes/api/memory/graph/+server.ts` | Defined `BrainNode`, `BrainEdge` (raw DB row types) | Renamed to `MemoryGraphNode`, `MemoryGraphEdge` |

## Wire-Format Types (operations/brain.ts)

The `operations/brain.ts` contracts use a structurally different shape
(`from`/`to`/`kind` vs `source`/`target`/`type`, `data` vs `meta`, etc.).
These are wire-format only, not used by any runtime consumer. Renamed with
`Wire` suffix to prevent collision:
- `BrainNode` → `BrainNodeWire`
- `BrainEdge` → `BrainEdgeWire`
- `BrainStreamEvent` → `BrainStreamEventWire`

All `BrainNodeResult`, `BrainQueryResult`, `BrainSubstrateResult`,
`BrainNeighborhoodNode`, `BrainBridgesResult`, `BrainSearchHit` result
interfaces updated to use the `Wire` suffix types.

## Consumers Updated

- `packages/brain/src/types.ts` — now re-exports from `@cleocode/contracts`
- `packages/brain/src/index.ts` — added `BrainProjectContext` to exports
- `packages/contracts/src/index.ts` — added canonical types export block
- `packages/studio/src/routes/api/memory/graph/+server.ts` — local types renamed

All other consumers (`packages/brain/src/adapters/*`, `packages/studio/src/lib/*`,
`packages/studio/src/routes/api/brain/*`) continue to import from `@cleocode/brain`
which re-exports the canonical types — no import path changes required.

## Build Results

| Package | Build | Tests |
|---------|-------|-------|
| `@cleocode/contracts` | green | n/a |
| `@cleocode/brain` | green | 69/69 passed |
| `@cleocode/core` | pre-existing errors (T944 WIP) | n/a |
| `@cleocode/studio` | pre-existing errors (svelte module issues) | n/a |

Core and studio build errors are pre-existing (confirmed via git stash test) and
unrelated to T989.

## LBNode Remnants

Zero. T973 previously renamed all `LB*` types to `Brain*`.

## Gate Verification

```
grep -rnE "^(export )?(interface|type) (BrainNode|BrainEdge|BrainGraph) " packages/ --include="*.ts" | grep -v ".d.ts"
# Result: 3 lines, all in packages/contracts/src/brain-graph.ts ✓

grep -rn "LBNode|LBEdge|LBGraph" packages/ --include="*.ts" | grep -v ".d.ts"
# Result: empty ✓
```
