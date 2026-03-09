import { ProtocolEnforcer } from '../../mcp/lib/protocol-enforcement.js';
import type { DispatchRequest, DispatchNext, DispatchResponse, Middleware } from '../types.js';

/**
 * Creates a middleware that enforces protocol compliance.
 *
 * Delegates to ProtocolEnforcer.enforceProtocol() which:
 * - Passes through query operations untouched
 * - Passes through mutate operations that don't require validation
 * - Validates protocol compliance on validated mutate operations after execution
 * - In strict mode, blocks operations with protocol violations (exit codes 60-70)
 */
export function createProtocolEnforcement(strictMode: boolean = true): Middleware {
  const enforcer = new ProtocolEnforcer(strictMode);

  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    const result = await enforcer.enforceProtocol(req, next);

    // enforceProtocol may return a DomainResponse (missing source/requestId on _meta)
    // when it constructs an error response. Ensure _meta has required DispatchResponse fields.
    if (!result._meta.source || !result._meta.requestId) {
      return {
        ...result,
        _meta: {
          ...result._meta,
          source: result._meta.source ?? req.source,
          requestId: result._meta.requestId ?? req.requestId,
        },
      } as DispatchResponse;
    }

    return result as DispatchResponse;
  };
}
