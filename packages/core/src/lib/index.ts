/**
 * Shared utility primitives for @cleocode/core.
 *
 * These modules are dependency-free and safe to import from any layer
 * without risking circular dependencies or DB coupling.
 *
 * @module lib
 */

export {
  computeDelay,
  type RetryablePredicate,
  type RetryContext,
  type RetryOptions,
  withRetry,
} from './retry.js';
