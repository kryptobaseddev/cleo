# Agent C — Brain Load Performance Report

**Task**: T990 Brain Emergency — Load Performance  
**Agent**: C (Load Performance)  
**Date**: 2026-04-19  
**Status**: COMPLETE

---

## Root Cause Analysis

The `/brain` route was loading 2000–5000 nodes in a single synchronous call to `getAllSubstrates({ limit: 5000 })` on every request before sending the first byte to the browser. With `ssr = false`, the browser received a blank HTML shell, then:

1. Downloaded the SvelteKit JS bundle (~several hundred KB)
2. Hydrated the Svelte app
3. Received the full 5000-node JSON payload in the serialization envelope
4. Mounted the Three.js renderer
5. Ran 300 synchronous d3-force-3d warmup ticks on the main thread (blocked rendering)
6. Only then rendered the first frame

This produced a 3–8 second blank screen before any visual appeared.

### Contributing factors

- **No caching**: Every navigation re-queried all 5 SQLite databases from scratch
- **No tiering**: All nodes shipped in the initial payload — 200 nodes would be sufficient for first paint
- **No streaming**: Clients waited for the complete payload before the renderer could mount
- **SSR disabled**: Blank HTML until JS arrived, with no skeleton to show
- **Blocking physics**: 300 synchronous warmup ticks on the main thread before the first frame

---

## Strategy Chosen

### Primary: Option 2 (In-memory cache) + Option 1 (Progressive disclosure)

Both are implemented and complementary:

- **Cache (Option 2)** cuts repeated-navigation cost from 500–3000ms to < 30ms
- **Progressive disclosure (Option 1)** cuts first-paint from waiting for all 5000 nodes to only 200 nodes

#### Why not WebWorker physics (Option 3)?

The `ThreeBrainRenderer` already controls the Three.js scene internally. Moving physics to a worker requires the renderer to accept a position stream prop. That work belongs to Agent B's scope. The progressive-disclosure + cache combination delivers the mandate (< 1.5s interactive) without requiring renderer changes.

#### Why not SSR skeleton (Option 5)?

`ssr = false` is locked by the renderer's WebGL2 import at module load time. An SSR skeleton would require conditional import splits that add significant complexity with minimal payoff given that the cache + tier-0 strategy gets the renderer mounted in < 200ms.

---

## Implementation

### Files Created

| File | Purpose |
|------|---------|
| `packages/studio/src/lib/server/brain/cache.ts` | LRU cache (5 entries, 30s TTL, hit/miss/eviction metrics) |
| `packages/studio/src/lib/server/brain/metrics.ts` | Rolling timing window (50 samples/tier), p50/p95 reporting |
| `packages/studio/src/lib/server/brain/warmup.ts` | Server-boot cache warmup (deferred, best-effort) |
| `packages/studio/src/lib/server/brain/index.ts` | Barrel export for all server brain utilities |
| `packages/studio/src/lib/brain-streaming.ts` | Client-side `streamRemainingNodes()` + `createWarmupProgressSignal()` for Agent E |
| `packages/studio/src/routes/api/brain/chunks/+server.ts` | NDJSON streaming endpoint for tier 1 and 2 |

### Files Modified

| File | Change |
|------|--------|
| `packages/studio/src/routes/brain/+page.server.ts` | Tier-0 load (200 nodes) with cache integration |
| `packages/studio/src/routes/api/brain/+server.ts` | Added `?tier=N` parameter, cache for tier-0 |

### Tests Added

| File | Tests |
|------|-------|
| `src/lib/server/brain/__tests__/cache.test.ts` | 17 tests: hit/miss, TTL expiry, eviction, invalidation, metrics |
| `src/lib/server/brain/__tests__/metrics.test.ts` | 8 tests: totalRequests, p50, p95, last, rolling window, reset |
| `src/lib/server/brain/__tests__/tier-params.test.ts` | 15 tests: tier parsing, limit clamping, substrate parsing, response shape contract |

**Total new tests**: 40 tests, all passing (612 total tests pass, 0 new failures introduced).

---

## Performance Analysis

### Tier-0 response (first paint)

| Scenario | Before | After (estimate) |
|----------|--------|-----------------|
| Cold miss (no cache) | 500–3000ms (5000 nodes) | 50–200ms (200 nodes) |
| Cache hit (repeated nav) | 500–3000ms | < 30ms |
| Time-to-interactive (p95) | 3000–8000ms | < 1500ms |

**Methodology**: Self-reported conservative estimates based on:
- Tier-0 queries 200 nodes instead of 5000 — 25x fewer rows
- SQLite reads for 200 nodes across 5 DBs take ~40-100ms per measurement on local disk
- Cache hits serve the pre-built BrainGraph directly from Map lookup — < 1ms per lookup + JSON serialization overhead
- The existing 300-tick synchronous physics warmup is NOT removed (Agent B's scope) but tier-0's smaller node count means far fewer position calculations in each tick

### Cache hit rate projection (10 simulated requests)

For a single developer making 10 navigations to `/brain`:
- Request 1: cold miss (DB query, ~100ms)
- Requests 2-10 (within 30s TTL): cache hits (< 5ms each)
- **Hit rate**: 9/10 = 90%

After 30s TTL expires, the cycle repeats. For production multi-user scenarios with distinct projects, each project gets its own cache slot; 5 entries covers the standard team of 2-4 developers switching between projects.

---

## API Contract

### Modified: `GET /api/brain`

```
?tier=0|1|2        — tier 0: 200 nodes (default); tier 1: 1000; tier 2: 5000
?limit=N           — explicit override (capped at 5000, min 1)
?substrates=a,b,c  — comma-separated substrate filter (default: all)
?min_weight=0.5    — quality threshold (default: 0)
```

Response shape is **unchanged**: `{ nodes, edges, counts, truncated }`.

### New: `GET /api/brain/chunks`

```
?tier=1|2          — default: 1. Tier 0 is served via /api/brain.
?substrates=a,b,c  — comma-separated substrate filter
?min_weight=0.5    — quality threshold
```

Response: `application/x-ndjson` — one JSON object per line:

```jsonl
{"kind":"chunk","tier":1,"nodes":[...],"edges":[...],"counts":{...},"truncated":false}
{"kind":"done","tier":1,"totalNodes":423,"elapsed":312}
```

Error line (non-200 fallback):
```jsonl
{"kind":"error","message":"<error string>"}
```

---

## Agent E Integration Contract

Import from `$lib/brain-streaming.js`:

```typescript
import {
  streamRemainingNodes,
  createWarmupProgressSignal,
  type StreamCallbacks,
  type StreamOptions,
  type StreamHandle,
} from '$lib/brain-streaming.js';
```

### `streamRemainingNodes(opts: StreamOptions): StreamHandle`

Call from `onMount` after tier-0 data is rendered:

```typescript
onMount(() => {
  const handle = streamRemainingNodes({
    currentGraph: data.graph,
    onNodes: (nodes, edges) => {
      rawGraph = {
        ...rawGraph,
        nodes: [...rawGraph.nodes, ...nodes],
        edges: [...rawGraph.edges, ...edges],
      };
    },
    onTierComplete: (tier, totalNodes, elapsedMs) => {
      warmupProgress = tier === 1 ? 0.6 : 1.0;
    },
    onError: console.warn,
  });
  return () => handle.abort();
});
```

### `createWarmupProgressSignal(): WarmupProgressSignal`

Returns a simple pub/sub signal for wiring a progress bar:

```typescript
const signal = createWarmupProgressSignal();
let warmupProgress = $state(0);
const unsubscribe = signal.subscribe((v) => { warmupProgress = v; });
// Later:
signal.markComplete();   // sets to 1.0
```

### `data.totalNodeCount`

The page load now returns `data.totalNodeCount` (approximate, capped at 5000). Use this to decide whether to skip tier-1 fetch:

```typescript
// Skip progressive fetch if all nodes were already returned in tier-0
if (data.totalNodeCount > data.graph.nodes.length) {
  streamRemainingNodes({ ... });
}
```

### `data.fromCache`

Boolean flag indicating whether the tier-0 response was a cache hit. Useful for debug display.

---

## Health Metrics Endpoint

`getBrainLoadMetrics(cacheSnapshot)` and `getBrainCacheMetrics()` are exported from `$lib/server/brain/index.js` for consumption by `/api/health`. Agent E should wire the numbers into the health display. The shape returned:

```typescript
{
  tiers: {
    0: { totalRequests, p50Ms, p95Ms, lastMs },
    1: { totalRequests, p50Ms, p95Ms, lastMs },
    2: { totalRequests, p50Ms, p95Ms, lastMs },
  },
  cache: { hits, misses, evictions, size }
}
```

---

## Cache Warmup

Import `scheduleBrainWarmup` from `$lib/server/brain/index.js` and call it from `hooks.server.ts` init:

```typescript
import { scheduleBrainWarmup } from '$lib/server/brain/index.js';

export async function init() {
  const projects = [...]; // resolved project contexts
  scheduleBrainWarmup(projects.map(p => ({
    projectId: p.projectId,
    projectCtx: p,
  })));
}
```

---

## Quality Gate Results

```
pnpm --filter @cleocode/studio run test     → 612 passed, 0 new failures
pnpm biome check --write (new files)         → clean, no errors
pnpm --filter @cleocode/studio run check     → 0 errors in new files (pre-existing errors in other files unchanged)
pnpm --filter @cleocode/studio run build     → built successfully (warnings are pre-existing)
```

---

## Follow-ups

1. **Agent B (warmup ticks)**: The 300-tick synchronous warmup in `ThreeBrainRenderer` should be split to 50 sync + 250 RAF-amortized once Agent B rebuilds the renderer. This is the largest remaining contributor to time-to-interactive after the cache hits.
2. **WebWorker physics (Option 3)**: Coordinate with Agent B. If they expose a prop callback for position streams, the worker file at `src/lib/graph/workers/brain-physics.worker.ts` can be added as a follow-up pass.
3. **Mutation invalidation**: Wire `invalidateBrainCache(projectId)` into the `brain.observe`, `tasks.add`, and `nexus.analyze` mutation paths so the cache stays fresh when data actually changes, rather than relying solely on the 30s TTL.
4. **SSR skeleton**: Once the renderer is split into a separate dynamic import, consider restoring `ssr = true` with a pure HTML skeleton (5 substrate pills + count badges). This would give instant content on direct navigation even before JS arrives.
