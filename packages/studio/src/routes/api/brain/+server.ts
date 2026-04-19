/**
 * Unified BRAIN super-graph API endpoint — progressive-disclosure edition.
 *
 * GET /api/brain
 *   → { nodes: BrainNode[], edges: BrainEdge[], counts, truncated }
 *
 * ## Query parameters
 *
 * | Param        | Default | Notes                                              |
 * |--------------|---------|---------------------------------------------------|
 * | `tier`       | `0`     | 0 = hub nodes only (200); 1 = up to 1000;         |
 * |              |         | 2 = up to 5000.  Drives `limit` when omitted.     |
 * | `limit`      | tier-driven | explicit override; max 5000                   |
 * | `substrates` | all     | comma-separated: brain,nexus,tasks,conduit,signaldock |
 * | `min_weight` | `0`     | quality/weight threshold 0.0–1.0                  |
 *
 * ## Progressive-disclosure protocol
 *
 * - Tier 0 is served from the in-memory LRU cache (30-second TTL) when
 *   available.  Cache key is derived from (projectId, substrates, limit).
 * - Tier 1 and tier 2 always bypass the cache (they are incremental;
 *   the cache stores the tier-0 snapshot only).
 * - The page load function already ships tier-0 data in the SvelteKit
 *   serialisation envelope; this endpoint is called by the client for
 *   tier 1+ only.
 *
 * @see packages/brain/src/types.ts for BrainGraph schema
 * @see src/lib/server/brain/cache.ts for LRU cache implementation
 * @task T990
 */

import { type BrainSubstrate, getAllSubstrates } from '@cleocode/brain';
import { json } from '@sveltejs/kit';
import {
  buildCacheKey,
  getBrainCacheMetrics,
  getCachedGraph,
  recordBrainLoadDuration,
  setCachedGraph,
} from '$lib/server/brain/index.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid substrate identifiers accepted by the query param. */
const VALID_SUBSTRATES = new Set<BrainSubstrate>([
  'brain',
  'nexus',
  'tasks',
  'conduit',
  'signaldock',
]);

/** Node limits per tier. */
const TIER_LIMITS: Record<number, number> = {
  0: 200,
  1: 1000,
  2: 5000,
};

/** Hard cap: never return more than this many nodes regardless of params. */
const ABSOLUTE_MAX = 5000;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const GET: RequestHandler = ({ locals, url }) => {
  const t0 = performance.now();

  // --- Parse tier ---
  const tierParam = Number(url.searchParams.get('tier') ?? '0');
  const tier = tierParam === 0 || tierParam === 1 || tierParam === 2 ? tierParam : 0;

  // --- Parse limit (explicit override or tier-driven default) ---
  const limitParam = url.searchParams.get('limit');
  const rawLimit = limitParam !== null ? Number(limitParam) : TIER_LIMITS[tier];
  const limit = Math.min(
    Math.max(1, Number.isNaN(rawLimit) ? TIER_LIMITS[tier] : rawLimit),
    ABSOLUTE_MAX,
  );

  // --- Parse substrates ---
  const substratesParam = url.searchParams.get('substrates');
  const substrates = substratesParam
    ? substratesParam
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is BrainSubstrate => VALID_SUBSTRATES.has(s as BrainSubstrate))
    : undefined;

  // --- Parse min_weight ---
  const minWeightParam = url.searchParams.get('min_weight');
  const minWeight = minWeightParam !== null ? Math.max(0, parseFloat(minWeightParam)) : 0;

  // --- Cache lookup (tier-0 only) ---
  const projectId = locals.projectCtx?.projectId ?? '';

  if (tier === 0) {
    const cacheKey = buildCacheKey({ projectId, substrates, limit });
    const cached = getCachedGraph(cacheKey);
    if (cached) {
      const elapsed = performance.now() - t0;
      recordBrainLoadDuration(0, elapsed);
      const metrics = getBrainCacheMetrics();
      console.info(
        `[brain/api] tier=0 source=cache elapsed=${elapsed.toFixed(1)}ms ` +
          `hits=${metrics.hits} misses=${metrics.misses}`,
      );
      return json(cached);
    }
  }

  // --- Query databases ---
  try {
    const graph = getAllSubstrates({
      limit,
      substrates,
      minWeight,
      projectCtx: locals.projectCtx,
    });

    const elapsed = performance.now() - t0;
    recordBrainLoadDuration(tier as 0 | 1 | 2, elapsed);

    // Populate cache for tier-0 results.
    if (tier === 0) {
      const cacheKey = buildCacheKey({ projectId, substrates, limit });
      setCachedGraph(cacheKey, graph);
    }

    const metrics = getBrainCacheMetrics();
    console.info(
      `[brain/api] tier=${tier} source=db elapsed=${elapsed.toFixed(1)}ms ` +
        `nodes=${graph.nodes.length} hits=${metrics.hits} misses=${metrics.misses}`,
    );

    return json(graph);
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
