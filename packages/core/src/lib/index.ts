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

export {
  detectLanguage,
  grammarPackage,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_LANGUAGES,
  type TreeSitterLanguage,
} from './tree-sitter-languages.js';
