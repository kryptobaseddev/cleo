/**
 * Central Dispatcher -- Routes requests through middleware to domain handlers.
 *
 * The dispatcher is the single entry point for the CLI adapter.
 * It resolves operations, validates parameters, runs the middleware pipeline,
 * and delegates to the appropriate domain handler.
 *
 * Flow: DispatchRequest → resolve → param validation → middleware → handler
 *
 * Operation envelopes are not conversation turns (T12543); dispatch does not
 * schedule dialectic evaluation or open memory stores after returning a result.
 */

import { randomUUID } from 'node:crypto';
import type {
  DispatchRequest,
  DispatchResponse,
  DomainHandler,
  Middleware,
} from '@cleocode/contracts/gateway';
import { createDispatchMeta } from './meta.js';
import { compose } from './pipeline.js';
import { resolve, validateRequiredParams } from './registry.js';

function ensureRequestSessionLineage(request: DispatchRequest): void {
  request.executionSessionId ??=
    process.env.CLEO_EXECUTION_SESSION_ID ?? process.env.CLEO_SESSION_EXECUTION_ID ?? randomUUID();
  request.originSessionId ??=
    process.env.CLEO_ORIGIN_SESSION_ID ??
    process.env.CLEO_SESSION_ORIGIN_ID ??
    request.sessionId ??
    request.executionSessionId;
}

/** Domain handlers and middleware used by the central dispatcher. */
export interface DispatcherConfig {
  handlers: Map<string, DomainHandler>;
  middlewares?: Middleware[];
}

/** Routes validated requests through middleware to their domain handler. */
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
    ensureRequestSessionLineage(request);

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
          request.sessionId,
          request.originSessionId,
          request.executionSessionId,
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
          request.sessionId,
          request.originSessionId,
          request.executionSessionId,
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
          request.sessionId,
          request.originSessionId,
          request.executionSessionId,
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

    // 6. Stamp session identity and lineage (T4959/T10620)
    if (request.sessionId) {
      response.meta.sessionId = request.sessionId;
    }
    if (request.originSessionId) {
      response.meta.originSessionId = request.originSessionId;
    }
    if (request.executionSessionId) {
      response.meta.executionSessionId = request.executionSessionId;
    }

    return response;
  }
}
