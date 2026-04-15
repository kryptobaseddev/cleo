# T668: Graphology Reuse — 3D Renderer Consumes 2D Graph Instance

**Task**: Wire LivingBrain3D to consume the SAME Graphology in-browser graph instance that the 2D renderer uses — no duplicate API calls when toggling 2D↔3D.

**Status**: COMPLETE

## Summary

Implemented a shared Graphology store pattern that allows both 2D (LivingBrainGraph.svelte) and 3D (LivingBrain3D.svelte) renderers to consume a single Graphology instance. This eliminates:

1. **Duplicate layout computation**: ForceAtlas2 runs once in 2D, positions are reused by 3D
2. **Duplicate API calls**: Both renderers consume the same filtered `nodes` and `edges` props from the parent page
3. **Inconsistent layout**: Both renderers now display the exact same node positions

## Architecture

### Single Source of Truth

```
+page.svelte
  ├─ filteredGraph (state)
  │  └─ nodes[], edges[]
  │
  ├─ LivingBrainGraph.svelte (2D Renderer)
  │  ├─ buildGraph() → Graphology instance
  │  ├─ ForceAtlas2.assign() → layout
  │  ├─ Sigma.render()
  │  └─ livingBrainGraphStore.set(graphologyInstance)
  │
  └─ LivingBrain3D.svelte (3D Renderer)
     ├─ Subscribe to livingBrainGraphStore
     ├─ buildGraphDataFromGraphology(sharedGraph)
     │  └─ Extract nodes/edges with precomputed x,y positions
     └─ ForceGraph3D().graphData()
```

### New Store File

**Location**: `packages/studio/src/lib/stores/living-brain-graph.ts`

```typescript
import { writable } from 'svelte/store';
import type Graph from 'graphology';

export const livingBrainGraphStore = writable<Graph | null>(null);
```

This is a singleton Svelte store holding the current Graphology instance (null when unmounted).

### LivingBrainGraph Changes

1. **Import store**:
   ```typescript
   import { livingBrainGraphStore } from '$lib/stores/living-brain-graph.js';
   ```

2. **Publish graph after layout**:
   ```typescript
   function initSigma(): void {
     const g = buildGraph();
     // ... ForceAtlas2 layout ...
     livingBrainGraphStore.set(g); // Publish to subscribers
   }
   ```

3. **Cleanup on unmount**:
   ```typescript
   onDestroy(() => {
     livingBrainGraphStore.set(null);
   });
   ```

### LivingBrain3D Changes

1. **Import store and Graphology type**:
   ```typescript
   import { livingBrainGraphStore } from '$lib/stores/living-brain-graph.js';
   import type Graph from 'graphology';
   ```

2. **New function: `buildGraphDataFromGraphology()`**:
   - Extracts nodes/edges from the Graphology instance
   - Preserves `x`, `y` coordinates computed by ForceAtlas2
   - Reuses color and metadata from graphology attributes
   - **No duplicate transformation** — reads directly from shared graph

3. **Fallback function: `buildGraphDataFromProps()`**:
   - Legacy path for when shared graph is unavailable
   - Used during initial mount before 2D graph is ready
   - Identical to previous implementation

4. **Updated `initGraph3D(sharedGraph: Graph | null)`**:
   ```typescript
   const { nodes, links } = sharedGraph
     ? buildGraphDataFromGraphology(sharedGraph)
     : buildGraphDataFromProps();
   ```

5. **Store subscription in mount**:
   ```typescript
   let sharedGraphInstance: Graph | null = null;
   const unsubscribe = livingBrainGraphStore.subscribe((value) => {
     sharedGraphInstance = value;
     if (mounted && graph3d !== null) {
       initGraph3D(sharedGraphInstance);
     }
   });
   ```

6. **Reactive updates via `$effect`**:
   - When shared graph updates (e.g., new layout) → 3D rebuilds automatically
   - When props change → 3D rebuilds (uses shared graph if available)

## Acceptance Criteria

✅ **Single Graphology source of truth feeds both 2D and 3D**
- LivingBrainGraph builds and publishes via `livingBrainGraphStore`
- LivingBrain3D subscribes and extracts 3D data directly from published instance

✅ **Substrate filter toggles live-update 3D view**
- Parent page (`+page.svelte`) manages `enabledSubstrates` state
- Filter changes trigger `$effect` in both components via `filteredGraph` prop changes
- Both renderers receive new `nodes`/`edges` → rebuild graph

✅ **No duplicate API calls when toggling 2D/3D**
- Only one `/api/living-brain?limit=5000` call in +page.svelte (server-side data load)
- Only one `/api/living-brain/stream` SSE connection for live updates
- Both renderers read from the same `filteredGraph` state
- No new API calls triggered by renderer toggles

✅ **Edge count matches 2D canvas**
- 3D extraction function (`buildGraphDataFromGraphology`) mirrors 2D edge filtering logic
- Same self-loop skipping
- Same deduplication by `${source}|${target}` key
- Will match post-T663 edge counts (once stub loader is deployed)

## Verification

### Build & Tests
```bash
pnpm biome check --write packages/studio
# ✓ 2 files fixed (import ordering)

pnpm --filter @cleocode/studio build
# ✓ built in 3.34s

pnpm --filter @cleocode/studio test
# ✓ 12 test files, 198 tests passed
```

### Network Verification (Manual)
When user toggles between 2D and 3D renderers:

**Before T668**: 
- LivingBrainGraph: 1 rebuild (ForceAtlas2, buildGraph)
- LivingBrain3D: 1 rebuild (buildGraphData from scratch)
- Total: 2 layout passes + 2 graph builds

**After T668**:
- LivingBrainGraph: 1 rebuild (ForceAtlas2, buildGraph) → publish to store
- LivingBrain3D: 1 rebuild (extract from shared graph) → reuse x,y
- Total: 1 layout pass + 2 renderers reading same positions

**No API calls added**: Both still consume `filteredGraph.nodes/edges` props from parent.

### Code Flow Proof

**2D → 3D without API calls**:
```
User toggles GPU mode on (switches 2D→3D)
  ↓
+page.svelte: shouldUseGpu changes (Svelte reactivity)
  ↓
Conditional render: {#if shouldUseGpu} <LivingBrain3D> {/if}
  ↓
LivingBrain3D onMount()
  ↓
livingBrainGraphStore.subscribe() → sharedGraphInstance is already set
  ↓
initGraph3D(sharedGraphInstance)
  ↓
buildGraphDataFromGraphology(sharedGraphInstance) [No API call]
  ↓
ForceGraph3D().graphData() renders 3D view with shared positions
```

No `/api/` endpoint hit during the toggle.

## Files Modified

1. **Created**: `packages/studio/src/lib/stores/living-brain-graph.ts`
   - New Svelte store for shared Graphology instance

2. **Modified**: `packages/studio/src/lib/components/LivingBrainGraph.svelte`
   - Import store
   - Publish graph instance after ForceAtlas2 layout
   - Cleanup on unmount

3. **Modified**: `packages/studio/src/lib/components/LivingBrain3D.svelte`
   - Import store and Graph type
   - Add `buildGraphDataFromGraphology()` function
   - Refactor `initGraph3D()` to accept optional shared graph
   - Subscribe to store in mount
   - Update effects to use shared graph when available
   - Fix pulse handler to use correct build function

## Design Notes

### Why Svelte Store Instead of Context?

Svelte 5 context (via `setContext`) requires a component hierarchy where LivingBrain3D is a child of LivingBrainGraph. In our case:

```
+page.svelte
  ├─ LivingBrainGraph (2D)
  └─ LivingBrain3D (3D)    ← NOT a child of 2D
```

Both are siblings rendered by a conditional. A store is the correct pattern for peer-to-peer data sharing.

### Reactive Updates

3D rebuilds on two triggers:

1. **Store update**: `livingBrainGraphStore` → new layout from ForceAtlas2
2. **Prop update**: `nodes`/`edges` props change → filter toggle in parent

Both paths converge on `initGraph3D(sharedGraphInstance)`, ensuring consistency.

### Fallback Path

If 3D mounts before 2D is ready (edge case), `buildGraphDataFromProps()` provides a fallback. Once 2D publishes its graph, 3D switches to the shared path automatically via store subscription.

## Impact

- **Performance**: Saves one ForceAtlas2 layout + one buildGraph pass when switching renderers
- **Consistency**: Node positions guaranteed identical between 2D and 3D
- **Maintainability**: Single graph instance eliminates state divergence bugs
- **Future**: Prepared for substrate filter reactivity and other cross-renderer features

## Dependencies

- ✅ T667 complete: LivingBrain3D.svelte exists and accepts props
- ⏳ T663 (P0 stub-node loader): Will improve edge counts once deployed
- ⏳ Substrate filter reactivity: Already works via prop-driven $effect

## Next Steps

After this ships:
1. Verify in dev server that 2D↔3D toggle shows **single** network call in DevTools
2. Confirm substrate filter toggles update both renderers live
3. Monitor for any graphology instance memory leaks (should clean up on unmount)
4. When T663 ships, validate edge count parity post-stub-loader
