/**
 * Canonical EngineResult type — the single discriminated-union shape used by
 * all SDK return paths, dispatch engines, and CLI domain handlers.
 *
 * Defined here in @cleocode/contracts so it is available to every consumer
 * without creating a dependency on @cleocode/core. @cleocode/core re-exports
 * these types and helpers transparently.
 *
 * @epic T1685 — T-CSL-RESET Wave 1: EngineResult canonicalization
 */

import type { LAFSPage } from '@cleocode/lafs';

// ---------------------------------------------------------------------------
// RFC 9457 Problem Details — canonical definition (moved from core/errors.ts)
// ---------------------------------------------------------------------------

/**
 * RFC 9457 Problem Details object.
 * Structured error representation for API responses.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9457
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type. */
  type: string;
  /** Short human-readable summary of the problem type. */
  title: string;
  /** HTTP status code. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail: string;
  /** URI reference identifying the specific problem instance. */
  instance?: string;
  /** Extension members carrying additional problem information. */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EngineResult — discriminated union
// ---------------------------------------------------------------------------

/**
 * Successful engine result branch — carries `data` and optional `page`.
 *
 * @task T1685 — canonical home moved to contracts
 */
export interface EngineSuccess<T = unknown> {
  readonly success: true;
  readonly data: T;
  readonly page?: LAFSPage;
}

/**
 * Structured engine error payload — carries machine-readable code + human
 * message plus optional exitCode, details, fix hint, alternative actions,
 * and RFC 9457 problem details.
 *
 * @task T1707 — problemDetails field
 * @task T1685 — canonical home moved to contracts
 */
export interface EngineErrorPayload {
  code: string;
  message: string;
  exitCode?: number;
  details?: unknown;
  fix?: string;
  alternatives?: Array<{ action: string; command: string }>;
  /**
   * RFC 9457 problem details for structured error reporting.
   *
   * @see ProblemDetails
   */
  problemDetails?: ProblemDetails;
}

/**
 * Failed engine result branch — carries structured `error`.
 *
 * @task T1685 — canonical home moved to contracts
 */
export interface EngineFailure {
  readonly success: false;
  readonly error: EngineErrorPayload;
}

/**
 * Canonical EngineResult — discriminated union of success and failure.
 *
 * Use `result.success` to narrow:
 * - `true`  → `result.data: T` is present; `result.error` does not exist
 * - `false` → `result.error: EngineErrorPayload` is present; `result.data` does not exist
 *
 * @task T1685 — canonical home moved to contracts
 */
export type EngineResult<T = unknown> = EngineSuccess<T> | EngineFailure;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Construct a successful EngineResult.
 *
 * @param data - the operation's payload
 * @param page - optional pagination metadata
 *
 * @example
 * ```ts
 * import { engineSuccess } from '@cleocode/contracts';
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
 * import { engineError } from '@cleocode/contracts';
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
// unwrap() — throw-style ergonomic helper for SDK consumers
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
  /** RFC 9457 problem details, if present. */
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
 * throwing an {@link EngineResultError} on failure.
 *
 * Intended for public SDK consumers who prefer a throw-style API over the
 * internal discriminated-union pattern. Internal dispatch code SHOULD
 * continue using the `if (result.success)` pattern directly.
 *
 * @param result - an {@link EngineResult} to unwrap
 * @returns the `data` value when `result.success` is `true`
 * @throws {@link EngineResultError} when `result.success` is `false`
 *
 * @example
 * ```ts
 * import { unwrap } from '@cleocode/contracts';
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
