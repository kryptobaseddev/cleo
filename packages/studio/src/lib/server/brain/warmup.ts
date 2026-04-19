/**
 * Server-side cache warmup for the Brain load path.
 *
 * Populates the in-memory LRU cache for the most-recently-used project on
 * server boot so that the very first user request to `/brain` gets a cache
 * hit instead of bearing the full cold-query cost.
 *
 * The warmup is intentionally best-effort — failures are silently swallowed
 * so a missing nexus.db or an unavailable project never prevents the server
 * from starting.
 *
 * Call {@link scheduleBrainWarmup} once from the SvelteKit `hooks.server.ts`
 * `init` export (or equivalent startup path).  The function defers actual
 * work to a `setTimeout(fn, 0)` so it does not block the server boot path.
 *
 * @module
 * @task T990
 */

import { getAllSubstrates } from '@cleocode/brain';
import { buildCacheKey, setCachedGraph } from './cache.js';
import { recordBrainLoadDuration } from './metrics.js';

/** Default limit used for warmup — matches the tier-0 hub-node cap. */
const WARMUP_LIMIT = 200;

/**
 * Warms the cache for a specific project context.
 *
 * Runs a tier-0 (200-node) query so first paint is always a cache hit.
 * The full tier-1 / tier-2 payloads are populated lazily on demand.
 *
 * @param projectId - Project ID to warm (empty string = default project).
 * @param projectCtx - Resolved project context forwarded to `getAllSubstrates`.
 */
export function warmBrainCacheForProject(
  projectId: string,
  projectCtx: import('@cleocode/brain').BrainQueryOptions['projectCtx'],
): void {
  const key = buildCacheKey({ projectId, limit: WARMUP_LIMIT });
  const t0 = performance.now();
  try {
    const graph = getAllSubstrates({ limit: WARMUP_LIMIT, projectCtx });
    const elapsed = performance.now() - t0;
    setCachedGraph(key, graph);
    recordBrainLoadDuration(0, elapsed);
    console.info(
      `[brain/warmup] project="${projectId}" nodes=${graph.nodes.length} elapsed=${elapsed.toFixed(1)}ms`,
    );
  } catch (err) {
    // Warmup is best-effort — log and move on.
    console.warn('[brain/warmup] failed:', err);
  }
}

/**
 * Schedules a best-effort cache warmup deferred to the next event-loop tick.
 *
 * Accepts an optional array of project contexts to warm in series.
 * If none are provided the function is a no-op.
 *
 * @param projects - Projects to warm.  Each entry must supply `projectId` and `projectCtx`.
 */
export function scheduleBrainWarmup(
  projects: Array<{
    projectId: string;
    projectCtx: import('@cleocode/brain').BrainQueryOptions['projectCtx'];
  }>,
): void {
  if (projects.length === 0) return;
  setTimeout(() => {
    for (const p of projects) {
      warmBrainCacheForProject(p.projectId, p.projectCtx);
    }
  }, 0);
}
