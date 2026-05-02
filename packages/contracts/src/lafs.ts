/**
 * LAFS (LLM-Agent-First Schema) unified envelope types.
 *
 * Protocol-level types (`LAFSEnvelope`, `LAFSMeta`, `LAFSError`,
 * `LAFSErrorCategory`, `LAFSTransport`, `LAFSPage*`, `MVILevel`, `Warning`)
 * are owned by `@cleocode/lafs` (ADR-039) and re-exported here so that
 * downstream consumers can import from a single well-known contracts path.
 *
 * Contracts-specific types (`LafsEnvelope`, `LafsSuccess`, `LafsError`,
 * `LafsErrorDetail`, `LafsAlternative`, `GatewayMeta`, `GatewayEnvelope`,
 * `CleoResponse`) are defined here because they represent CLEO's CLI-layer
 * and gateway-layer response contracts that depend on the protocol types but
 * are not part of the LAFS SDK itself.
 *
 * @epic T4654
 * @task T1706
 */

// ---------------------------------------------------------------------------
// Re-export canonical LAFS protocol types from @cleocode/lafs (ADR-039)
// ---------------------------------------------------------------------------

export type {
  LAFSEnvelope,
  LAFSError,
  LAFSErrorCategory,
  LAFSMeta,
  LAFSPage,
  LAFSPageCursor,
  LAFSPageNone,
  LAFSPageOffset,
  LAFSTransport,
  MVILevel,
  Warning,
} from '@cleocode/lafs';

// ---------------------------------------------------------------------------
// Contracts-specific types (not part of the LAFS SDK)
// ---------------------------------------------------------------------------

/** Input for conformance checks. */
export interface FlagInput {
  /** Name of the flag being checked. */
  flag: string;
  /** Value of the flag to validate. */
  value: unknown;
}

/** Conformance report. */
export interface ConformanceReport {
  /** Whether all conformance checks passed. */
  valid: boolean;
  /** List of conformance violation descriptions. */
  violations: string[];
  /** List of non-fatal warning descriptions. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// CLEO-specific error detail (backward compatible)
// ---------------------------------------------------------------------------

/** Actionable alternative the caller can try. */
export interface LafsAlternative {
  /** Description of the alternative action. */
  action: string;
  /** CLI command the caller can run instead. */
  command: string;
}

/** LAFS error detail shared between CLI and gateway. */
export interface LafsErrorDetail {
  /** Stable error code (numeric HTTP status or string identifier). */
  code: number | string;
  /**
   * Optional human-readable error name (e.g. `"NOT_FOUND"`).
   *
   * @defaultValue undefined
   */
  name?: string;
  /** Human-readable error description. */
  message: string;
  /**
   * Suggested fix or recovery action for the caller.
   *
   * @defaultValue undefined
   */
  fix?: string;
  /**
   * Alternative commands the caller can try.
   *
   * @defaultValue undefined
   */
  alternatives?: LafsAlternative[];
  /**
   * Arbitrary key-value pairs with additional error context.
   *
   * @defaultValue undefined
   */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CLI envelope (base) - backward compatible
// ---------------------------------------------------------------------------

/** LAFS success envelope (CLI). */
export interface LafsSuccess<T = unknown> {
  /** Discriminant: always `true` for success envelopes. */
  success: true;
  /** Operation result payload. */
  data: T;
  /**
   * Optional human-readable summary of the operation outcome.
   *
   * @defaultValue undefined
   */
  message?: string;
  /**
   * When `true`, the operation was a no-op (data is unchanged).
   *
   * @defaultValue undefined
   */
  noChange?: boolean;
}

/** LAFS error envelope (CLI). */
export interface LafsError {
  /** Discriminant: always `false` for error envelopes. */
  success: false;
  /** Structured error detail with code, message, and fix guidance. */
  error: LafsErrorDetail;
}

/** CLI envelope union type. */
export type LafsEnvelope<T = unknown> = LafsSuccess<T> | LafsError;

// ---------------------------------------------------------------------------
// Gateway envelope extension (extends LAFSMeta from @cleocode/lafs)
// ---------------------------------------------------------------------------

import type { LAFSMeta } from '@cleocode/lafs';

/**
 * Metadata attached to every gateway response.
 * Extends the canonical LAFSMeta from @cleocode/lafs with CLEO
 * gateway-specific fields.
 *
 * @task T4655
 */
export interface GatewayMeta extends LAFSMeta {
  /** Gateway identifier that processed this request. */
  gateway: string;
  /** CLEO domain that handled the operation (e.g. `"tasks"`, `"session"`). */
  domain: string;
  /** Operation duration in milliseconds. */
  duration_ms: number;
}

/** Gateway success envelope (extends CLI base with _meta). */
export interface GatewaySuccess<T = unknown> extends LafsSuccess<T> {
  /** Gateway-specific metadata including domain and timing. */
  _meta: GatewayMeta;
}

/** Gateway error envelope (extends CLI base with _meta). */
export interface GatewayError extends LafsError {
  /** Gateway-specific metadata including domain and timing. */
  _meta: GatewayMeta;
}

/** Gateway envelope union type. */
export type GatewayEnvelope<T = unknown> = GatewaySuccess<T> | GatewayError;

// ---------------------------------------------------------------------------
// Unified envelope (covers both CLI and Gateway)
// ---------------------------------------------------------------------------

/**
 * Unified CLEO response envelope.
 *
 * Every CLEO response (CLI or Gateway) is a CleoResponse. Gateway responses
 * include the _meta field; CLI responses do not.
 */
export type CleoResponse<T = unknown> = LafsEnvelope<T> | GatewayEnvelope<T>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Type guard for success responses.
 *
 * @typeParam T - The data payload type of the envelope.
 * @param envelope - The envelope to check.
 * @returns `true` if the envelope represents a successful operation.
 *
 * @remarks
 * Narrows a {@link LafsEnvelope} to {@link LafsSuccess} so that `envelope.data`
 * is accessible without additional type assertions.
 *
 * @example
 * ```ts
 * const result: LafsEnvelope<Task[]> = await fetchTasks();
 * if (isLafsSuccess(result)) {
 *   console.log(result.data); // Task[]
 * }
 * ```
 */
export function isLafsSuccess<T>(envelope: LafsEnvelope<T>): envelope is LafsSuccess<T> {
  return envelope.success === true;
}

/**
 * Type guard for error responses.
 *
 * @typeParam T - The data payload type of the envelope.
 * @param envelope - The envelope to check.
 * @returns `true` if the envelope represents a failed operation.
 *
 * @remarks
 * Narrows a {@link LafsEnvelope} to {@link LafsError} so that `envelope.error`
 * is accessible without additional type assertions.
 *
 * @example
 * ```ts
 * const result: LafsEnvelope<Task[]> = await fetchTasks();
 * if (isLafsError(result)) {
 *   console.error(result.error.message);
 * }
 * ```
 */
export function isLafsError<T>(envelope: LafsEnvelope<T>): envelope is LafsError {
  return envelope.success === false;
}

/**
 * Type guard for gateway responses (has _meta).
 *
 * @typeParam T - The data payload type of the envelope.
 * @param envelope - The response to check.
 * @returns `true` if the response includes gateway metadata.
 *
 * @remarks
 * Distinguishes gateway responses from plain CLI responses by checking for the
 * presence of the `_meta` field, which carries gateway-specific routing and timing data.
 *
 * @example
 * ```ts
 * const response: CleoResponse<Task> = await handleRequest();
 * if (isGatewayEnvelope(response)) {
 *   console.log(response._meta.gateway);
 * }
 * ```
 */
export function isGatewayEnvelope<T>(envelope: CleoResponse<T>): envelope is GatewayEnvelope<T> {
  return '_meta' in envelope && envelope._meta !== undefined;
}
