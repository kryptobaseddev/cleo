/**
 * Server-side performance metrics for the Brain load path.
 *
 * Captures timing samples for each tier (0, 1, 2) of the progressive
 * disclosure strategy, plus a rolling window of the last N durations.
 * Metrics are intentionally in-process and non-persistent — they reset
 * on server restart and are only useful during a running dev/prod session.
 *
 * Exposed at `/api/health` via {@link getBrainLoadMetrics} so the operator
 * can verify p95 numbers without attaching a profiler.
 *
 * @module
 * @task T990
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of timing samples retained per tier. */
const WINDOW_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Timed load tier. */
export type LoadTier = 0 | 1 | 2;

/** Single timing observation. */
interface TimingSample {
  /** Duration in milliseconds. */
  durationMs: number;
  /** Unix ms timestamp of the observation. */
  recordedAt: number;
}

/** Per-tier timing window. */
interface TierMetrics {
  /** Rolling buffer of the last {@link WINDOW_SIZE} samples. */
  samples: TimingSample[];
  /** Total number of requests observed (including those rolled off). */
  totalRequests: number;
}

/** Exported metrics snapshot. */
export interface BrainLoadMetrics {
  /** Timing summary per tier. */
  tiers: Record<
    LoadTier,
    {
      totalRequests: number;
      p50Ms: number | null;
      p95Ms: number | null;
      lastMs: number | null;
    }
  >;
  /** Cache statistics forwarded from the cache module (injected by caller). */
  cache: {
    hits: number;
    misses: number;
    evictions: number;
    size: number;
  };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const _tiers: Record<LoadTier, TierMetrics> = {
  0: { samples: [], totalRequests: 0 },
  1: { samples: [], totalRequests: 0 },
  2: { samples: [], totalRequests: 0 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes a percentile value from a sorted array of numbers.
 *
 * @param sorted - Ascending-sorted array.
 * @param p - Percentile (0–100).
 * @returns Interpolated percentile value, or `null` for empty arrays.
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records a load duration for the given tier.
 *
 * Rolls off the oldest sample when the window is full.
 * Logs to `console.info` so durations appear in the dev server output
 * where the operator can immediately verify performance budgets.
 *
 * @param tier - Which tier completed.
 * @param durationMs - Elapsed time in milliseconds.
 */
export function recordBrainLoadDuration(tier: LoadTier, durationMs: number): void {
  const tm = _tiers[tier];
  tm.totalRequests++;
  if (tm.samples.length >= WINDOW_SIZE) {
    tm.samples.shift();
  }
  tm.samples.push({ durationMs, recordedAt: Date.now() });

  // Visible in the dev server log — no emoji per project rules.
  console.info(`[brain/perf] tier=${tier} duration=${durationMs.toFixed(1)}ms`);
}

/**
 * Returns a snapshot of all tier timing metrics.
 *
 * Inject cache metrics from {@link getBrainCacheMetrics} at the call site
 * rather than importing directly to avoid a circular dependency.
 *
 * @param cacheMetrics - Current cache hit/miss/eviction/size snapshot.
 * @returns {@link BrainLoadMetrics} snapshot.
 */
export function getBrainLoadMetrics(cacheMetrics: BrainLoadMetrics['cache']): BrainLoadMetrics {
  const tiers = ([0, 1, 2] as LoadTier[]).reduce(
    (acc, tier) => {
      const tm = _tiers[tier];
      const durations = [...tm.samples.map((s) => s.durationMs)].sort((a, b) => a - b);
      acc[tier] = {
        totalRequests: tm.totalRequests,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        lastMs: tm.samples.length > 0 ? tm.samples[tm.samples.length - 1].durationMs : null,
      };
      return acc;
    },
    {} as BrainLoadMetrics['tiers'],
  );

  return { tiers, cache: cacheMetrics };
}

/**
 * Resets all timing windows.
 *
 * Used in tests to isolate timing observations between test cases.
 */
export function resetBrainLoadMetrics(): void {
  for (const tier of [0, 1, 2] as LoadTier[]) {
    _tiers[tier].samples = [];
    _tiers[tier].totalRequests = 0;
  }
}
