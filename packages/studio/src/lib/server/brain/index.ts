/**
 * Barrel for `$lib/server/brain/*` — server-side Brain load optimisation utilities.
 *
 * Exports cache, metrics, and warmup utilities consumed by:
 * - `src/routes/brain/+page.server.ts` (tier-0 load with caching)
 * - `src/routes/api/brain/+server.ts` (tier-1/2 progressive fetch)
 * - `src/routes/api/brain/chunks/+server.ts` (streaming tier endpoint)
 * - `src/hooks.server.ts` (warmup scheduling on server init)
 * - `src/routes/api/health/+server.ts` (metrics exposure)
 *
 * @module
 * @task T990
 */

export {
  buildCacheKey,
  type CacheKeyParts,
  type CacheMetrics,
  clearBrainCache,
  getBrainCacheMetrics,
  getCachedGraph,
  invalidateBrainCache,
  invalidateCacheKey,
  resetBrainCacheMetrics,
  setCachedGraph,
} from './cache.js';

export {
  type BrainLoadMetrics,
  getBrainLoadMetrics,
  type LoadTier,
  recordBrainLoadDuration,
  resetBrainLoadMetrics,
} from './metrics.js';

export {
  scheduleBrainWarmup,
  warmBrainCacheForProject,
} from './warmup.js';
