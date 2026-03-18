/**
 * Security Hardening and Input Sanitization (Backward-Compat Re-export)
 *
 * Thin wrapper that re-exports from the canonical location at
 * src/core/security/input-sanitization.ts.
 *
 * @task T5706
 */

export type { RateLimitConfig, RateLimitResult } from '@cleocode/core';
export type { SecurityError } from '@cleocode/core';
export {
  ALL_VALID_STATUSES,
  DEFAULT_RATE_LIMITS,
  ensureArray,
  RateLimiter,
  sanitizeContent,
  sanitizeParams,
  sanitizePath,
  sanitizeTaskId,
  VALID_DOMAINS,
  VALID_GATEWAYS,
  VALID_LIFECYCLE_STAGE_STATUSES,
  VALID_MANIFEST_STATUSES,
  VALID_PRIORITIES,
  validateEnum,
} from '@cleocode/core';
