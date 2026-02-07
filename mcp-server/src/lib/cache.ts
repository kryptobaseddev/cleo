/**
 * In-memory query cache for CLEO MCP Server
 *
 * Caches cleo_query responses with configurable TTL.
 * Cache key = domain + operation + hash(params).
 * Invalidated on any cleo_mutate operation for the relevant domain.
 *
 * @task T3145
 */

import { createHash } from 'crypto';

/**
 * Single cache entry with expiration tracking
 */
interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  domains: Record<string, number>;
}

/**
 * Query cache with per-domain invalidation
 */
export class QueryCache {
  private store: Map<string, CacheEntry> = new Map();
  private domainKeys: Map<string, Set<string>> = new Map();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    domains: {},
  };
  private ttl: number;
  private enabled: boolean;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number = 30000, enabled: boolean = true) {
    this.ttl = ttlMs;
    this.enabled = enabled;

    // Periodic cleanup of expired entries every TTL interval
    if (enabled && ttlMs > 0) {
      this.cleanupTimer = setInterval(() => this.evictExpired(), ttlMs);
      // Allow Node to exit even if timer is running
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  /**
   * Build cache key from domain, operation, and params
   */
  buildKey(domain: string, operation: string, params?: Record<string, unknown>): string {
    const paramsHash = params
      ? createHash('md5').update(JSON.stringify(sortObject(params))).digest('hex').slice(0, 12)
      : 'no-params';
    return `${domain}:${operation}:${paramsHash}`;
  }

  /**
   * Get cached value, or undefined if not found/expired
   */
  get<T = unknown>(domain: string, operation: string, params?: Record<string, unknown>): T | undefined {
    if (!this.enabled) {
      this.stats.misses++;
      return undefined;
    }

    const key = this.buildKey(domain, operation, params);
    const entry = this.store.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL expiration
    if (Date.now() > entry.expiresAt) {
      this.delete(key, domain);
      this.stats.misses++;
      this.stats.evictions++;
      return undefined;
    }

    this.stats.hits++;
    return entry.value as T;
  }

  /**
   * Store a value in the cache
   */
  set<T = unknown>(domain: string, operation: string, params: Record<string, unknown> | undefined, value: T): void {
    if (!this.enabled || this.ttl <= 0) {
      return;
    }

    const key = this.buildKey(domain, operation, params);
    const now = Date.now();

    this.store.set(key, {
      value,
      expiresAt: now + this.ttl,
      createdAt: now,
    });

    // Track key under its domain for bulk invalidation
    if (!this.domainKeys.has(domain)) {
      this.domainKeys.set(domain, new Set());
    }
    this.domainKeys.get(domain)!.add(key);

    // Update stats
    this.stats.size = this.store.size;
    this.stats.domains[domain] = this.domainKeys.get(domain)!.size;
  }

  /**
   * Invalidate all cached entries for a domain
   *
   * Called on any cleo_mutate operation to ensure consistency.
   */
  invalidateDomain(domain: string): number {
    const keys = this.domainKeys.get(domain);
    if (!keys || keys.size === 0) {
      return 0;
    }

    const count = keys.size;
    for (const key of keys) {
      this.store.delete(key);
    }
    keys.clear();

    this.stats.evictions += count;
    this.stats.size = this.store.size;
    this.stats.domains[domain] = 0;

    return count;
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const count = this.store.size;
    this.store.clear();
    this.domainKeys.clear();
    this.stats.evictions += count;
    this.stats.size = 0;
    this.stats.domains = {};
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats, size: this.store.size };
  }

  /**
   * Reset statistics counters
   */
  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
  }

  /**
   * Evict all expired entries
   */
  evictExpired(): number {
    const now = Date.now();
    let count = 0;

    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        // Find the domain for this key
        const domain = key.split(':')[0];
        this.delete(key, domain);
        count++;
      }
    }

    if (count > 0) {
      this.stats.evictions += count;
    }

    return count;
  }

  /**
   * Stop the cleanup timer (call on shutdown)
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
  }

  /**
   * Check if cache is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Delete a single key and update domain tracking
   */
  private delete(key: string, domain: string): void {
    this.store.delete(key);
    const keys = this.domainKeys.get(domain);
    if (keys) {
      keys.delete(key);
      this.stats.domains[domain] = keys.size;
    }
    this.stats.size = this.store.size;
  }
}

/**
 * Sort object keys recursively for deterministic hashing
 */
function sortObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      sorted[key] = sortObject(val as Record<string, unknown>);
    } else {
      sorted[key] = val;
    }
  }
  return sorted;
}
