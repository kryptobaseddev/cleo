/**
 * In-memory LRU cache for unified Brain graph payloads.
 *
 * Keyed on a tuple of (projectId, sortedSubstrates, limit) so different
 * substrate-toggle combinations each get their own entry without cross-
 * contaminating one another.
 *
 * Design constraints:
 * - Max 5 entries — the overwhelming majority of sessions use 1–2 projects
 *   with at most 3–4 distinct substrate combos, so 5 covers real-world load
 *   without unbounded memory growth.
 * - 30-second TTL — CLEO's mutation rate is low enough that stale data
 *   is harmless at this window; more aggressive invalidation can be wired
 *   in later by calling {@link invalidateBrainCache} from mutation paths.
 * - Metrics counters (hits/misses/evictions) are exported for `/api/health`.
 *
 * @module
 * @task T990
 */

import type { BrainGraph, BrainSubstrate } from '@cleocode/brain';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of cache entries before oldest is evicted. */
const MAX_ENTRIES = 5;

/** Time-to-live in milliseconds. */
const TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single cache entry with payload and expiry metadata. */
interface CacheEntry {
  /** Cached graph payload. */
  graph: BrainGraph;
  /** Unix ms timestamp at which this entry expires. */
  expiresAt: number;
  /** Insertion order index — used to find the oldest entry on eviction. */
  insertedAt: number;
}

/** Composite cache key components before serialisation. */
export interface CacheKeyParts {
  /** Project identifier from the active session cookie. Empty string = default. */
  projectId: string;
  /**
   * Substrates included in the query. Pass undefined or an empty array
   * to represent "all substrates" (normalised to the full sorted list).
   */
  substrates?: BrainSubstrate[];
  /** Node limit used for the query. */
  limit: number;
}

/** Snapshot of hit/miss/eviction counters for observability. */
export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  /** Current number of live (non-expired) entries. */
  size: number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** All five substrate names in canonical sort order. */
const ALL_SUBSTRATES_SORTED: BrainSubstrate[] = [
  'brain',
  'conduit',
  'nexus',
  'signaldock',
  'tasks',
];

const _store = new Map<string, CacheEntry>();
let _insertionCounter = 0;

const _metrics = {
  hits: 0,
  misses: 0,
  evictions: 0,
};

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a stable string cache key from the provided key parts.
 *
 * Substrate order is normalised (sorted) so callers passing substrates in
 * different orders still hit the same cache slot.
 *
 * @param parts - Key components.
 * @returns Stable string key.
 */
export function buildCacheKey(parts: CacheKeyParts): string {
  const subs =
    !parts.substrates || parts.substrates.length === 0
      ? ALL_SUBSTRATES_SORTED
      : [...parts.substrates].sort();
  return `${parts.projectId}|${subs.join(',')}|${parts.limit}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to retrieve a {@link BrainGraph} from the cache.
 *
 * Returns `null` on a cache miss or when the stored entry has expired.
 * Expired entries are lazily removed on access.
 *
 * @param key - Serialised cache key from {@link buildCacheKey}.
 * @returns Cached graph or `null`.
 */
export function getCachedGraph(key: string): BrainGraph | null {
  const entry = _store.get(key);
  if (!entry) {
    _metrics.misses++;
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    _store.delete(key);
    _metrics.misses++;
    return null;
  }
  _metrics.hits++;
  return entry.graph;
}

/**
 * Stores a {@link BrainGraph} in the cache under the given key.
 *
 * When the store has reached {@link MAX_ENTRIES}, the entry with the lowest
 * `insertedAt` counter (i.e. the oldest insert) is evicted first.
 *
 * @param key - Serialised cache key from {@link buildCacheKey}.
 * @param graph - Graph payload to store.
 */
export function setCachedGraph(key: string, graph: BrainGraph): void {
  // If the key already exists, update in-place (no eviction needed).
  if (!_store.has(key) && _store.size >= MAX_ENTRIES) {
    // Find the oldest entry by insertedAt counter.
    let oldestKey: string | null = null;
    let oldestInsert = Number.POSITIVE_INFINITY;
    for (const [k, v] of _store) {
      if (v.insertedAt < oldestInsert) {
        oldestInsert = v.insertedAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      _store.delete(oldestKey);
      _metrics.evictions++;
    }
  }
  _store.set(key, {
    graph,
    expiresAt: Date.now() + TTL_MS,
    insertedAt: _insertionCounter++,
  });
}

/**
 * Removes a specific cache entry by key.
 *
 * Callers that know a specific project+substrate combo has changed
 * can surgically invalidate just that entry.
 *
 * @param key - Serialised cache key from {@link buildCacheKey}.
 */
export function invalidateCacheKey(key: string): void {
  _store.delete(key);
}

/**
 * Removes all cache entries whose key starts with the given project ID prefix.
 *
 * Use this when a project-level mutation (brain.observe, tasks.add, nexus.analyze)
 * is detected and ALL combos for that project should be purged.
 *
 * @param projectId - Project identifier to purge.
 */
export function invalidateBrainCache(projectId: string): void {
  const prefix = `${projectId}|`;
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) {
      _store.delete(key);
    }
  }
}

/**
 * Clears all entries from the cache.
 *
 * Primarily useful in tests.
 */
export function clearBrainCache(): void {
  _store.clear();
}

/**
 * Returns a snapshot of hit/miss/eviction counters.
 *
 * The `size` field reflects only non-expired entries at the moment of the call
 * (expired entries that have not been lazily removed are excluded from the count
 * for accuracy).
 *
 * @returns {@link CacheMetrics} snapshot.
 */
export function getBrainCacheMetrics(): CacheMetrics {
  const now = Date.now();
  let liveSize = 0;
  for (const entry of _store.values()) {
    if (now <= entry.expiresAt) liveSize++;
  }
  return {
    hits: _metrics.hits,
    misses: _metrics.misses,
    evictions: _metrics.evictions,
    size: liveSize,
  };
}

/**
 * Resets all metric counters.
 *
 * Used in tests to get a clean baseline between suites.
 */
export function resetBrainCacheMetrics(): void {
  _metrics.hits = 0;
  _metrics.misses = 0;
  _metrics.evictions = 0;
}
