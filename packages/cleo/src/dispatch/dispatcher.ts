/**
 * Central Dispatcher -- Routes requests through middleware to domain handlers.
 *
 * The dispatcher is the single entry point for the CLI adapter.
 * It resolves operations, validates parameters, runs the middleware pipeline,
 * and delegates to the appropriate domain handler.
 *
 * Flow: DispatchRequest → resolve → param validation → middleware → handler
 *
 * @epic T4820
 */

import { createDispatchMeta } from './lib/meta.js';
import { compose } from './middleware/pipeline.js';
import { resolve, validateRequiredParams } from './registry.js';
import type { DispatchRequest, DispatchResponse, DomainHandler, Middleware } from './types.js';

export interface DispatcherConfig {
  handlers: Map<string, DomainHandler>;
  middlewares?: Middleware[];
}

export class Dispatcher {
  private handlers: Map<string, DomainHandler>;
  private pipeline: Middleware;

  constructor(config: DispatcherConfig) {
    this.handlers = config.handlers;
    this.pipeline = config.middlewares?.length
      ? compose(config.middlewares)
      : (_req, next) => next();
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    const startTime = Date.now();

    // 1. Resolve operation from registry
    const resolved = resolve(request.gateway, request.domain, request.operation);
    if (!resolved) {
      return {
        meta: createDispatchMeta(
          request.gateway,
          request.domain,
          request.operation,
          startTime,
          request.source,
          request.requestId,
        ),
        success: false,
        error: {
          code: 'E_INVALID_OPERATION',
          message: `Unknown operation: ${request.gateway}:${request.domain}.${request.operation}`,
        },
      };
    }

    // 2. Validate required params
    const missing = validateRequiredParams(resolved.def, request.params);
    if (missing.length > 0) {
      return {
        meta: createDispatchMeta(
          request.gateway,
          resolved.domain,
          resolved.operation,
          startTime,
          request.source,
          request.requestId,
        ),
        success: false,
        error: {
          code: 'E_MISSING_PARAMS',
          message: `Missing required parameters: ${missing.join(', ')}`,
          details: { missing },
        },
      };
    }

    // 3. Look up domain handler
    const handler = this.handlers.get(resolved.domain);
    if (!handler) {
      return {
        meta: createDispatchMeta(
          request.gateway,
          resolved.domain,
          resolved.operation,
          startTime,
          request.source,
          request.requestId,
        ),
        success: false,
        error: {
          code: 'E_NO_HANDLER',
          message: `No handler for domain: ${resolved.domain}`,
        },
      };
    }

    // 4. Run middleware pipeline with terminal handler
    const terminal = async (): Promise<DispatchResponse> => {
      if (request.gateway === 'query') {
        return handler.query(resolved.operation, request.params);
      } else {
        return handler.mutate(resolved.operation, request.params);
      }
    };

    const response = await this.pipeline(request, terminal);

    // 5. Stamp timing and tracing metadata
    response.meta.duration_ms = Date.now() - startTime;
    response.meta.requestId = request.requestId;
    response.meta.source = request.source;

    // 6. Stamp session identity (T4959)
    if (request.sessionId) {
      response.meta.sessionId = request.sessionId;
    }

    return response;
  }
}
