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
 * ProtocolEnforcer.enforceProtocol uses the core's proto-shape (`_meta`) while
 * the dispatch layer uses the canonical CLI envelope shape (`meta`). This
 * middleware bridges between the two shapes:
 * - Wraps `next` to map `DispatchResponse.meta` → proto-shape `_meta` for the enforcer
 * - Maps the enforcer's proto-shape result back to `DispatchResponse` (with `meta`)
 * - Ensures `source` and `requestId` are always populated on the returned `meta`
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
    // Bridge DispatchNext (returns DispatchResponse with `meta`) to the proto-shape
    // expected by ProtocolEnforcer (ProtocolResponse with `_meta`).
    const protoNext = async () => {
      const dispatchResult = await next();
      // Map canonical `meta` → proto-shape `_meta` for the enforcer
      const { meta, ...rest } = dispatchResult;
      return { ...rest, _meta: meta };
    };

    const protoResult = await enforcer.enforceProtocol(req, protoNext);

    // Map proto-shape result back to canonical DispatchResponse shape.
    // enforceProtocol may return a minimal proto-response (missing source/requestId)
    // when it constructs an error response — fill those in from the request.
    const { _meta, ...protoRest } = protoResult;
    const responseMeta = {
      ..._meta,
      source: (_meta.source as DispatchResponse['meta']['source']) ?? req.source,
      requestId: (_meta.requestId as string) ?? req.requestId,
    };

    return {
      ...protoRest,
      meta: responseMeta,
    } as DispatchResponse;
  };
}
