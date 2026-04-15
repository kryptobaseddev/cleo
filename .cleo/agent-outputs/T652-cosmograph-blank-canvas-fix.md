# T652 — Cosmograph GPU mode blank canvas fix

**Task**: T652  
**Date**: 2026-04-15  
**Status**: complete

## Root Cause

Three issues combined to produce a blank canvas when toggling to GPU mode:

### 1. Color range bug (primary cause — blank white canvas)

`hexToRgba` was returning values in 0–255 range for RGB components and 0–255 for alpha. cosmos.gl's `setPointColors` and `setLinkColors` accept Float32Arrays that are passed **directly** to WebGL vertex attribute buffers. WebGL floats are clamped to 1.0 in the shader, so every value > 1 became 1.0 — all points rendered as solid white/opaque-white blobs with no visual distinction.

Fix: divide each R/G/B component by 255 inside `hexToRgba`. Alpha changed to 0.0–1.0 range. All callers updated (`hexToRgba(hex, 0.9)` instead of `hexToRgba(hex, 230)`).

Also removed the `rgba()` string special-case in `edgeRgba` — replaced `EDGE_FALLBACK` with a plain hex string `'#94a3b8'` and let `hexToRgba` handle it uniformly.

### 2. Reactive effect double-init risk

The original `$effect` called `initCosmos()` whenever `nodes` or `edges` changed AND when `cosmos` was non-null. On first mount, `onMount` ran `initCosmos()` which set `cosmos`, which could immediately re-trigger the effect before the frame was complete.

Fix: guard the effect with `if (mounted && cosmos !== null)` so it only fires after the initial `onMount`-driven init, never on the first render tick.

### 3. No error handling or WebGL detection

Cosmos.gl failures (missing WebGL, regl constructor error, API mismatch) were silently caught by nothing — the container just stayed empty.

Fix: added pre-flight `checkWebGl()` using `canvas.getContext('webgl2') ?? canvas.getContext('webgl')`. On failure or on any thrown exception in `initCosmos`, the component sets `initFailed = true` with a human-readable `failureReason` string, renders a visible fallback banner, and calls the new `onInitFailed` callback prop.

## Files Changed

- `packages/studio/src/lib/components/LivingBrainCosmograph.svelte`
  - `hexToRgba`: divide RGB by 255, alpha 0.0–1.0
  - `EDGE_FALLBACK`: changed from `rgba(...)` string to plain hex
  - `edgeRgba`: simplified (no special rgba branch needed)
  - `buildBuffers`: color values now 0.0–1.0 (0.9 alpha for nodes, 0.7 for edges)
  - `applyPulses`: pulse white = `hexToRgba('#ffffff', 1.0)`, base = 0.9 alpha
  - `checkWebGl()`: new helper, detects WebGL availability
  - `initCosmos()`: wrapped in try/catch, calls `checkWebGl()` pre-flight, sets `initFailed`/`failureReason`, calls `onInitFailed` callback
  - `$effect` data change guard: `if (mounted && cosmos !== null)` prevents double-init
  - Props: added `onInitFailed?: (reason: string) => void`
  - Template: renders `lbc-fallback` banner when `initFailed` is true
  - CSS: added `.lbc-fallback`, `.lbc-fallback-icon`, `.lbc-fallback-reason`; added `min-height: 0` to `.lbc-wrap` and `.lbc-canvas` for flex/grid container sizing

- `packages/studio/src/routes/brain/+page.svelte`
  - Wired `onInitFailed={() => { useGpuRenderer = false; }}` on `LivingBrainCosmograph`
  - When cosmos.gl fails, the toggle auto-reverts to Standard — no blank canvas

## Quality Gates

- `pnpm biome check --write packages/studio/`: pass (0 errors, 55 files checked)
- `pnpm --filter @cleocode/studio run build`: pass (built in 1.85s)
- `pnpm --filter @cleocode/studio run test`: pass (8 test files, 120/120 tests)
