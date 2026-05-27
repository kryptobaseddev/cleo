import { sanitizeParams as legacySanitizeParams } from '../lib/security.js';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Creates a middleware that sanitizes incoming request parameters.
 * Uses the canonical sanitization logic from security.ts to handle
 * Task IDs, paths, string lengths, and enum validation.
 *
 * @remarks
 * If sanitization fails (e.g. path traversal detected, invalid task ID format),
 * the middleware short-circuits the pipeline and returns an error response with
 * code `E_VALIDATION_FAILED` (exit code 6). Otherwise, the sanitized params
 * replace the originals on the request object before calling `next()`.
 *
 * @param getProjectRoot - Optional function to resolve the current project root for path sanitization
 * @returns Middleware function that sanitizes request params
 *
 * @example
 * ```typescript
 * import { createSanitizer } from './sanitizer.js';
 *
 * const sanitizer = createSanitizer(() => process.cwd());
 * ```
 */
export function createSanitizer(getProjectRoot?: () => string): Middleware {
  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    if (req.params) {
      try {
        const root = getProjectRoot ? getProjectRoot() : undefined;
        req.params = legacySanitizeParams(req.params, root, {
          domain: req.domain,
          operation: req.operation,
        });
      } catch (error) {
        return {
          meta: {
            gateway: req.gateway,
            domain: req.domain,
            operation: req.operation,
            timestamp: new Date().toISOString(),
            duration_ms: 0,
            source: req.source,
            requestId: req.requestId,
          },
          success: false,
          error: {
            code: 'E_VALIDATION_FAILED',
            exitCode: 6, // VALIDATION_ERROR
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    return next();
  };
}
