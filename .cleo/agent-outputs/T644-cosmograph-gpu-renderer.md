# T644 — Cosmograph GPU Renderer

**Task**: Phase 3: Cosmograph spike — GPU renderer for >2K node graphs
**Status**: complete
**Date**: 2026-04-15

## Summary

Implemented `@cosmograph/cosmos` (v2.0.0-beta.26) as a GPU-accelerated fallback renderer for the Living Brain canvas. The sigma-based `LivingBrainGraph` remains the default for graphs under 2 000 nodes; cosmos.gl auto-activates above that threshold and is manually toggle-able at any size.

## Deliverables

### 1. Dependency installed

`@cosmograph/cosmos@^2.0.0-beta.26` added to `packages/studio/package.json` dependencies (matching the placement of `graphology`/`sigma`). Verified:

```
pnpm --filter @cleocode/studio list @cosmograph/cosmos
└── @cosmograph/cosmos@2.0.0-beta.26
```

No peer-dependency conflicts.

### 2. New component

`packages/studio/src/lib/components/LivingBrainCosmograph.svelte`

- Props interface is identical to `LivingBrainGraph` (nodes, edges, onNodeClick, height, pulsingNodes, pulsingEdges) — drop-in swap.
- cosmos.gl v2 API uses index-based `Float32Array` buffers; the component builds `positions`, `colors`, `sizes`, `links`, `linkColors`, `linkWidths` arrays from `LBNode[]` / `LBEdge[]`.
- An `indexToId: string[]` array enables the numeric `onClick(index)` callback to resolve back to a string node ID for the side panel.
- Self-loops and dangling edges are filtered; duplicate edges are deduplicated.
- Cleanup in `onDestroy`: `cosmos.destroy()` — prevents WebGL context leaks.
- Svelte 5 runes (`$props`, `$effect`, `$state`).

### 3. Pulse trade-off (documented in TSDoc)

cosmos.gl v2 has no per-node animation API. Pulse feedback is approximated by:
- Re-uploading the full point color buffer with pulsing nodes set to `#ffffff`.
- Calling `zoomToPointByIndex` on the first pulsing node as a visual beacon.
- Restoring base colors after `PULSE_DURATION_MS` (1 500 ms).

This is inferior to sigma's frame-by-frame pulse but is the maximum achievable with the v2 index-based API. LivingBrainGraph remains default for <2K nodes exactly because of this difference.

### 4. Canvas page toggle

`packages/studio/src/routes/brain/+page.svelte` additions:

- `let useGpuRenderer = $state(false)` — user toggle.
- `let shouldUseGpu = $derived(useGpuRenderer || filteredGraph.nodes.length > 2000)` — auto-activates.
- `renderer-btn` in header controls (styled purple to match the cosmos theme, next to substrate filters).
- Conditional render: `{#if shouldUseGpu} <LivingBrainCosmograph ...> {:else} <LivingBrainGraph ...> {/if}`.

### 5. Tests

`packages/studio/src/lib/components/__tests__/LivingBrainCosmograph.test.ts`

35 new tests covering pure helper logic (no DOM/WebGL required):
- `hexToRgba` — hex → RGBA tuple conversion
- `edgeRgba` — edge-type colour lookup with fallback
- `nodeSize` — weight → pixel size formula
- `buildBuffers` — empty data, 100-node payload, correct buffer lengths, index mapping
- `onNodeClick` mapping — index → node ID resolution
- Edge deduplication and self-loop filtering
- Cleanup/destroy safety

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write packages/studio` | Pass (1 auto-fix in test file, pre-existing info in app.d.ts) |
| `pnpm --filter @cleocode/studio run build` | Pass — built in 2.03s |
| `pnpm --filter @cleocode/studio run test` | 7 test files, **116 tests passed** (was 81 before) |

## Files changed

- `packages/studio/package.json` — added `@cosmograph/cosmos@^2.0.0-beta.26`
- `packages/studio/src/lib/components/LivingBrainCosmograph.svelte` — new
- `packages/studio/src/lib/components/__tests__/LivingBrainCosmograph.test.ts` — new
- `packages/studio/src/routes/brain/+page.svelte` — toggle + conditional render

## Constraints respected

- LivingBrainGraph.svelte NOT modified.
- sigma-defaults.ts NOT modified.
- project-context.ts NOT modified.
- Route paths NOT modified.
- No `any` / `unknown` types.
- Svelte 5 runes throughout.
- Biome formatting clean.
