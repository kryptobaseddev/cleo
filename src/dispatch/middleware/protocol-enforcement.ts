import { DispatchRequest, DispatchResponse, Middleware, DispatchNext } from '../types.js';
import { ProtocolEnforcer, ProtocolType } from '../../mcp/lib/protocol-enforcement.js';

/**
 * Creates a middleware that enforces protocol compliance.
 */
export function createProtocolEnforcement(strictMode: boolean = true): Middleware {
  const enforcer = new ProtocolEnforcer(strictMode);

  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    // Protocol enforcement logic would intercept here
    // Currently passes through to DomainHandler
    const response = await next();
    return response;
  };
}
