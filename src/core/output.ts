/**
 * LAFS-compliant output formatter for CLEO V2.
 *
 * LAFS (LLM-Agent-First Schema) ensures all CLI output is
 * machine-parseable JSON by default, with optional human-readable modes.
 *
 * @epic T4454
 * @task T4456
 */

import { CleoError } from './errors.js';

/** LAFS envelope for successful responses. */
export interface LafsSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
  noChange?: boolean;
}

/** LAFS envelope for error responses. */
export interface LafsError {
  success: false;
  error: {
    code: number;
    name: string;
    message: string;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}

export type LafsEnvelope<T = unknown> = LafsSuccess<T> | LafsError;

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
