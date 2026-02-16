/**
 * LAFS-compliant output formatter for CLEO V2.
 *
 * LAFS (LLM-Agent-First Schema) ensures all CLI output is
 * machine-parseable JSON by default, with optional human-readable modes.
 *
 * Types are re-exported from the canonical source in src/types/lafs.ts.
 *
 * @epic T4454
 * @task T4649
 */

import { CleoError } from './errors.js';
import type { LafsSuccess, LafsError, LafsEnvelope } from '../types/lafs.js';

export type { LafsSuccess, LafsError, LafsEnvelope };

/** Format a successful result as LAFS JSON. */
export function formatSuccess<T>(data: T, message?: string): string {
  const envelope: LafsSuccess<T> = {
    success: true,
    data,
    ...(message && { message }),
  };
  return JSON.stringify(envelope);
}

/** Format an error as LAFS JSON. */
export function formatError(error: CleoError): string {
  return JSON.stringify(error.toJSON());
}

/** Format any result (success or error) as LAFS JSON. */
export function formatOutput<T>(result: T | CleoError): string {
  if (result instanceof CleoError) {
    return formatError(result);
  }
  return formatSuccess(result);
}
