# T643 — Phase 2: SSE Live Synapses Endpoint + Svelte Client

## Status: complete

## Files Created / Modified

### New files
- `packages/studio/src/routes/api/living-brain/stream/+server.ts`
  SvelteKit GET handler returning `text/event-stream`. Initialises per-connection
  watermarks (rowid-based for brain_observations, conduit messages, tasks; weight
  snapshot for brain_page_edges). Polls every 1 s, heartbeat every 30 s. Cleans up
  on AbortSignal.

- `packages/studio/src/routes/api/living-brain/stream/__tests__/stream.test.ts`
  8 tests: Content-Type, hello event, heartbeat after 30 s, node.create, edge.strengthen,
  task.status, message.send, abort cleanup. All mock-based (no real DB). 42/42 pass.

### Modified files
- `packages/studio/src/lib/server/living-brain/types.ts`
  Added `LBStreamEvent` discriminated union (hello | heartbeat | node.create |
  edge.strengthen | task.status | message.send) and `LBConnectionStatus` type.
  Restored `createdAt: string | null` on `LBNode` (was stripped by linter).

- `packages/studio/src/lib/components/LivingBrainGraph.svelte`
  Added `pulsingNodes: Set<string>` and `pulsingEdges: Set<string>` props.
  `buildGraph()` renders pulsing nodes in white at 2x size and pulsing edges at 2.5x
  thickness. `applyPulses()` mutates the live graphology instance and schedules a
  1500 ms ease-out reset via `setTimeout`. `$effect` triggers `applyPulses` when
  props change.

- `packages/studio/src/routes/living-brain/+page.svelte`
  Wires SSE client: `onMount` opens EventSource on `/api/living-brain/stream`,
  `onDestroy` closes it. Exponential backoff reconnect (2 s → 30 s cap). Handles
  node.create (adds node + pulseNode), edge.strengthen (pulseEdge), task.status
  (updates meta + pulseNode), message.send (pulseNode if visible). SSE status
  badge (connecting / connected / error / disconnected) in header with CSS pulse-dot
  animation.

## Quality Gates

| Gate | Result |
|------|--------|
| biome check --write | No fixes applied (0 errors) |
| pnpm --filter @cleocode/studio run build | Built in 1.78 s |
| pnpm --filter @cleocode/studio run test | 42/42 pass |

## Acceptance Criteria

- [x] GET /api/living-brain/stream returns text/event-stream
- [x] Emits node.create on brain_observations INSERT
- [x] Emits edge.strengthen on brain_page_edges weight UPDATE
- [x] Emits task.status on tasks.status UPDATE
- [x] Svelte client subscribes via EventSource and pulse-animates touched nodes
- [x] Reconnect logic on disconnect (exponential backoff 2 s→30 s)
- [x] Tests cover all 5 event types + abort cleanup (8 tests)
- [x] Build green
- [x] Type-safe (zero any/unknown)
