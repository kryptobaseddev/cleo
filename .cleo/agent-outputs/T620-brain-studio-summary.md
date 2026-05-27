# T620 — BRAIN Studio View: Knowledge Graph + Decisions Timeline

**Status**: complete
**Date**: 2026-04-15

## Summary

Built the complete BRAIN Studio view in `packages/studio/` — 5 pages + 4 API endpoints + 1 Svelte component backed by real `brain.db` data.

## Files Created

### API Endpoints (`src/routes/api/brain/`)
- `graph/+server.ts` — GET `/api/brain/graph` → `{nodes[], edges[], total_nodes, total_edges}`. Returns up to 500 highest-quality `brain_page_nodes` + edges with both endpoints in set.
- `decisions/+server.ts` — GET `/api/brain/decisions` → `{decisions[], total}`. All decisions chronologically.
- `observations/+server.ts` — GET `/api/brain/observations?tier=&type=&min_quality=` → filtered observations (up to 200).
- `quality/+server.ts` — GET `/api/brain/quality` → quality bucket histograms + tier/type distributions across all 4 brain tables.

### Svelte Pages
- `src/routes/brain/+page.svelte` — Dashboard: 8 stat cards, node type distribution, memory tier distribution, recent activity, navigation to sub-views.
- `src/routes/brain/+page.server.ts` — Server load: stats, recentNodes, nodeTypeCounts, tierCounts.
- `src/routes/brain/graph/+page.svelte` — Force-directed graph view with time slider, legend.
- `src/routes/brain/decisions/+page.svelte` — Timeline view, expandable detail, confidence badges.
- `src/routes/brain/observations/+page.svelte` — Filterable list (tier/type/quality/text search), quality bar.
- `src/routes/brain/quality/+page.svelte` — Horizontal bar charts, tier/type donut-style bars.

### Component
- `src/lib/components/BrainGraph.svelte` — d3-force simulation with:
  - Node color by type (observation=blue, decision=green, pattern=purple, learning=orange, task=grey)
  - Node radius scaled by quality_score (4–16px)
  - Memory tier ring style (short=thin solid, medium=dashed, long=thick solid)
  - Prune-candidate opacity 0.35, invalidated opacity 0.2
  - Edge colors by type (supersedes=red, applies_to=blue, derived_from=green)
  - Click node → detail panel
  - Drag to reposition, scroll to zoom (d3-zoom)
  - Time slider filter (client-side by created_at)

## Verified Live Data

From `brain.db` at `/mnt/projects/cleocode/.cleo/`:
- Graph: 767 total nodes, 556 total edges (500 returned, quality-ranked)
- Decisions: 14 decisions
- Observations: 341 total (200 returned per page, filterable)
- Quality: short=323, medium=18 tiers; 43 verified, 0 prune candidates

## Quality Gates

- `pnpm biome ci` — clean (5 files, no fixes)
- `pnpm run build` (studio) — passes
- `pnpm run test` — 1 pre-existing failure in parity.test.ts (unrelated to this work, existed before changes)
- All 5 pages render, all 4 API endpoints return data

## Dependencies Added
- `d3@^7.9.0` added to `packages/studio/package.json`
