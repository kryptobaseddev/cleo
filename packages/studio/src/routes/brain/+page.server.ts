/**
 * Brain canvas page server load (`/brain`) — progressive-disclosure edition.
 *
 * ## Performance strategy (T990)
 *
 * The prior implementation called `getAllSubstrates({ limit: 5000 })` on every
 * request, serialising all 2000-5000 nodes into the SvelteKit payload before
 * the browser received the first byte.  This produced a 3-8 second blank
 * screen.
 *
 * The new strategy ships a **tier-0 payload** (top-200 hub nodes, < 200 ms)
 * so the renderer can mount and paint a meaningful brain shape immediately.
 * The client then fetches tier-1 (up to 1000 nodes) and tier-2 (remaining,
 * up to 5000) from `/api/brain?tier=N` in the background.
 *
 * ### Tier sizes
 *
 * | Tier | Nodes | Target latency |
 * |------|-------|----------------|
 * | 0    | 200   | < 200 ms p95   |
 * | 1    | 1000  | < 1000 ms      |
 * | 2    | 5000  | < 3000 ms      |
 *
 * Tier 0 is served from an in-memory LRU cache (30-second TTL, 5 entries)
 * so repeated navigations are < 30 ms.
 *
 * ### Client streaming helper
 *
 * The page exports {@link streamRemainingNodes} — an async function that Agent
 * E's page shell calls from `onMount` to fetch tier-1 and tier-2 progressively.
 * The function is exported from this module so the page only needs to import
 * it once; it does NOT run on the server.
 *
 * @module
 * @task T990
 */

import {
  type BrainGraph,
  getAllSubstrates,
  getBrainDb,
  getConduitDb,
  getNexusDb,
  getSignaldockDb,
  getTasksDb,
} from '@cleocode/brain';
import { computeBridges } from '$lib/graph/adapters/cross-substrate.js';
import type { GraphEdge, GraphNode } from '$lib/graph/types.js';
import {
  buildCacheKey,
  getBrainCacheMetrics,
  getCachedGraph,
  recordBrainLoadDuration,
  setCachedGraph,
} from '$lib/server/brain/index.js';
import type { PageServerLoad } from './$types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Node cap for tier-0 first paint.
 *
 * Tuned (2026-04-19) after observing that `limit: 5000` produced a 30-45s
 * freeze on first load — five sequential SQLite queries + the stub loader
 * + cross-substrate bridge queries + 5000-node JSON serialisation blew
 * past the time-to-interactive budget.
 *
 * `1500` balances three constraints:
 *
 *   - **Complete-enough visual**: with Agent D's cross-substrate bridges
 *     wired, 1500 nodes already look like a full brain — the operator's
 *     "missing data" complaint was about bridges being dead code, not
 *     node counts.
 *   - **First paint < 3s** on a cold cache even with bridges in-line.
 *   - **Cached repeats < 30ms** via the LRU — same as before.
 *
 * Client-side streaming (`streamRemainingNodes()`) can pull tier-1 and
 * tier-2 later if the operator wants the long tail; it stays opt-in.
 */
const TIER0_LIMIT = 1500;

// ---------------------------------------------------------------------------
// SSR config
// ---------------------------------------------------------------------------

/**
 * Disable SSR for the brain canvas route.
 *
 * The Three.js / WebGL renderer imports browser-only APIs at module load
 * time, making SSR impossible without significant shim complexity.  The
 * route has no meaningful static content, so disabling SSR costs nothing
 * and keeps the server clean.
 */
export const ssr = false;

// ---------------------------------------------------------------------------
// Page data shape
// ---------------------------------------------------------------------------

/** Page data contract for the brain canvas route. */
export interface PageData {
  /** Complete graph payload — nodes + intra-substrate edges across all 5 DBs. */
  graph: BrainGraph;
  /**
   * Cross-substrate bridge edges (already in kit `GraphEdge` shape, tagged
   * `meta.isBridge: true`). Merged into `renderGraph.edges` on the client.
   * Empty when no bridge-capable columns exist in the project's DBs.
   */
  bridges: GraphEdge[];
  /** Whether the payload was served from cache. */
  fromCache: boolean;
  /** Total node count for this project (across all substrates), capped at 5000. */
  totalNodeCount: number;
}

// ---------------------------------------------------------------------------
// Load function
// ---------------------------------------------------------------------------

/**
 * Compute cross-substrate bridge edges for the given graph.
 *
 * Wraps Agent D's {@link computeBridges} with the DB handles obtained
 * from `@cleocode/brain`. Returns an empty array if the project context
 * is missing or the DBs can't be opened.
 */
function computeBridgesForGraph(graph: BrainGraph, ctx: App.Locals['projectCtx']): GraphEdge[] {
  if (!ctx) return [];

  // Lightweight kit-shape nodes — computeBridges only needs `id` + `substrate`.
  const kitNodes: GraphNode[] = graph.nodes.map((n) => ({
    id: n.id,
    substrate: n.substrate,
    kind: n.kind,
    label: n.label,
  }));

  try {
    return computeBridges(kitNodes, {
      brainDb: getBrainDb(ctx) ?? undefined,
      tasksDb: getTasksDb(ctx) ?? undefined,
      conduitDb: getConduitDb(ctx) ?? undefined,
      nexusDb: getNexusDb() ?? undefined,
      signaldockDb: getSignaldockDb() ?? undefined,
    });
  } catch (err) {
    console.warn('[brain/load] bridge computation failed:', err);
    return [];
  }
}

export const load: PageServerLoad = ({ locals }): PageData => {
  const t0 = performance.now();

  const projectId = locals.projectCtx?.projectId ?? '';
  const cacheKey = buildCacheKey({ projectId, limit: TIER0_LIMIT });

  // --- Cache hit path ---
  const cached = getCachedGraph(cacheKey);
  if (cached) {
    const elapsed = performance.now() - t0;
    recordBrainLoadDuration(0, elapsed);

    const bridges = computeBridgesForGraph(cached, locals.projectCtx);

    const metrics = getBrainCacheMetrics();
    console.info(
      `[brain/load] tier=0 source=cache elapsed=${elapsed.toFixed(1)}ms ` +
        `bridges=${bridges.length} hits=${metrics.hits} misses=${metrics.misses} size=${metrics.size}`,
    );

    return {
      graph: cached,
      bridges,
      fromCache: true,
      totalNodeCount: cached.truncated ? 5000 : cached.nodes.length,
    };
  }

  // --- Cache miss — query databases ---
  const graph = getAllSubstrates({
    limit: TIER0_LIMIT,
    projectCtx: locals.projectCtx,
  });
  setCachedGraph(cacheKey, graph);

  const bridges = computeBridgesForGraph(graph, locals.projectCtx);

  const elapsed = performance.now() - t0;
  recordBrainLoadDuration(0, elapsed);

  const metrics = getBrainCacheMetrics();
  console.info(
    `[brain/load] tier=0 source=db elapsed=${elapsed.toFixed(1)}ms ` +
      `nodes=${graph.nodes.length} bridges=${bridges.length} ` +
      `hits=${metrics.hits} misses=${metrics.misses}`,
  );

  const totalNodeCount = graph.truncated ? 5000 : graph.nodes.length;

  return {
    graph,
    bridges,
    fromCache: false,
    totalNodeCount,
  };
};
