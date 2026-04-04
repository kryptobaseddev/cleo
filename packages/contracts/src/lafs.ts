/**
 * LAFS (LLM-Agent-First Schema) unified envelope types.
 *
 * Defines canonical LAFS types inline (contracts has ZERO external dependencies).
 * In the main CLEO codebase these are re-exported from @cleocode/lafs;
 * here they are defined as plain interfaces for maximum portability.
 *
 * @epic T4654
 * @task T4655
 */

// ---------------------------------------------------------------------------
// Canonical LAFS types (inlined from @cleocode/lafs)
// ---------------------------------------------------------------------------

/** LAFS error category. */
export type LAFSErrorCategory =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'authorization'
  | 'internal'
  | 'rate_limit'
  | 'timeout'
  | 'dependency';

/** LAFS error object. */
export interface LAFSError {
  /** Stable error code (numeric HTTP status or string identifier). */
  code: number | string;
  /** High-level error classification category. */
  category: LAFSErrorCategory;
  /** Human-readable error description. */
  message: string;
  /**
   * Suggested fix or recovery action for the caller.
   *
   * @defaultValue undefined
   */
  fix?: string;
  /**
   * Arbitrary key-value pairs with additional error context.
   *
   * @defaultValue undefined
   */
  details?: Record<string, unknown>;
}

/** LAFS warning. */
export interface Warning {
  /** Machine-readable warning code. */
  code: string;
  /** Human-readable warning description. */
  message: string;
}

/** LAFS transport metadata. */
export type LAFSTransport = 'cli' | 'http' | 'sdk';

/** MVI (Minimal Viable Information) level. */
export type MVILevel = 'minimal' | 'standard' | 'full';

/** LAFS page — no pagination. */
export interface LAFSPageNone {
  /** Discriminant indicating no pagination is applied. */
  strategy: 'none';
}

/** LAFS page — offset-based pagination. */
export interface LAFSPageOffset {
  /** Discriminant identifying offset-based pagination. */
  strategy: 'offset';
  /** Zero-based index of the first item in this page. */
  offset: number;
  /** Maximum number of items per page. */
  limit: number;
  /** Total number of items across all pages. */
  total: number;
  /** Whether additional pages exist beyond the current one. */
  hasMore: boolean;
}

/** LAFS page union. */
export type LAFSPage = LAFSPageNone | LAFSPageOffset;

/** LAFS metadata block. */
export interface LAFSMeta {
  /** Transport protocol used for this envelope. */
  transport: LAFSTransport;
  /** Minimum Viable Information level controlling verbosity. */
  mvi: MVILevel;
  /**
   * Pagination metadata when the result is a paginated collection.
   *
   * @defaultValue undefined
   */
  page?: LAFSPage;
  /**
   * Non-fatal warnings to surface to the consuming agent.
   *
   * @defaultValue undefined
   */
  warnings?: Warning[];
  /**
   * Operation duration in milliseconds.
   *
   * @defaultValue undefined
   */
  durationMs?: number;
}

/** LAFS envelope (canonical protocol type). */
export interface LAFSEnvelope<T = unknown> {
  /** Whether the operation completed successfully. */
  success: boolean;
  /**
   * Operation result payload on success.
   *
   * @defaultValue undefined
   */
  data?: T;
  /**
   * Structured error payload on failure.
   *
   * @defaultValue undefined
   */
  error?: LAFSError;
  /**
   * Protocol and transport metadata.
   *
   * @defaultValue undefined
   */
  _meta?: LAFSMeta;
}

/** Flag input for conformance checks. */
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
// Gateway envelope extension (extends LAFSMeta)
// ---------------------------------------------------------------------------

/**
 * Metadata attached to every gateway response.
 * Extends the canonical LAFSMeta with CLEO gateway-specific fields.
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
