# T648 — NexusGraph 'Cluster ###' Label Fix + Drill-Down Connection Preservation

**Status**: complete
**Date**: 2026-04-15

## Changes Made

### 1. `packages/studio/src/lib/components/sigma-defaults.ts` (new)

Shared Sigma 3 renderer configuration extracted to a helper so NexusGraph
and LivingBrainGraph use identical settings. Exports:
- `BASE_SIGMA_SETTINGS` — spread into any `new Sigma(graph, container, {...})` call
- `ARROW_EDGE_TYPE` and `LINE_EDGE_TYPE` — string constants

### 2. `packages/studio/src/routes/nexus/+page.server.ts`

**Root cause of 'Cluster ###' bug**: the label was constructed with
`` `Cluster ${row.community_id.replace('comm_', '')}` `` — ignoring the
`heuristicLabel` stored in `nexus_nodes.label` by the community-processor.

**Fix**: added a correlated sub-query to fetch `cn.label` from the
community node row. Label derivation priority:
1. `nexus_nodes.label` for the community node (e.g. "Engines", "Pipeline")
2. Fallback: `Cluster N`

Final label format: `"Engines (45)"` — name + member count.

### 3. `packages/studio/src/routes/nexus/community/[id]/+page.server.ts`

Added:
- `CommunitySummary` interface (id, label, memberCount, topKind)
- Extra queries to fetch `communityLabel` and `topKind` from the DB
- Returns `communityLabel`, `summary` alongside existing data

### 4. `packages/studio/src/routes/nexus/community/[id]/+page.svelte`

- Uses `data.communityLabel` in breadcrumb and page title (no more `comm_3`)
- Added **context strip**: horizontal card row showing Community name,
  Symbols count, Internal edges count, Top kind, and a "Back to NEXUS" link
- Edge count now displayed in subtitle

### 5. `packages/studio/src/routes/nexus/symbol/[name]/+page.svelte`

- Breadcrumb still shows community link (uses `comm_N` → `Cluster N` fallback
  since symbol server does not fetch community label; sufficient for navigation)
- Added **context strip**: Callers count, Callees count, Hop-2 count,
  Edges visible, back link to parent community
- Split direct connections into **Callers** and **Callees** sections
  (color-coded chips: amber border = caller, blue border = callee)
- Added edge-direction legend item in the legend bar

### 6. `packages/studio/src/lib/components/NexusGraph.svelte`

- Imports `BASE_SIGMA_SETTINGS` from sigma-defaults
- Spreads `BASE_SIGMA_SETTINGS` into `new Sigma(...)` constructor
- Edge attributes now set `type: 'arrow'` explicitly (was `edgeCategory` custom
  attr that sigma ignored). Sigma 3 ships `arrow` in default `edgeProgramClasses`
  so no extra registration is needed
- Added `enterEdge` / `leaveEdge` event handlers so hovering an edge shows
  `source → target` relationship in the tooltip

## Quality Gates

- `pnpm biome check packages/studio` — 0 issues
- `pnpm --filter @cleocode/studio run build` — green (1.89s)
- `pnpm --filter @cleocode/studio run test` — 69/69 passed

## Acceptance Criteria Verification

| Criterion | Result |
|-----------|--------|
| Macro view shows real community labels not 'Cluster ###' | Fixed via DB sub-query for community node label |
| Drill-down keeps a breadcrumb back-link | Both community and symbol pages have breadcrumb + context strip with back link |
| Drill-down shows callers + callees as visible lines | Edges now set `type: 'arrow'` (sigma attribute), not `edgeCategory` (ignored custom attr) |
| Hovering an edge shows source→target relationship | `enterEdge` handler added; tooltip shows `source → target` |
| Build green | Confirmed |
