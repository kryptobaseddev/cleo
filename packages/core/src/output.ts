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
import { getCurrentWarningCollector, validateEnvelope } from '@cleocode/lafs';
import { CleoError } from './errors.js';
import {
  getCurrentExecutionSessionId,
  getCurrentOriginSessionId,
  getCurrentSessionId,
} from './sessions/context-alert.js';

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
 * Drain all pending warnings — both the legacy module-global queue (CORE
 * pushWarning) and any active ALS-bound WarningCollector (LAFS pushWarning).
 *
 * @returns Combined warning list, or `undefined` when neither source produced
 *   any entries.
 *
 * @remarks
 * Two carriers must be merged transitionally because:
 * - The legacy `pendingWarnings` array is module-global and race-prone, but
 *   is still used by several deprecation paths (T4669 et al.).
 * - The new {@link import('@cleocode/lafs').WarningCollector} is bound per
 *   request via {@link import('@cleocode/lafs').withWarningCollector} from
 *   the CLI entrypoint (T9769), so it correctly isolates concurrent commands.
 *
 * Subsequent waves of T9763 migrate every legacy producer to the ALS carrier;
 * the legacy queue can be removed once that sweep is complete. Until then,
 * this function is the single source of truth for what lands in
 * `meta.warnings[]`.
 *
 * Exported (T9772) so renderers in `@cleocode/cleo` that build their own
 * envelopes via `cliOutput` / `cliError` (instead of going through
 * `formatSuccess` / `formatError`) can attach queued warnings to `meta.warnings[]`
 * without duplicating the pending-queue state.
 *
 * @task T4669
 * @task T9769
 * @task T9772
 * @epic T9763
 */
export function drainWarnings(): Warning[] | undefined {
  const legacy = pendingWarnings.length > 0 ? pendingWarnings.splice(0) : [];
  const collector = getCurrentWarningCollector();
  const als = collector?.drain() ?? [];

  if (legacy.length === 0 && als.length === 0) return undefined;
  return [...legacy, ...als];
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
  const executionSessionId = getCurrentExecutionSessionId() ?? randomUUID();
  const originSessionId = getCurrentOriginSessionId() ?? sessionId ?? executionSessionId;
  meta['originSessionId'] = originSessionId;
  meta['executionSessionId'] = executionSessionId;
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
/**
 * Validate a canonical CLI envelope under strict mode (CLEO_STRICT_ENVELOPE /
 * CLEO_ENV=ci) and log a structured warning to stderr on violation.
 *
 * Validation uses the same `validateEnvelope` path as the LAFS SDK (native
 * Rust fast-path when available, AJV fallback otherwise). This avoids a
 * blocking throw in production — the envelope is emitted but the process exit
 * code is set to LAFS_VIOLATION (104) so callers can detect failures.
 *
 * The check is gated to avoid the T11292 latency regression noted for the
 * 7-10s CLI startup case. Activate via:
 *   - CLEO_STRICT_ENVELOPE=1 — always validate
 *   - CLEO_ENV=ci             — validate in CI
 *   - NODE_ENV=test           — validate in test
 *
 * @internal
 * @task T11420
 */
function maybeValidateEnvelope(envelope: unknown): void {
  const strict =
    process.env['CLEO_STRICT_ENVELOPE'] === '1' ||
    process.env['CLEO_ENV'] === 'ci' ||
    process.env['NODE_ENV'] === 'test';
  if (!strict) return;

  const result = validateEnvelope(envelope);
  if (!result.valid) {
    // Structured stderr diagnostic (gated to not pollute normal output)
    if (process.env['CLEO_DEBUG'] || process.env['CLEO_STRICT_ENVELOPE'] === '1') {
      process.stderr.write(
        `[lafs-validator] envelope shape violation: ${result.errors.join('; ')}\n`,
      );
    }
    process.exitCode = 104; // ExitCode.LAFS_VIOLATION
  }
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
 * @task T11420
 * @epic T4663
 */
export function formatSuccess<T>(
  data: T,
  message?: string,
  operationOrOpts?: string | FormatOptions,
): string {
  const opts: FormatOptions =
    typeof operationOrOpts === 'string' ? { operation: operationOrOpts } : (operationOrOpts ?? {});

  const baseMeta = createCliMeta(opts.operation ?? 'cli.output');

  // T9393: merge caller-supplied extensions into envelope meta. The `extensions`
  // field has been declared on FormatOptions since T4670 but was never consumed
  // here — silently dropping decorator-stamped fields (e.g. `_nexus`, `deprecated`,
  // measured `duration_ms`) into the void. Canonical fields (operation, requestId,
  // timestamp) are still produced by createCliMeta and listed last so they always
  // win against any extension overrides.
  const meta: CliMeta = {
    ...(opts.extensions ?? {}),
    ...baseMeta,
    operation: baseMeta.operation,
    requestId: baseMeta.requestId,
    timestamp: baseMeta.timestamp,
    // duration_ms is special: extensions wins when caller measured it, otherwise
    // the createCliMeta default (0) is used. Both above spreads handle this —
    // extensions sets it, then baseMeta's 0 only wins if extensions had none.
    duration_ms:
      typeof opts.extensions?.['duration_ms'] === 'number'
        ? (opts.extensions['duration_ms'] as number)
        : baseMeta.duration_ms,
  };

  const envelope: CliEnvelope<T> = {
    success: true,
    data,
    meta: message ? { ...meta, message } : meta,
    ...(opts.page && { page: opts.page }),
  };

  maybeValidateEnvelope(envelope);
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
 * @task T11420
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
  maybeValidateEnvelope(envelope);
  return JSON.stringify(envelope);
}

/** Format any result (success or error) as LAFS JSON. */
export function formatOutput<T>(result: T | CleoError): string {
  if (result instanceof CleoError) {
    return formatError(result);
  }
  return formatSuccess(result);
}
