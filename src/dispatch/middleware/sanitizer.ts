import { DispatchRequest, DispatchResponse, Middleware, DispatchNext } from '../types.js';
import { sanitizeParams as legacySanitizeParams } from '../lib/security.js';

/**
 * Creates a middleware that sanitizes incoming request parameters.
 * Uses the canonical sanitization logic from security.ts to handle
 * Task IDs, paths, string lengths, and enum validation.
 *
 * @param getProjectRoot - Optional function to resolve the current project root for path sanitization
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
          _meta: {
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
          }
        };
      }
    }
    
    return next();
  };
}
