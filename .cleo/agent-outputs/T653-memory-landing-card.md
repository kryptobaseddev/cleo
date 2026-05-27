# T653 — UX: Surface /brain/overview — Memory Landing Card

**Status**: complete
**Date**: 2026-04-15
**Task**: T653

## Summary

Added a fourth portal card to the CLEO Studio landing page (`/`) that links directly to `/brain/overview` (the BRAIN Dashboard). The card is positioned between Code and Tasks, uses amber (`#f59e0b`) as its accent color, and reuses `data.brainStats` (Nodes / Observations counts) already fetched by the page server load.

## Change

**File modified**: `packages/studio/src/routes/+page.svelte`

Added one new portal object to the `portals` array:

```ts
{
  href: '/brain/overview',
  title: 'Memory',
  subtitle: 'BRAIN Dashboard',
  description:
    'Decisions timeline, observations, quality distribution, memory tiers, and recent activity. The overview dashboard for the 5-substrate BRAIN.',
  color: '#f59e0b',
  stats: data.brainStats,
}
```

**File NOT modified**: `+page.server.ts` — `brainStats` was already present in the load function; no additional DB queries needed.

## Card Details

- Icon letter: `M` (derived from `portal.title[0]` — "Memory")
- Color: `#f59e0b` (amber — distinct from Brain canvas green `#22c55e`)
- Stats: reuses `brainStats` (Nodes / Observations from `brain_page_nodes` and `brain_observations` tables)
- Grid: auto-fills to 2x2 on narrow viewports, 4-across on wide — no CSS changes required

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write packages/studio` | Passed — no fixes applied |
| `pnpm --filter @cleocode/studio run build` | Passed — built in 1.95s |
| `pnpm --filter @cleocode/studio run test` | Passed — 8 test files, 120 tests |

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| User can reach /brain/overview from a visible link without typing URL | Done — Memory card on landing page |
| Landing page has discoverable path to stats dashboard | Done |
| Existing Brain (canvas), Code, Tasks cards preserved | Done — all 3 untouched |
| Build green | Done |
