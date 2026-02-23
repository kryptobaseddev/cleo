/**
 * Rate Limiter Types - Dispatch layer re-export
 *
 * Re-exports type definitions from the canonical implementation in mcp/lib.
 * Will be replaced with standalone types when mcp/lib is removed.
 */
export type {
  RateLimitConfig,
  RateLimitingConfig,
  RateLimitResult,
} from '../../mcp/lib/rate-limiter.js';
