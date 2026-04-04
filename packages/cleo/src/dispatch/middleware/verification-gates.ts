import { createVerificationGate as legacyCreateGate } from '@cleocode/core/internal';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Creates a middleware that enforces verification gates on task operations.
 *
 * @remarks
 * Maps the dispatch request into a legacy OperationContext and delegates
 * to the core VerificationGate. When verification fails, returns an error
 * response with code `E_VALIDATION_FAILED` (exit code 80, LIFECYCLE_GATE_FAILED).
 * On success, attaches the verification result to the response `_meta.verification`.
 *
 * @param strictMode - When true, blocks operations that fail verification gates
 * @returns Middleware function that enforces verification gates
 *
 * @example
 * ```typescript
 * import { createVerificationGates } from './verification-gates.js';
 *
 * const gates = createVerificationGates(true);
 * ```
 */
export function createVerificationGates(strictMode: boolean = true): Middleware {
  const gate = legacyCreateGate(strictMode);

  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    // Map DispatchRequest to legacy OperationContext
    const context = {
      domain: req.domain,
      operation: req.operation,
      gateway: req.gateway === 'query' ? ('query' as const) : ('mutate' as const),
      params: req.params,
      taskId: (req.params?.taskId as string) || (req.params?.parent as string),
    };

    const result = await gate.verifyOperation(context);

    if (!result.passed) {
      return {
        _meta: {
          gateway: req.gateway,
          domain: req.domain,
          operation: req.operation,
          timestamp: new Date().toISOString(),
          duration_ms: 0,
          source: req.source,
          requestId: req.requestId,
          verification: result,
        },
        success: false,
        error: {
          code: 'E_VALIDATION_FAILED',
          exitCode: 80, // LIFECYCLE_GATE_FAILED
          message: `Verification gate failed at layer ${result.blockedAt}: ${result.summary}`,
          details: { verification: result },
        },
      };
    }

    const response = await next();
    response._meta.verification = result;
    return response;
  };
}
