# T647 — LivingBrainGraph UX P0 Fixes

**Status**: complete
**Date**: 2026-04-15
**File modified**: `packages/studio/src/lib/components/LivingBrainGraph.svelte`

## Changes Made

### (1) Edge Rendering Fixed

- Added `import { EdgeArrowProgram } from 'sigma/rendering'` and `import type { NodeLabelDrawingFunction } from 'sigma/rendering'`
- Passed `edgeProgramClasses: { arrow: EdgeArrowProgram }` to the Sigma constructor
- Sigma 3 requires explicit registration of the `arrow` edge program; without it, edges with `defaultEdgeType: 'arrow'` silently fail to render

### (2) Label Readability Fixed

- Implemented custom `drawNodeLabel` function matching the `NodeLabelDrawingFunction` signature
- Renders a semi-transparent dark pill background (`rgba(10, 13, 20, 0.82)`) with `context.roundRect` (with rect fallback for older environments) before drawing white text (`#f1f5f9`)
- Set `labelColor: { color: '#f1f5f9' }` as the sigma setting baseline
- Set `labelWeight: '500'` for slightly bolder text
- Passed `defaultDrawNodeLabel: drawNodeLabel` to Sigma constructor settings

### (3) Smart Label Truncation

- Added `truncateLabel(s, max=24)` helper that appends `…` (U+2026) when the label exceeds 24 characters
- Applied at `g.addNode` time — the truncated string is stored as `label` (used by sigma on-canvas), while the full original string is stored as `fullLabel`
- Tooltip `enterNode` handler now reads `attrs.fullLabel` to show the complete text on hover

### (4) Filter Re-rendering Fixed

- Extracted `initSigma()` function that kills the existing instance and rebuilds from scratch
- Added a `$effect` that tracks `nodes` and `edges` prop changes and calls `initSigma()` when they change and sigma is already mounted
- This ensures substrate toggles, weight slider, and time slider changes propagate correctly — Svelte 5's `$derived` in the page already produces a new filtered array reference on each filter change, which triggers the `$effect` dependency

## Quality Gates

- `pnpm biome check --write packages/studio/src/lib/components/LivingBrainGraph.svelte` — passes (svelte files are excluded from biome per root config `includes`)
- `pnpm --filter @cleocode/studio run build` — green (1.97s)
- `pnpm --filter @cleocode/studio run test` — 3 test files, 42 tests, all passed

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| Edges visible (EdgeArrowProgram registered) | DONE |
| Labels readable: white text with dark background | DONE |
| Long labels truncated to 24 chars with ellipsis | DONE |
| Full label in tooltip on hover | DONE |
| Substrate filter toggle re-renders graph | DONE |
| Weight slider re-renders graph | DONE |
| Time slider re-renders graph | DONE |
| Build green | DONE |
| No `any`/`unknown` types | DONE |
| Props interface unchanged | DONE |
