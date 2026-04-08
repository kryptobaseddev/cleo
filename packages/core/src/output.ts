/**
 * LAFS-compliant output formatter for CLEO V2.
 *
 * LAFS (LLM-Agent-First Schema) ensures all CLI output is
 * machine-parseable JSON by default, with optional human-readable modes.
 *
 * All envelopes use the canonical CLI envelope shape:
 *   { success, data?, error?, meta, page? }
 *
 * This replaces the three legacy shapes:
 *   {ok, r, _m}            (minimal MVI — removed)
 *   {$schema, _meta, success, result}  (full LAFS — now uses meta/data)
 *   {success, result}      (observe command — now uses data)
 *
 * Types are re-exported from the canonical source in src/types/lafs.ts.
 *
 * @epic T4663
 * @task T4672
 * @task T338 (ADR-039 envelope unification)
 */

import { randomUUID } from 'node:crypto';
import type { LafsEnvelope, LafsError, LafsSuccess } from '@cleocode/contracts';
import type { CliEnvelope, CliEnvelopeError, CliMeta, LAFSPage, Warning } from '@cleocode/lafs';
import { CleoError } from './errors.js';
import { getCurrentSessionId } from './sessions/context-alert.js';

export type { CliEnvelope, CliEnvelopeError, CliMeta, LafsEnvelope, LafsError, LafsSuccess };

/**
 * Accumulated warnings for the current request.
 * Reset on each formatSuccess/formatError call via drainWarnings().
 *
 * @task T4669
 * @epic T4663
 */
const pendingWarnings: Warning[] = [];

/**
 * Push a deprecation or informational warning into the current envelope.
 * Warnings are drained (consumed) by the next formatSuccess/formatError call.
 *
 * @task T4669
 * @epic T4663
 */
export function pushWarning(warning: Warning): void {
  pendingWarnings.push(warning);
}

/**
 * Drain all pending warnings (returns and clears the queue).
 *
 * @task T4669
 * @epic T4663
 */
function drainWarnings(): Warning[] | undefined {
  if (pendingWarnings.length === 0) return undefined;
  const drained = [...pendingWarnings];
  pendingWarnings.length = 0;
  return drained;
}

/**
 * Options for envelope formatting.
 *
 * @task T4668
 * @task T4670
 * @epic T4663
 */
export interface FormatOptions {
  operation?: string;
  page?: LAFSPage;
  extensions?: Record<string, unknown>;
  /** MVI level to embed in the envelope _meta. Defaults to 'standard'. @task T4957 */
  mvi?: import('@cleocode/lafs').MVILevel;
}

/**
 * Create a canonical `CliMeta` object for CLI envelopes.
 *
 * Includes sessionId (T4702) and warnings (T4669) when present.
 * Drains the pending warnings queue so they are included in the current envelope.
 *
 * @param operation - Dot-delimited operation identifier (e.g. `"tasks.show"`).
 * @param duration_ms - Wall-clock duration in milliseconds. Defaults to 0.
 * @returns A fully populated {@link CliMeta} object.
 *
 * @task T4700
 * @task T4702
 * @task T338
 * @epic T4663
 */
function createCliMeta(operation: string, duration_ms = 0): CliMeta {
  const warnings = drainWarnings();
  const meta: CliMeta = {
    operation,
    requestId: randomUUID(),
    duration_ms,
    timestamp: new Date().toISOString(),
  };
  const sessionId = getCurrentSessionId();
  if (sessionId) {
    meta['sessionId'] = sessionId;
  }
  if (warnings && warnings.length > 0) {
    meta['warnings'] = warnings;
  }
  return meta;
}

/**
 * Format a successful result as a canonical CLI envelope.
 *
 * Produces the unified `CliEnvelope<T>` shape: `{success, data, meta, page?}`.
 * This replaces all three legacy shapes (minimal `{ok,r,_m}`, full `{$schema,_meta,result}`,
 * and observe `{success,result}`) with a single canonical format (ADR-039).
 *
 * The `mvi` option in `FormatOptions` is accepted for backward compatibility but
 * no longer affects the envelope shape — the canonical shape is always emitted.
 *
 * @param data - The operation result payload.
 * @param message - Optional success message (attached to `meta.message`).
 * @param operationOrOpts - Operation name string or `FormatOptions` object.
 * @returns JSON-serialized `CliEnvelope<T>`.
 *
 * @task T4672
 * @task T4668
 * @task T4670
 * @task T338
 * @epic T4663
 */
export function formatSuccess<T>(
  data: T,
  message?: string,
  operationOrOpts?: string | FormatOptions,
): string {
  const opts: FormatOptions =
    typeof operationOrOpts === 'string' ? { operation: operationOrOpts } : (operationOrOpts ?? {});

  const meta = createCliMeta(opts.operation ?? 'cli.output');

  const envelope: CliEnvelope<T> = {
    success: true,
    data,
    meta: message ? { ...meta, message } : meta,
    ...(opts.page && { page: opts.page }),
  };

  return JSON.stringify(envelope);
}

/**
 * Format an error as a canonical CLI error envelope.
 *
 * Produces `{success: false, error: CliEnvelopeError, meta: CliMeta}`.
 * Every error envelope now always includes `meta` (ADR-039).
 * When operation is omitted, defaults to `'cli.output'`.
 *
 * @param error - The `CleoError` to format.
 * @param operation - Optional dot-delimited operation identifier.
 * @returns JSON-serialized error `CliEnvelope`.
 *
 * @task T4672
 * @task T338
 * @epic T4663
 */
export function formatError(error: CleoError, operation?: string): string {
  const lafsError = error.toLAFSError();
  const errorObj: CliEnvelopeError = {
    code: lafsError.code,
    message: lafsError.message,
    details: lafsError.details,
  };
  if ('category' in lafsError && lafsError.category) {
    (errorObj as Record<string, unknown>)['category'] = lafsError.category;
  }
  if ('retryable' in lafsError) {
    (errorObj as Record<string, unknown>)['retryable'] = lafsError.retryable;
  }
  if ('agentAction' in lafsError && lafsError.agentAction) {
    (errorObj as Record<string, unknown>)['agentAction'] = lafsError.agentAction;
  }
  const envelope: CliEnvelope<null> = {
    success: false,
    error: errorObj,
    meta: createCliMeta(operation ?? 'cli.output'),
  };
  return JSON.stringify(envelope);
}

/** Format any result (success or error) as LAFS JSON. */
export function formatOutput<T>(result: T | CleoError): string {
  if (result instanceof CleoError) {
    return formatError(result);
  }
  return formatSuccess(result);
}
