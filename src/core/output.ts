/**
 * LAFS-compliant output formatter for CLEO V2.
 *
 * LAFS (LLM-Agent-First Schema) ensures all CLI output is
 * machine-parseable JSON by default, with optional human-readable modes.
 *
 * All envelopes are now full LAFS-compliant with $schema and _meta.
 * The backward-compatible shape (success + data, no _meta) has been removed.
 *
 * Types are re-exported from the canonical source in src/types/lafs.ts.
 *
 * @epic T4663
 * @task T4672
 */

import { randomUUID } from 'node:crypto';
import type { LAFSMeta, LAFSPage, Warning } from '@cleocode/lafs-protocol';
import { CleoError } from './errors.js';
import { getCurrentSessionId } from './sessions/context-alert.js';
import type { LafsSuccess, LafsError, LafsEnvelope } from '../types/lafs.js';

export type { LafsSuccess, LafsError, LafsEnvelope };

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
}

/**
 * Create a LAFS-conformant _meta object for CLI envelopes.
 * Includes sessionId (T4702) and warnings (T4669) when present.
 *
 * @task T4700
 * @task T4702
 * @epic T4663
 */
function createCliMeta(operation: string): LAFSMeta {
  const warnings = drainWarnings();
  const meta: LAFSMeta = {
    specVersion: '1.2.3',
    schemaVersion: '2026.2.1',
    timestamp: new Date().toISOString(),
    operation,
    requestId: randomUUID(),
    transport: 'cli',
    strict: true,
    mvi: 'standard',
    contextVersion: 1,
    ...(warnings && { warnings }),
  };
  const sessionId = getCurrentSessionId();
  if (sessionId) {
    meta.sessionId = sessionId;
  }
  return meta;
}

/**
 * Format a successful result as a full LAFS-conformant envelope.
 *
 * Always produces the full LAFSEnvelope with $schema and _meta.
 * When operation is omitted, defaults to 'cli.output'.
 * Supports optional page (T4668) and _extensions (T4670).
 *
 * @task T4672
 * @task T4668
 * @task T4670
 * @epic T4663
 */
export function formatSuccess<T>(data: T, message?: string, operationOrOpts?: string | FormatOptions): string {
  const opts: FormatOptions = typeof operationOrOpts === 'string'
    ? { operation: operationOrOpts }
    : operationOrOpts ?? {};

  const envelope: Record<string, unknown> = {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: createCliMeta(opts.operation ?? 'cli.output'),
    success: true as const,
    result: data as Record<string, unknown> | Record<string, unknown>[] | null,
    ...(message && { message }),
  };
  if (opts.page) {
    envelope['page'] = opts.page;
  }
  if (opts.extensions && Object.keys(opts.extensions).length > 0) {
    envelope['_extensions'] = opts.extensions;
  }
  return JSON.stringify(envelope);
}

/**
 * Format an error as a full LAFS-conformant envelope.
 *
 * Always produces the full LAFSEnvelope with $schema and _meta.
 * When operation is omitted, defaults to 'cli.output'.
 *
 * @task T4672
 * @epic T4663
 */
export function formatError(error: CleoError, operation?: string): string {
  const envelope = {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: createCliMeta(operation ?? 'cli.output'),
    success: false as const,
    result: null,
    error: error.toLAFSError(),
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
