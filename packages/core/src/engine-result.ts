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
 * @task T1725 — unwrap() helper added for ergonomic SDK consumers
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
 * @param options - optional `exitCode`, `details`, `fix`, `alternatives`, `problemDetails`
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
    /** RFC 7807 problem details for structured error reporting. */
    problemDetails?: ProblemDetails;
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
      ...(options?.problemDetails !== undefined ? { problemDetails: options.problemDetails } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// unwrap() — throw-style ergonomic helper for SDK consumers.
// ---------------------------------------------------------------------------

/**
 * Error thrown by {@link unwrap} when an {@link EngineResult} carries a
 * failure. Preserves the full {@link EngineErrorPayload} shape so callers
 * can inspect `code`, `message`, `exitCode`, `details`, `fix`,
 * `alternatives`, and `problemDetails` after catching.
 *
 * @task T1725
 */
export class EngineResultError extends Error {
  /** Machine-readable error code (e.g. `'E_NOT_FOUND'`). */
  readonly code: string;
  /** Numeric process exit code, if present. */
  readonly exitCode?: number;
  /** Structured field-level details, if present. */
  readonly details?: unknown;
  /** Human-readable fix hint, if present. */
  readonly fix?: string;
  /** Alternative actions the caller may take, if present. */
  readonly alternatives?: Array<{ action: string; command: string }>;
  /**
   * RFC 7807 problem details for structured error reporting.
   *
   * @see ProblemDetails
   */
  readonly problemDetails?: ProblemDetails;

  constructor(payload: EngineErrorPayload) {
    super(payload.message);
    this.name = 'EngineResultError';
    this.code = payload.code;
    if (payload.exitCode !== undefined) this.exitCode = payload.exitCode;
    if (payload.details !== undefined) this.details = payload.details;
    if (payload.fix !== undefined) this.fix = payload.fix;
    if (payload.alternatives !== undefined) this.alternatives = payload.alternatives;
    if (payload.problemDetails !== undefined) this.problemDetails = payload.problemDetails;
  }
}

/**
 * Unwrap an {@link EngineResult}, returning the payload data on success or
 * throwing an {@link EngineResultError} (CleoError-shaped) on failure.
 *
 * Intended for public SDK consumers who prefer a throw-style API over the
 * internal discriminated-union pattern. Internal dispatch code SHOULD
 * continue using the `if (result.success)` pattern directly.
 *
 * @param result - an {@link EngineResult} to unwrap
 * @returns the `data` value when `result.success` is `true`
 * @throws {@link EngineResultError} when `result.success` is `false`,
 *         preserving all error fields (`code`, `message`, `exitCode`,
 *         `details`, `fix`, `alternatives`, `problemDetails`).
 *
 * @example
 * ```ts
 * import { unwrap } from '@cleocode/core';
 * const task = unwrap(await engine.getTask(id));
 * ```
 *
 * @task T1725
 */
export function unwrap<T>(result: EngineResult<T>): T {
  if (result.success) {
    return result.data;
  }
  throw new EngineResultError(result.error);
}
