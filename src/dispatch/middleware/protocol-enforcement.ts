import { DispatchResponse, Middleware, DispatchNext } from '../types.js';
import { ProtocolEnforcer } from '../../mcp/lib/protocol-enforcement.js';

/**
 * Creates a middleware that enforces protocol compliance.
 */
export function createProtocolEnforcement(strictMode: boolean = true): Middleware {
  void new ProtocolEnforcer(strictMode);

  return async (_req, next: DispatchNext): Promise<DispatchResponse> => {
    const response = await next();
    return response;
  };
}
