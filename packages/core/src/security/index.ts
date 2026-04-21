/**
 * Security core module — barrel export.
 *
 * Re-exports input sanitization and security utilities from the core layer.
 *
 * @task T5706
 */

export type { RateLimitConfig, RateLimitResult } from './input-sanitization.js';
export {
  ALL_VALID_STATUSES,
  DEFAULT_RATE_LIMITS,
  ensureArray,
  RateLimiter,
  SecurityError,
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
} from './input-sanitization.js';
// Owner-override authentication (T1118 L4)
export type { OverrideValidationResult } from './owner-override-auth.js';
export {
  appendOwnerOverrideAudit,
  DEFAULT_OVERRIDE_MAX_PER_SESSION,
  deliverOverrideWebhook,
  deriveOwnerAuthToken,
  getOverrideCount,
  isAgentRoleForbidden,
  isTtyPresent,
  recordAndCheckOverrideLimit,
  resetOverrideCount,
  validateOwnerOverride,
  verifyOwnerAuthToken,
} from './owner-override-auth.js';
