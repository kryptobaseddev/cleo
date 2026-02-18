/**
 * LAFS-compliant output formatter for CLEO V2.
 *
 * LAFS (LLM-Agent-First Schema) ensures all CLI output is
 * machine-parseable JSON by default, with optional human-readable modes.
 *
 * Types are re-exported from the canonical source in src/types/lafs.ts.
 *
 * @epic T4654
 * @task T4655
 */

import { randomUUID } from 'node:crypto';
import type { LAFSMeta } from '@cleocode/lafs-protocol';
import { CleoError } from './errors.js';
import type { LafsSuccess, LafsError, LafsEnvelope } from '../types/lafs.js';

export type { LafsSuccess, LafsError, LafsEnvelope };

/**
 * Create a LAFS-conformant _meta object for CLI envelopes.
 *
 * @task T4655
 */
function createCliMeta(operation: string): LAFSMeta {
  return {
    specVersion: '1.1.0',
    schemaVersion: '2026.2.1',
    timestamp: new Date().toISOString(),
    operation,
    requestId: randomUUID(),
    transport: 'cli',
    strict: true,
    mvi: 'standard',
    contextVersion: 1,
  };
}

/**
 * Format a successful result as a LAFS-conformant envelope.
 *
 * When `operation` is provided, produces a full LAFSEnvelope with $schema and _meta.
 * When omitted, produces the backward-compatible LafsSuccess shape.
 *
 * @task T4655
 */
export function formatSuccess<T>(data: T, message?: string, operation?: string): string {
  if (operation) {
    // In strict mode, omit optional null fields rather than setting them to null
    const envelope = {
      $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      _meta: createCliMeta(operation),
      success: true as const,
      result: data as Record<string, unknown> | Record<string, unknown>[] | null,
    };
    return JSON.stringify(envelope);
  }

  // Backward compatible: no operation provided
  const envelope: LafsSuccess<T> = {
    success: true,
    data,
    ...(message && { message }),
  };
  return JSON.stringify(envelope);
}

/**
 * Format an error as LAFS JSON.
 *
 * When `operation` is provided, produces a full LAFSEnvelope with $schema and _meta.
 * When omitted, produces the backward-compatible LafsError shape.
 *
 * @task T4655
 */
export function formatError(error: CleoError, operation?: string): string {
  if (operation) {
    // result is required by schema even for errors (set to null)
    // In strict mode, omit optional fields like page
    const envelope = {
      $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      _meta: createCliMeta(operation),
      success: false as const,
      result: null,
      error: error.toLAFSError(),
    };
    return JSON.stringify(envelope);
  }

  // Backward compatible
  return JSON.stringify(error.toJSON());
}

/** Format any result (success or error) as LAFS JSON. */
export function formatOutput<T>(result: T | CleoError): string {
  if (result instanceof CleoError) {
    return formatError(result);
  }
  return formatSuccess(result);
}
