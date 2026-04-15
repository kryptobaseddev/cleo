# T619 — NEXUS Studio View (sigma.js + WebGL)

**Date**: 2026-04-14
**Status**: complete

## What Was Built

### Dependencies Installed
- `sigma@3.0.2` — WebGL-accelerated graph renderer
- `graphology@0.26.0` — graph data structure
- `graphology-layout-forceatlas2@0.10.1` — force-directed layout

### API Endpoints (`src/routes/api/nexus/`)

| File | Route | Returns |
|------|-------|---------|
| `+server.ts` | `GET /api/nexus/communities` | [{id, name, size, color, topKind}] — all 254 communities |
| `community/[id]/+server.ts` | `GET /api/nexus/community/:id` | nodes + internal edges for community |
| `symbol/[name]/+server.ts` | `GET /api/nexus/symbol/:name` | 2-hop ego network around symbol |
| `search/+server.ts` | `GET /api/nexus/search?q=xxx` | up to 20 symbol matches |

All endpoints use `node:sqlite` read-only via existing `getNexusDb()` helper.

### Svelte Pages (`src/routes/nexus/`)

| File | Route | Description |
|------|-------|-------------|
| `+page.svelte` / `+page.server.ts` | `/nexus` | Macro view: 254 community nodes, cross-community edges, community card grid |
| `community/[id]/+page.svelte` / `+page.server.ts` | `/nexus/community/:id` | Drill-down: member nodes, internal edges, top-members table |
| `symbol/[name]/+page.svelte` / `+page.server.ts` | `/nexus/symbol/:name` | Ego network: amber center, blue hop-1, muted hop-2, legend, chip list |

### Graph Component (`src/lib/components/NexusGraph.svelte`)

- `onMount`: builds `graphology.Graph`, runs `forceAtlas2.assign` (sync), creates `Sigma` instance
- WebGL renderer via sigma defaults
- Hover tooltips showing label and kind
- Click-to-navigate via `goto(drillDownBase.replace(':id', node))`
- `onDestroy`: cleanup via `sigmaInstance.kill()`

## Quality Gate Results

| Gate | Result |
|------|--------|
| `pnpm biome ci` (new files only) | 6 files checked, no errors |
| `pnpm run build` | success |
| `pnpm run test` | 410 test files passed, 7420 tests passed, 0 new failures |
