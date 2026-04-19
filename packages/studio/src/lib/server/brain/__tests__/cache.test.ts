/**
 * Tests for `$lib/server/brain/cache.ts` — LRU cache for Brain graph payloads.
 *
 * All tests run against pure in-memory state with no DB dependency.
 * The {@link clearBrainCache} and {@link resetBrainCacheMetrics} functions are
 * called in `beforeEach` to give every test a clean baseline.
 *
 * @task T990
 */

import type { BrainGraph } from '@cleocode/brain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCacheKey,
  clearBrainCache,
  getBrainCacheMetrics,
  getCachedGraph,
  invalidateBrainCache,
  invalidateCacheKey,
  resetBrainCacheMetrics,
  setCachedGraph,
} from '../cache.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal valid BrainGraph for seeding the cache. */
function makeGraph(nodeCount: number): BrainGraph {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `brain:node-${i}`,
      kind: 'observation' as const,
      substrate: 'brain' as const,
      label: `Node ${i}`,
      weight: 0.5,
      createdAt: new Date().toISOString(),
      meta: {},
    })),
    edges: [],
    counts: {
      nodes: { brain: nodeCount, nexus: 0, tasks: 0, conduit: 0, signaldock: 0 },
      edges: { brain: 0, nexus: 0, tasks: 0, conduit: 0, signaldock: 0, cross: 0 },
    },
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearBrainCache();
  resetBrainCacheMetrics();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------

describe('buildCacheKey', () => {
  it('produces a stable key independent of substrate order', () => {
    const k1 = buildCacheKey({ projectId: 'proj1', substrates: ['nexus', 'brain'], limit: 200 });
    const k2 = buildCacheKey({ projectId: 'proj1', substrates: ['brain', 'nexus'], limit: 200 });
    expect(k1).toBe(k2);
  });

  it('treats undefined substrates as all substrates', () => {
    const keyAll = buildCacheKey({ projectId: 'p', limit: 200 });
    const keyExplicit = buildCacheKey({
      projectId: 'p',
      substrates: ['brain', 'conduit', 'nexus', 'signaldock', 'tasks'],
      limit: 200,
    });
    expect(keyAll).toBe(keyExplicit);
  });

  it('distinguishes different project IDs', () => {
    const k1 = buildCacheKey({ projectId: 'proj-a', limit: 200 });
    const k2 = buildCacheKey({ projectId: 'proj-b', limit: 200 });
    expect(k1).not.toBe(k2);
  });

  it('distinguishes different limits', () => {
    const k1 = buildCacheKey({ projectId: 'p', limit: 200 });
    const k2 = buildCacheKey({ projectId: 'p', limit: 1000 });
    expect(k1).not.toBe(k2);
  });

  it('distinguishes different substrate sets', () => {
    const k1 = buildCacheKey({ projectId: 'p', substrates: ['brain'], limit: 200 });
    const k2 = buildCacheKey({ projectId: 'p', substrates: ['nexus'], limit: 200 });
    expect(k1).not.toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// getCachedGraph / setCachedGraph — basic hit/miss
// ---------------------------------------------------------------------------

describe('getCachedGraph / setCachedGraph', () => {
  it('returns null on a cold miss', () => {
    const result = getCachedGraph('nonexistent-key');
    expect(result).toBeNull();
  });

  it('returns the stored graph on a hit', () => {
    const graph = makeGraph(10);
    const key = buildCacheKey({ projectId: 'proj', limit: 200 });
    setCachedGraph(key, graph);

    const hit = getCachedGraph(key);
    expect(hit).not.toBeNull();
    expect(hit?.nodes).toHaveLength(10);
  });

  it('returns null after TTL expiry', () => {
    vi.useFakeTimers();

    const graph = makeGraph(5);
    const key = buildCacheKey({ projectId: 'proj', limit: 200 });
    setCachedGraph(key, graph);

    // Advance past the 30-second TTL.
    vi.advanceTimersByTime(31_000);

    const result = getCachedGraph(key);
    expect(result).toBeNull();
  });

  it('returns cached graph before TTL expiry', () => {
    vi.useFakeTimers();

    const graph = makeGraph(5);
    const key = buildCacheKey({ projectId: 'proj', limit: 200 });
    setCachedGraph(key, graph);

    // Advance but stay within TTL.
    vi.advanceTimersByTime(25_000);

    const result = getCachedGraph(key);
    expect(result).not.toBeNull();
  });

  it('updates an existing entry in-place without eviction', () => {
    const key = buildCacheKey({ projectId: 'proj', limit: 200 });
    setCachedGraph(key, makeGraph(10));
    setCachedGraph(key, makeGraph(20)); // overwrite

    const hit = getCachedGraph(key);
    expect(hit?.nodes).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction — max 5 entries
// ---------------------------------------------------------------------------

describe('eviction (max 5 entries)', () => {
  it('evicts the oldest entry when the store is full', () => {
    // Fill to capacity.
    for (let i = 0; i < 5; i++) {
      const key = buildCacheKey({ projectId: `proj-${i}`, limit: 200 });
      setCachedGraph(key, makeGraph(i + 1));
    }

    // Insert a 6th entry — should evict proj-0 (the oldest).
    const newKey = buildCacheKey({ projectId: 'proj-new', limit: 200 });
    setCachedGraph(newKey, makeGraph(99));

    const evictedKey = buildCacheKey({ projectId: 'proj-0', limit: 200 });
    expect(getCachedGraph(evictedKey)).toBeNull();

    // The new entry must be present.
    expect(getCachedGraph(newKey)).not.toBeNull();
  });

  it('records one eviction in metrics after overflow', () => {
    for (let i = 0; i < 6; i++) {
      setCachedGraph(buildCacheKey({ projectId: `p${i}`, limit: 200 }), makeGraph(1));
    }
    const metrics = getBrainCacheMetrics();
    expect(metrics.evictions).toBe(1);
  });

  it('keeps at most 5 live entries', () => {
    for (let i = 0; i < 8; i++) {
      setCachedGraph(buildCacheKey({ projectId: `p${i}`, limit: 200 }), makeGraph(1));
    }
    const metrics = getBrainCacheMetrics();
    expect(metrics.size).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

describe('invalidateCacheKey', () => {
  it('removes the targeted entry and leaves others intact', () => {
    const key1 = buildCacheKey({ projectId: 'p1', limit: 200 });
    const key2 = buildCacheKey({ projectId: 'p2', limit: 200 });
    setCachedGraph(key1, makeGraph(1));
    setCachedGraph(key2, makeGraph(2));

    invalidateCacheKey(key1);

    expect(getCachedGraph(key1)).toBeNull();
    expect(getCachedGraph(key2)).not.toBeNull();
  });

  it('is a no-op for non-existent keys', () => {
    expect(() => invalidateCacheKey('does-not-exist')).not.toThrow();
  });
});

describe('invalidateBrainCache (project-scoped)', () => {
  it('removes all entries for the given project', () => {
    const keyA = buildCacheKey({ projectId: 'proj-x', substrates: ['brain'], limit: 200 });
    const keyB = buildCacheKey({ projectId: 'proj-x', substrates: ['nexus'], limit: 1000 });
    const keyC = buildCacheKey({ projectId: 'other-proj', limit: 200 });

    setCachedGraph(keyA, makeGraph(1));
    setCachedGraph(keyB, makeGraph(2));
    setCachedGraph(keyC, makeGraph(3));

    invalidateBrainCache('proj-x');

    expect(getCachedGraph(keyA)).toBeNull();
    expect(getCachedGraph(keyB)).toBeNull();
    // A different project must NOT be affected.
    expect(getCachedGraph(keyC)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('getBrainCacheMetrics', () => {
  it('tracks hits and misses correctly', () => {
    const key = buildCacheKey({ projectId: 'p', limit: 200 });

    getCachedGraph(key); // miss
    setCachedGraph(key, makeGraph(1));
    getCachedGraph(key); // hit
    getCachedGraph(key); // hit
    getCachedGraph('other-key'); // miss

    const m = getBrainCacheMetrics();
    expect(m.hits).toBe(2);
    expect(m.misses).toBe(2);
  });

  it('counts expired entries as misses not hits', () => {
    vi.useFakeTimers();

    const key = buildCacheKey({ projectId: 'p', limit: 200 });
    setCachedGraph(key, makeGraph(1));
    vi.advanceTimersByTime(31_000);
    getCachedGraph(key); // expired → miss

    const m = getBrainCacheMetrics();
    expect(m.hits).toBe(0);
    expect(m.misses).toBe(1);
  });

  it('reports size=0 after clearBrainCache', () => {
    setCachedGraph(buildCacheKey({ projectId: 'p', limit: 200 }), makeGraph(1));
    clearBrainCache();
    expect(getBrainCacheMetrics().size).toBe(0);
  });

  it('resetBrainCacheMetrics zeroes all counters without clearing entries', () => {
    const key = buildCacheKey({ projectId: 'p', limit: 200 });
    setCachedGraph(key, makeGraph(1));
    getCachedGraph(key); // hit
    getCachedGraph('x'); // miss

    resetBrainCacheMetrics();

    const m = getBrainCacheMetrics();
    expect(m.hits).toBe(0);
    expect(m.misses).toBe(0);
    expect(m.evictions).toBe(0);
    // Entry still present after reset.
    expect(getCachedGraph(key)).not.toBeNull();
  });
});
