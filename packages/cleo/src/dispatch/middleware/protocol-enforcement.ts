import { ProtocolEnforcer } from '@cleocode/core/internal';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Creates a middleware that enforces protocol compliance.
 *
 * Delegates to ProtocolEnforcer.enforceProtocol() which:
 * - Passes through query operations untouched
 * - Passes through mutate operations that don't require validation
 * - Validates protocol compliance on validated mutate operations after execution
 * - In strict mode, blocks operations with protocol violations (exit codes 60-70)
 *
 * @remarks
 * The middleware ensures that DispatchResponse `_meta` fields (source, requestId)
 * are always populated, even when ProtocolEnforcer returns a DomainResponse that
 * lacks them. This prevents downstream consumers from encountering undefined values.
 *
 * @param strictMode - When true, blocks operations that violate protocol rules
 * @returns Middleware function that enforces protocol compliance
 *
 * @example
 * ```typescript
 * import { createProtocolEnforcement } from './protocol-enforcement.js';
 *
 * const enforcement = createProtocolEnforcement(true);
 * ```
 */
export function createProtocolEnforcement(strictMode: boolean = true): Middleware {
  const enforcer = new ProtocolEnforcer(strictMode);

  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    const result = await enforcer.enforceProtocol(req, next);

    // enforceProtocol may return a DomainResponse (missing source/requestId on _meta)
    // when it constructs an error response. Ensure _meta has required DispatchResponse fields.
    if (!result.meta.source || !result.meta.requestId) {
      return {
        ...result,
        meta: {
          ...result._meta,
          source: result.meta.source ?? req.source,
          requestId: result.meta.requestId ?? req.requestId,
        },
      } as DispatchResponse;
    }

    return result as DispatchResponse;
  };
}
