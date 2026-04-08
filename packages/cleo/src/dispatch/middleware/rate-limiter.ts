import type {
  DispatchNext,
  DispatchRequest,
  DispatchResponse,
  Middleware,
  RateLimitMeta,
} from '../types.js';

/**
 * Per-category rate limit thresholds.
 *
 * @remarks
 * Each category (query, mutate, spawn) uses a sliding window algorithm.
 * Requests older than `windowMs` are pruned before checking the count.
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
}

/**
 * Full rate limiting configuration across all categories.
 *
 * @remarks
 * When `enabled` is false, all requests pass through without limit checks.
 */
export interface RateLimitingConfig {
  /** Whether rate limiting is active. */
  enabled: boolean;
  /** Limits for read-only query operations. */
  query: RateLimitConfig;
  /** Limits for mutate (write) operations. */
  mutate: RateLimitConfig;
  /** Limits for spawn (subagent launch) operations. */
  spawn: RateLimitConfig;
}

export const DEFAULT_RATE_LIMITING: RateLimitingConfig = {
  enabled: true,
  query: { maxRequests: 100, windowMs: 60_000 },
  mutate: { maxRequests: 30, windowMs: 60_000 },
  spawn: { maxRequests: 10, windowMs: 60_000 },
};

/**
 * Internal bucket tracking timestamps of requests in the sliding window
 */
interface SlidingWindowBucket {
  timestamps: number[];
}

/**
 * Sliding-window rate limiter for the dispatch pipeline.
 *
 * @remarks
 * Tracks request timestamps per category (query, mutate, spawn) using
 * in-memory sliding window buckets. The `check` method prunes stale
 * timestamps, evaluates the current count, and returns whether the
 * request is allowed along with limit metadata.
 */
export class RateLimiter {
  /** Per-category sliding window buckets. */
  private buckets: Map<string, SlidingWindowBucket> = new Map();
  /** Merged configuration with defaults. */
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

  check(req: DispatchRequest): RateLimitMeta & { allowed: boolean } {
    if (!this.config.enabled) {
      return {
        allowed: true,
        remaining: Infinity,
        limit: Infinity,
        resetMs: 0,
        category: 'disabled',
      };
    }

    const category = this.resolveCategory(req.gateway, req.domain, req.operation);
    const limitConfig = this.getLimitConfig(category);

    const now = Date.now();
    const windowStart = now - limitConfig.windowMs;

    let bucket = this.buckets.get(category);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(category, bucket);
    }

    // Clean up old timestamps
    bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

    const allowed = bucket.timestamps.length < limitConfig.maxRequests;
    if (allowed) {
      bucket.timestamps.push(now);
    }

    const oldest = bucket.timestamps[0] || now;
    const resetMs = Math.max(0, oldest + limitConfig.windowMs - now);

    return {
      allowed,
      remaining: Math.max(0, limitConfig.maxRequests - bucket.timestamps.length),
      limit: limitConfig.maxRequests,
      resetMs,
      category,
    };
  }

  private resolveCategory(
    gateway: string,
    domain: string,
    operation: string,
  ): 'query' | 'mutate' | 'spawn' {
    if (domain === 'orchestrate' && operation === 'spawn') {
      return 'spawn';
    }
    return gateway === 'query' ? 'query' : 'mutate';
  }

  private getLimitConfig(category: 'query' | 'mutate' | 'spawn'): RateLimitConfig {
    return this.config[category];
  }
}

/**
 * Creates a rate limiting middleware for the dispatch pipeline.
 *
 * @remarks
 * Attaches rate limit metadata to every response `_meta.rateLimit` field.
 * When the limit is exceeded, returns an error response with code
 * `E_RATE_LIMIT_EXCEEDED` and HTTP-style exit code 429.
 *
 * @param config - Optional partial config to override defaults
 * @returns Middleware function that enforces rate limits
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from './rate-limiter.js';
 *
 * const limiter = createRateLimiter({ query: { maxRequests: 50, windowMs: 30_000 } });
 * ```
 */
export function createRateLimiter(config?: Partial<RateLimitingConfig>): Middleware {
  const limiter = new RateLimiter(config);

  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    const check = limiter.check(req);

    if (!check.allowed) {
      return {
        meta: {
          gateway: req.gateway,
          domain: req.domain,
          operation: req.operation,
          timestamp: new Date().toISOString(),
          duration_ms: 0,
          source: req.source,
          requestId: req.requestId,
          rateLimit: check,
        },
        success: false,
        error: {
          code: 'E_RATE_LIMIT_EXCEEDED',
          exitCode: 429, // Too Many Requests
          message: `Rate limit exceeded for category: ${check.category}. Please wait ${Math.ceil(check.resetMs / 1000)} seconds.`,
        },
      };
    }

    const response = await next();
    response.meta.rateLimit = {
      limit: check.limit,
      remaining: check.remaining,
      resetMs: check.resetMs,
      category: check.category,
    };

    return response;
  };
}
