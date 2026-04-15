/**
 * Telemetry Middleware for CQRS Dispatch Layer.
 *
 * After every operation completes (success or failure), emits a telemetry
 * event to telemetry.db if the user has opted in via `cleo diagnostics enable`.
 *
 * Behaviour:
 *   - Fire-and-forget: errors are swallowed, never blocks the response.
 *   - Opt-out is the DEFAULT: nothing is recorded unless explicitly enabled.
 *   - No params, no output, no user data — only shape/timing/exit-code.
 *
 * @task T624
 */

import { isTelemetryEnabled, recordTelemetryEvent } from '@cleocode/core/internal';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Creates the telemetry middleware.
 * Insert into the middleware pipeline AFTER the terminal handler so it
 * always sees the final response (including duration_ms stamp).
 */
export function createTelemetry(): Middleware {
  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    const startTime = Date.now();
    const response = await next();

    // Fire-and-forget — never awaited, never throws to caller.
    // Wrapping isTelemetryEnabled in try/catch guards against mocked environments
    // where the underlying getPlatformPaths / getCleoHome may not be available.
    try {
      if (isTelemetryEnabled()) {
        const durationMs = response.meta.duration_ms ?? Date.now() - startTime;
        const exitCode = response.success ? 0 : (response.error?.exitCode ?? 1);
        const errorCode = response.error?.code ?? null;

        recordTelemetryEvent({
          domain: req.domain,
          gateway: req.gateway,
          operation: req.operation,
          durationMs,
          exitCode,
          errorCode,
        }).catch(() => {
          // Non-fatal — telemetry failure must never surface to the user
        });
      }
    } catch {
      // Non-fatal: telemetry check must never crash the dispatch pipeline
    }

    return response;
  };
}
