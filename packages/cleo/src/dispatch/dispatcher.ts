/**
 * Central Dispatcher -- Routes requests through middleware to domain handlers.
 *
 * The dispatcher is the single entry point for the CLI adapter.
 * It resolves operations, validates parameters, runs the middleware pipeline,
 * and delegates to the appropriate domain handler.
 *
 * Flow: DispatchRequest → resolve → param validation → middleware → handler
 *
 * ## T1088 — Dialectic Evaluator Hook (PSYCHE Wave 3)
 *
 * After each successful mutate operation, the dispatcher fires a background
 * `evaluateDialectic` call via `setImmediate` if all of the following apply:
 *
 *   1. The response indicates `success: true`.
 *   2. The request gateway is `"mutate"` (state-modifying user-facing commands).
 *   3. A `sessionId` is present on the request (identifies conversation context).
 *   4. The in-memory rate limiter allows the evaluation (1 per 10s per session).
 *
 * Errors from the background evaluation are caught and logged at `warn` level
 * so they never affect the caller.
 *
 * @epic T4820
 * @task T1088
 */

import { getLogger, getProjectRoot } from '@cleocode/core';
import { createDispatchMeta } from './lib/meta.js';
import { compose } from './middleware/pipeline.js';
import { resolve, validateRequiredParams } from './registry.js';
import type { DispatchRequest, DispatchResponse, DomainHandler, Middleware } from './types.js';

// ============================================================================
// T1088: In-memory rate limiter for dialectic evaluation
// ============================================================================

/** Rate limit window in milliseconds (1 evaluation per 10 seconds per session). */
const DIALECTIC_RATE_LIMIT_MS = 10_000;

/** In-memory last-evaluation timestamp per session ID. */
const _dialecticLastEvalMs = new Map<string, number>();

/**
 * Check whether a new dialectic evaluation is allowed for a session.
 *
 * Rate limit: 1 evaluation per `DIALECTIC_RATE_LIMIT_MS` per session.
 * Records the timestamp when allowed.
 *
 * @param sessionId - The session to check.
 * @returns `true` when the evaluation is allowed.
 */
function isDialecticEvalAllowed(sessionId: string): boolean {
  const last = _dialecticLastEvalMs.get(sessionId) ?? 0;
  const now = Date.now();
  if (now - last < DIALECTIC_RATE_LIMIT_MS) {
    return false;
  }
  _dialecticLastEvalMs.set(sessionId, now);
  return true;
}

// ============================================================================
// Dispatcher
// ============================================================================

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

    // 7. T1088: Background dialectic evaluation hook
    //
    // Fires asynchronously via setImmediate so the response is returned to the
    // caller immediately.  Conditions:
    //   a) Response was successful
    //   b) This was a mutate (state-modifying, user-facing) operation
    //   c) A session ID is present (needed for narrative + source tagging)
    //   d) Rate limiter allows this session to be evaluated right now
    //
    // The userMessage is synthesised from the operation + params since the
    // raw CLI string is not available at this layer.  Future Wave 4 work can
    // thread the original raw command string through DispatchRequest.
    if (
      response.success &&
      request.gateway === 'mutate' &&
      request.sessionId &&
      isDialecticEvalAllowed(request.sessionId)
    ) {
      const capturedRequest = request;
      const capturedSessionId = request.sessionId;

      setImmediate(() => {
        // Lazy import to avoid loading the evaluator at startup (it pulls in
        // the Vercel AI SDK and zod which add ~50ms to cold start).
        Promise.all([
          import('@cleocode/core/memory/dialectic-evaluator.js'),
          import('@cleocode/core/store/nexus-sqlite.js'),
          import('@cleocode/core/store/memory-sqlite.js'),
        ])
          .then(async ([{ evaluateDialectic, applyInsights }, { getNexusDb }, { getBrainDb }]) => {
            const projectRoot = getProjectRoot();
            const turn = {
              userMessage: `cleo ${capturedRequest.domain} ${capturedRequest.operation} ${JSON.stringify(capturedRequest.params ?? {})}`,
              systemResponse: `Operation succeeded in domain "${capturedRequest.domain}".`,
              activePeerId: (capturedRequest.params?.['peerId'] as string | undefined) ?? 'global',
              sessionId: capturedSessionId,
            };

            const insights = await evaluateDialectic(turn);
            const [nexusDb, brainDb] = await Promise.all([getNexusDb(), getBrainDb()]);
            await applyInsights(insights, nexusDb, brainDb, {
              sessionId: capturedSessionId,
              activePeerId: turn.activePeerId,
              projectRoot,
            });
          })
          .catch((err: unknown) => {
            const log = getLogger('dialectic-hook');
            log.warn({ err }, 'dialectic-evaluator failed');
          });
      });
    }

    return response;
  }
}
