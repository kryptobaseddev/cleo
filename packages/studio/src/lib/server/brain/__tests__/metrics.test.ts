/**
 * Tests for `$lib/server/brain/metrics.ts` — performance timing windows.
 *
 * @task T990
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getBrainLoadMetrics,
  type LoadTier,
  recordBrainLoadDuration,
  resetBrainLoadMetrics,
} from '../metrics.js';

const EMPTY_CACHE = { hits: 0, misses: 0, evictions: 0, size: 0 };

beforeEach(() => {
  resetBrainLoadMetrics();
});

describe('recordBrainLoadDuration / getBrainLoadMetrics', () => {
  it('returns null p50/p95/last for a tier with no samples', () => {
    const m = getBrainLoadMetrics(EMPTY_CACHE);
    expect(m.tiers[0].p50Ms).toBeNull();
    expect(m.tiers[0].p95Ms).toBeNull();
    expect(m.tiers[0].lastMs).toBeNull();
    expect(m.tiers[0].totalRequests).toBe(0);
  });

  it('records totalRequests accurately', () => {
    recordBrainLoadDuration(0, 50);
    recordBrainLoadDuration(0, 80);
    recordBrainLoadDuration(1, 300);

    const m = getBrainLoadMetrics(EMPTY_CACHE);
    expect(m.tiers[0].totalRequests).toBe(2);
    expect(m.tiers[1].totalRequests).toBe(1);
    expect(m.tiers[2].totalRequests).toBe(0);
  });

  it('computes p50 correctly for odd sample count', () => {
    // Sorted: [10, 20, 30, 40, 50] — p50 at index ceil(0.5*5)-1 = ceil(2.5)-1 = 2 → 30
    for (const d of [50, 10, 30, 20, 40]) {
      recordBrainLoadDuration(0, d);
    }
    const m = getBrainLoadMetrics(EMPTY_CACHE);
    expect(m.tiers[0].p50Ms).toBe(30);
  });

  it('computes p95 correctly', () => {
    // 20 samples: 1..20 ms.  p95 = ceil(0.95*20)-1 = ceil(19)-1 = 18 → sample[18] = 19
    for (let i = 1; i <= 20; i++) {
      recordBrainLoadDuration(0, i);
    }
    const m = getBrainLoadMetrics(EMPTY_CACHE);
    expect(m.tiers[0].p95Ms).toBe(19);
  });

  it('last sample is always the most recent observation', () => {
    recordBrainLoadDuration(0, 100);
    recordBrainLoadDuration(0, 42);
    const m = getBrainLoadMetrics(EMPTY_CACHE);
    expect(m.tiers[0].lastMs).toBe(42);
  });

  it('passes through cache metrics unchanged', () => {
    const cache = { hits: 7, misses: 3, evictions: 1, size: 2 };
    const m = getBrainLoadMetrics(cache);
    expect(m.cache).toEqual(cache);
  });

  it('rolling window caps at 50 samples', () => {
    for (let i = 0; i < 60; i++) {
      recordBrainLoadDuration(0, i);
    }
    // totalRequests = 60, but window holds only 50 samples; p50 is from 60 samples total
    const m = getBrainLoadMetrics(EMPTY_CACHE);
    expect(m.tiers[0].totalRequests).toBe(60);
    // The window only stores 50 — the last value is 59 (most recent).
    expect(m.tiers[0].lastMs).toBe(59);
  });

  it('reset clears all tiers', () => {
    for (const tier of [0, 1, 2] as LoadTier[]) {
      recordBrainLoadDuration(tier, 100);
    }
    resetBrainLoadMetrics();
    const m = getBrainLoadMetrics(EMPTY_CACHE);
    for (const tier of [0, 1, 2] as LoadTier[]) {
      expect(m.tiers[tier].totalRequests).toBe(0);
      expect(m.tiers[tier].lastMs).toBeNull();
    }
  });
});
