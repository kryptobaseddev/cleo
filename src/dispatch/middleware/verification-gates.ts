import { DispatchRequest, DispatchResponse, Middleware, DispatchNext } from '../types.js';
import { createVerificationGate as legacyCreateGate } from '../lib/verification-gates.js';

export function createVerificationGates(strictMode: boolean = true): Middleware {
  const gate = legacyCreateGate(strictMode);

  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    // Map DispatchRequest to legacy OperationContext
    const context = {
      domain: req.domain,
      operation: req.operation,
      gateway: req.gateway === 'query' ? 'cleo_query' as const : 'cleo_mutate' as const,
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
        }
      };
    }

    const response = await next();
    response._meta.verification = result;
    return response;
  };
}
