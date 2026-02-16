/**
 * Rate Limiter for CLEO MCP Server
 *
 * Implements sliding window rate limiting per MCP-SERVER-SPECIFICATION Section 13.3:
 * - Query operations: 100/minute (default)
 * - Mutate operations: 30/minute (default)
 * - Spawn operations: 10/minute (default)
 *
 * Uses a sliding window algorithm with per-category tracking.
 * Limits are configurable via MCPConfig.rateLimiting.
 *
 * @task T2916
 */

/**
 * Rate limit configuration for a single category
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/**
 * Complete rate limiting configuration
 */
export interface RateLimitingConfig {
  /** Enable/disable rate limiting globally */
  enabled: boolean;
  /** Limits for query gateway operations */
  query: RateLimitConfig;
  /** Limits for mutate gateway operations */
  mutate: RateLimitConfig;
  /** Limits for spawn operations (orchestrate.spawn) */
  spawn: RateLimitConfig;
}

/**
 * Default rate limiting configuration per Section 13.3
 */
export const DEFAULT_RATE_LIMITING: RateLimitingConfig = {
  enabled: true,
  query: { maxRequests: 100, windowMs: 60_000 },
  mutate: { maxRequests: 30, windowMs: 60_000 },
  spawn: { maxRequests: 10, windowMs: 60_000 },
};

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Requests remaining in the current window */
  remaining: number;
  /** Maximum requests allowed in the window */
  limit: number;
  /** Milliseconds until the window resets */
  resetMs: number;
  /** The category that was checked */
  category: string;
}

/**
 * Internal bucket tracking timestamps of requests in the sliding window
 */
interface SlidingWindowBucket {
  timestamps: number[];
}

/**
 * Sliding window rate limiter
 *
 * Tracks request timestamps per category and rejects requests
 * that exceed the configured limit within the time window.
 */
export class RateLimiter {
  private buckets: Map<string, SlidingWindowBucket> = new Map();
  private config: RateLimitingConfig;

  constructor(config?: Partial<RateLimitingConfig>) {
    this.config = {
      ...DEFAULT_RATE_LIMITING,
      ...config,
      query: { ...DEFAULT_RATE_LIMITING.query, ...config?.query },
      mutate: { ...DEFAULT_RATE_LIMITING.mutate, ...config?.mutate },
      spawn: { ...DEFAULT_RATE_LIMITING.spawn, ...config?.spawn },
    };
  }

  /**
   * Check if a request is allowed and record it if so.
   *
   * @param gateway - The gateway type ('cleo_query' or 'cleo_mutate')
   * @param domain - The domain being accessed
   * @param operation - The operation being performed
   * @returns Rate limit check result with remaining quota
   */
  check(gateway: string, domain: string, operation: string): RateLimitResult {
    if (!this.config.enabled) {
      return {
        allowed: true,
        remaining: Infinity,
        limit: Infinity,
        resetMs: 0,
        category: 'disabled',
      };
    }

    // Determine the rate limit category
    const category = this.resolveCategory(gateway, domain, operation);
    const limitConfig = this.getLimitConfig(category);

    const now = Date.now();
    const windowStart = now - limitConfig.windowMs;

    // Get or create bucket
    const bucket = this.getOrCreateBucket(category);

    // Prune expired timestamps
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

    // Check limit
    if (bucket.timestamps.length >= limitConfig.maxRequests) {
      // Find earliest timestamp to compute reset time
      const earliestInWindow = bucket.timestamps[0];
      const resetMs = earliestInWindow + limitConfig.windowMs - now;

      return {
        allowed: false,
        remaining: 0,
        limit: limitConfig.maxRequests,
        resetMs: Math.max(0, resetMs),
        category,
      };
    }

    // Record this request
    bucket.timestamps.push(now);

    const remaining = limitConfig.maxRequests - bucket.timestamps.length;

    return {
      allowed: true,
      remaining,
      limit: limitConfig.maxRequests,
      resetMs: bucket.timestamps.length > 0
        ? bucket.timestamps[0] + limitConfig.windowMs - now
        : limitConfig.windowMs,
      category,
    };
  }

  /**
   * Get current rate limit status without recording a request.
   */
  peek(gateway: string, domain: string, operation: string): RateLimitResult {
    if (!this.config.enabled) {
      return {
        allowed: true,
        remaining: Infinity,
        limit: Infinity,
        resetMs: 0,
        category: 'disabled',
      };
    }

    const category = this.resolveCategory(gateway, domain, operation);
    const limitConfig = this.getLimitConfig(category);
    const now = Date.now();
    const windowStart = now - limitConfig.windowMs;

    const bucket = this.buckets.get(category);
    if (!bucket) {
      return {
        allowed: true,
        remaining: limitConfig.maxRequests,
        limit: limitConfig.maxRequests,
        resetMs: limitConfig.windowMs,
        category,
      };
    }

    const activeTimestamps = bucket.timestamps.filter((ts) => ts > windowStart);
    const remaining = limitConfig.maxRequests - activeTimestamps.length;

    return {
      allowed: remaining > 0,
      remaining: Math.max(0, remaining),
      limit: limitConfig.maxRequests,
      resetMs: activeTimestamps.length > 0
        ? activeTimestamps[0] + limitConfig.windowMs - now
        : limitConfig.windowMs,
      category,
    };
  }

  /**
   * Reset all rate limit buckets (for testing)
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Reset a specific category bucket (for testing)
   */
  resetCategory(category: string): void {
    this.buckets.delete(category);
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<RateLimitingConfig>): void {
    if (config.enabled !== undefined) this.config.enabled = config.enabled;
    if (config.query) this.config.query = { ...this.config.query, ...config.query };
    if (config.mutate) this.config.mutate = { ...this.config.mutate, ...config.mutate };
    if (config.spawn) this.config.spawn = { ...this.config.spawn, ...config.spawn };
  }

  /**
   * Get current configuration (for diagnostics)
   */
  getConfig(): Readonly<RateLimitingConfig> {
    return { ...this.config };
  }

  /**
   * Resolve the rate limit category for a given request.
   *
   * Spawn operations get their own stricter limit.
   * Everything else is categorized by gateway type.
   */
  private resolveCategory(gateway: string, domain: string, operation: string): string {
    // Spawn operations have their own limit
    if (domain === 'orchestrate' && operation === 'spawn') {
      return 'spawn';
    }

    // Map gateway to category
    if (gateway === 'cleo_query') {
      return 'query';
    }

    return 'mutate';
  }

  /**
   * Get the limit configuration for a category
   */
  private getLimitConfig(category: string): RateLimitConfig {
    switch (category) {
      case 'query':
        return this.config.query;
      case 'mutate':
        return this.config.mutate;
      case 'spawn':
        return this.config.spawn;
      default:
        return this.config.mutate;
    }
  }

  /**
   * Get or create a sliding window bucket for a category
   */
  private getOrCreateBucket(category: string): SlidingWindowBucket {
    let bucket = this.buckets.get(category);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(category, bucket);
    }
    return bucket;
  }
}
