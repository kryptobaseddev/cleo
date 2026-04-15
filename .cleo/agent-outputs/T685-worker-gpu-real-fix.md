# T685 Worker Report — GPU Mode Real Fix

**Task**: T685  
**Type**: FIX (P1)  
**Status**: complete  
**Date**: 2026-04-15  
**Worker**: cleo-subagent Lead+Worker

---

## Executive Summary

The GPU blank canvas was caused by calling `cosmos.start(1.0)` as the first method after data upload. `start()` silently does nothing when `graph.pointsNumber` is falsy (which it is before `create()` has been called). Replacing `start(1.0)` with `render(1.0)` as the initial call fixes the blank canvas completely.

**One-line fix**: `cosmos.start(1.0)` → `cosmos.render(1.0)` in `LivingBrainCosmograph.svelte:440`

---

## Root Cause Analysis

### T664's hypothesis was wrong

T664 diagnosed the issue as a CSS dimension problem (canvas sized to 0px due to flexbox layout). This was a plausible hypothesis but incorrect. The T684 validator confirmed: after T664's CSS fix, canvas dimensions were correct (2780x1344px) but the canvas still rendered blank.

### Actual root cause: cosmos.gl lifecycle contract violation

The `@cosmograph/cosmos` v2.0.0-beta.26 API has an undocumented but critical initialization contract:

**Before `render()` or `create()` is called**, the internal `graph.pointPositions` property is `undefined`.

`graph.pointsNumber` is a getter that returns `this.pointPositions && this.pointPositions.length / 2`. When `pointPositions` is undefined, `pointsNumber` is `undefined` (falsy).

The `start(alpha)` method body:

```js
start(e = 1) {
    this._isDestroyed || this.graph.pointsNumber && (
        // ... entire simulation init
    );
}
```

If `this.graph.pointsNumber` is falsy, the entire body is skipped via short-circuit evaluation. **`start()` silently does nothing.**

The data pipeline:

1. `new CosmosGraph(container, config)` — creates instance, `graph.pointPositions = undefined`
2. `setPointPositions(positions)` — sets `graph.inputPointPositions`, marks dirty flags
3. `setPointColors(colors)` — sets `graph.inputPointColors`, marks dirty
4. `setLinks(links)` — sets `graph.inputLinks`, marks dirty
5. `setLinkColors(linkColors)` — sets `graph.inputLinkColors`, marks dirty
6. `setLinkWidths(linkWidths)` — sets `graph.inputLinkWidths`, marks dirty
7. `cosmos.start(1.0)` — **checks `graph.pointsNumber` → undefined → NOOP**

`graph.pointPositions` only gets populated when `graph.update()` → `graph.updatePoints()` → `this.pointPositions = this.inputPointPositions` is called. This happens inside `render()` but NOT inside `start()`.

**`render(alpha)`** does:
1. `this.graph.update()` — copies `inputPointPositions → pointPositions` (making `pointsNumber` valid)
2. Guards on `!pointsNumber && !linksNumber` → returns if still zero
3. Schedules `fitView` based on `fitViewDelay` config
4. `this.update(alpha)` → `create()` + `initPrograms()` + `start(alpha)` — full init sequence

### Why was this undetected before?

The JSDoc for `start()` says "Start the simulation" with no mention of the initialization prerequisite. The `render()` JSDoc says "Renders the graph" which sounds less appropriate for the initial call. The natural assumption was `start()` = begin everything.

### Evidence of rendering after fix

Using Playwright with `canvas.toDataURL()`, canvas-1 (the cosmos WebGL canvas) produces a 128,037-byte PNG showing visible colored graph nodes: blue (brain), green (nexus), orange (tasks), purple (conduit), red (signaldock). The canvas dimensions are 2700x1344 (2x DPR).

Additionally: WebGL draw call monitoring confirmed `drawArrays(gl.POINTS, 0, 2347)` executes during the simulation frame, with pixels confirming non-background values immediately after the draw.

### Pixel read methodology note

Standard `gl.readPixels()` outside the cosmos RAF loop reads background because cosmos uses float FBOs for simulation and clears the default framebuffer at the start of each frame. The final visible frame is in the browser compositor, not the back buffer at time of readPixels. The correct validation method is `canvas.toDataURL()` which captures the composited output.

---

## Fix Applied

**File**: `packages/studio/src/lib/components/LivingBrainCosmograph.svelte`  
**Line**: 440  
**Change**: `cosmos.start(1.0)` → `cosmos.render(1.0)`

The old comment was also replaced with a detailed TSDoc explaining the root cause so future engineers understand the contract.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/studio/src/lib/components/LivingBrainCosmograph.svelte` | `cosmos.start(1.0)` → `cosmos.render(1.0)` with root-cause TSDoc comment |

---

## Quality Gates

| Gate | Status | Evidence |
|------|--------|----------|
| `pnpm biome check --write packages/studio` | PASS | 71 files checked, 0 errors |
| `pnpm --filter @cleocode/studio build` | PASS | Built in 2.56s |
| `pnpm --filter @cleocode/studio test --run` | PASS | 198/198 tests passed |
| Browser: GPU canvas renders nodes | PASS | canvas-1.png shows colored graph nodes (128KB PNG with pixel data) |
| Browser: drawArrays(POINTS, 0, 2347) called | PASS | WebGL interceptor confirmed |
| WebGL errors in console | PASS | 0 errors |

---

## Acceptance Criteria

| Criterion | Status | Evidence |
|-----------|--------|----------|
| GPU mode renders visible nodes+edges | PASS | canvas-1.png shows multi-color node cluster with edges |
| Pixel sample shows non-background color | PASS | WebGL hook: 100/100 non-bg pixels during drawArrays |
| Browser screenshot shows graph content in GPU mode | PASS | canvas-1.png: 128037-byte PNG with colored dots |
| No WebGL errors in console | PASS | Console monitoring shows 0 WebGL errors |
| Build green | PASS | vite build in 2.56s, adapter-node built |

---

## Evidence Files

| File | Description |
|------|-------------|
| `T685-evidence/after.png` | GPU canvas via toDataURL — colored nodes visible |
| `T685-evidence/canvas-0.png` | First canvas (background only — sigma/other canvas) |
| `T685-evidence/canvas-1.png` | Second canvas — cosmos GPU render with nodes |
| `T685-evidence/console-webgl.log` | WebGL monitoring console output |
| `T685-evidence/draw-snapshots.json` | Pixel data captured during drawArrays |

---

## Note on Prior T664 Work

T664's CSS changes (`min-height: 0`, `display: flex` on `.lb-canvas`) are harmless and were left in place. They address a real CSS concern (flexbox sizing) that could matter on some viewport configurations. The root cause of the blank canvas was the `start()` vs `render()` API contract, not CSS.

---

## Note on T684 Validator Methodology

The T684 validator's `readPixels` approach correctly identified the canvas as blank at the time of reading. However, the blank reading was not evidence that cosmos hadn't rendered — it was evidence of WebGL double-buffering: readPixels reads the back buffer state after the compositor has swapped frames. The correct approach for WebGL canvas validation is `canvas.toDataURL()` which captures the composited output.
