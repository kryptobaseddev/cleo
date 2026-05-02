/**
 * Canonical EngineResult type used by dispatch engines and core modules.
 *
 * Discriminated union — `success: true` branch has `data`, `success: false`
 * branch has `error`. This enables type narrowing in dispatch handlers
 * without manual casts (no `as unknown as`, no `result.error?.code` on
 * success branch).
 *
 * @task T5715 — original move from dispatch to core
 * @epic T5701
 * @task T-ENGINE-DISCRIMINATED — refactor to discriminated union (proper
 *       discrimination so success branch cannot have error and vice versa).
 */

import type { LAFSPage } from '@cleocode/lafs';
import type { ProblemDetails } from './errors.js';

export type { ProblemDetails };

/**
 * Successful engine result branch — carries `data` and optional `page`.
 */
export interface EngineSuccess<T = unknown> {
  readonly success: true;
  readonly data: T;
  readonly page?: LAFSPage;
}

/**
 * Structured engine error — carries machine-readable code + human message
 * plus optional exitCode, details, fix hint, alternative actions, and
 * RFC 7807 problem details.
 *
 * @task T1707 — problemDetails field added (RFC 7807 activation)
 */
export interface EngineErrorPayload {
  code: string;
  message: string;
  exitCode?: number;
  details?: unknown;
  fix?: string;
  alternatives?: Array<{ action: string; command: string }>;
  /**
   * RFC 7807 problem details for structured error reporting.
   * Populated when the caller supplies richer diagnostic context.
   *
   * @see ProblemDetails
   * @see https://www.rfc-editor.org/rfc/rfc7807
   */
  problemDetails?: ProblemDetails;
}

/**
 * Failed engine result branch — carries structured `error`.
 */
export interface EngineFailure {
  readonly success: false;
  readonly error: EngineErrorPayload;
}

/**
 * Canonical EngineResult — discriminated union of success and failure.
 */
export type EngineResult<T = unknown> = EngineSuccess<T> | EngineFailure;

// ---------------------------------------------------------------------------
// Constructors — single source of truth for EngineResult construction.
// Lives next to the type definition (DRY) so all callers across packages
// import canonical helpers from @cleocode/core rather than re-implementing.
// ---------------------------------------------------------------------------

/**
 * Construct a successful EngineResult.
 *
 * @param data - the operation's payload
 * @param page - optional pagination metadata
 *
 * @example
 * ```ts
 * import { engineSuccess } from '@cleocode/core';
 * return engineSuccess({ items: [], total: 0 });
 * return engineSuccess(items, { mode: 'offset', limit: 10, offset: 0, total: 100, hasMore: true });
 * ```
 */
export function engineSuccess<T>(data: T, page?: LAFSPage): EngineResult<T> {
  return page ? { success: true, data, page } : { success: true, data };
}

/**
 * Construct a failed EngineResult with structured error.
 *
 * @param code - stable machine-readable error code (e.g. `'E_NOT_FOUND'`)
 * @param message - human-readable error description
 * @param options - optional `exitCode`, `details`, `fix`, `alternatives`
 *
 * @example
 * ```ts
 * import { engineError } from '@cleocode/core';
 * return engineError('E_NOT_FOUND', `Task ${id} not found`, { fix: `cleo show ${id}` });
 * ```
 */
export function engineError<T = unknown>(
  code: string,
  message: string,
  options?: {
    exitCode?: number;
    details?: unknown;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  },
): EngineResult<T> {
  return {
    success: false,
    error: {
      code,
      message,
      ...(options?.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      ...(options?.details !== undefined ? { details: options.details } : {}),
      ...(options?.fix !== undefined ? { fix: options.fix } : {}),
      ...(options?.alternatives ? { alternatives: options.alternatives } : {}),
    },
  };
}
