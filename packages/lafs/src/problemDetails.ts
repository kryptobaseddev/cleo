/**
 * Core RFC 9457 Problem Details bridge.
 * Converts LAFSError to RFC 9457-compliant Problem Details objects.
 * Available for any transport, not just HTTP.
 */

import { getRegistryCode } from './errorRegistry.js';
import type { LAFSError } from './types.js';

/**
 * RFC 9457 Problem Details with LAFS extensions.
 *
 * @remarks
 * Extends the standard RFC 9457 Problem Details object with LAFS-specific
 * agent-actionable fields. The index signature allows pass-through of
 * additional error details from {@link LAFSError.details}.
 *
 * @example
 * ```typescript
 * const pd: LafsProblemDetails = {
 *   type: "https://lafs.dev/errors/v1/E_VALIDATION",
 *   title: "E_VALIDATION",
 *   status: 400,
 *   detail: "Invalid input",
 *   retryable: false,
 * };
 * ```
 */
export interface LafsProblemDetails {
  /** URI reference identifying the problem type */
  type: string;
  /** Short human-readable summary (typically the error code) */
  title: string;
  /** HTTP status code for this error */
  status: number;
  /** Human-readable explanation of the specific occurrence */
  detail: string;
  /**
   * URI reference identifying the specific occurrence (typically the request ID).
   * @defaultValue `undefined`
   */
  instance?: string;
  /** Whether the operation that caused this error can be retried */
  retryable: boolean;
  /**
   * Recommended agent action (e.g., `"retry"`, `"escalate"`).
   * @defaultValue `undefined`
   */
  agentAction?: string;
  /**
   * Suggested delay in milliseconds before retrying.
   * @defaultValue `undefined`
   */
  retryAfterMs?: number;
  /**
   * Whether the error requires human escalation.
   * @defaultValue `undefined`
   */
  escalationRequired?: boolean;
  /**
   * Human-readable suggestion for resolving the error.
   * @defaultValue `undefined`
   */
  suggestedAction?: string;
  /**
   * Documentation URL for more information.
   * @defaultValue `undefined`
   */
  docUrl?: string;
  /** Pass-through extension members from error details */
  [key: string]: unknown;
}

/**
 * Convert a LAFSError to an RFC 9457 Problem Details object.
 *
 * @param error - The LAFS error to convert
 * @param requestId - Optional request ID to set as the `instance` field
 * @returns An RFC 9457-compliant {@link LafsProblemDetails} object
 *
 * @remarks
 * Uses the error registry for HTTP status and type URI resolution.
 * Agent-actionable fields (`agentAction`, `escalationRequired`, `suggestedAction`,
 * `docUrl`) are mapped from the error when present. Non-empty `error.details`
 * entries are spread as extension members, skipping keys that already exist
 * in the Problem Details object.
 *
 * @example
 * ```typescript
 * import { lafsErrorToProblemDetails } from "@cleocode/lafs";
 *
 * const pd = lafsErrorToProblemDetails(envelope.error!, envelope._meta.requestId);
 * // pd.status === 400, pd.type === "https://lafs.dev/errors/v1/E_VALIDATION"
 * ```
 */
export function lafsErrorToProblemDetails(
  error: LAFSError,
  requestId?: string,
): LafsProblemDetails {
  const registry = getRegistryCode(error.code);

  const pd: LafsProblemDetails = {
    type: `https://lafs.dev/errors/v1/${error.code}`,
    title: error.code,
    status: registry?.httpStatus ?? 500,
    detail: error.message,
    retryable: error.retryable,
  };

  if (requestId) pd.instance = requestId;
  if (error.retryAfterMs != null) pd.retryAfterMs = error.retryAfterMs;

  // Map top-level agent-actionable fields
  if (error.agentAction != null) pd.agentAction = error.agentAction;
  if (error.escalationRequired != null) pd.escalationRequired = error.escalationRequired;
  if (error.suggestedAction != null) pd.suggestedAction = error.suggestedAction;
  if (error.docUrl != null) pd.docUrl = error.docUrl;

  // Spread non-empty details as extension members
  if (error.details && Object.keys(error.details).length > 0) {
    for (const [key, value] of Object.entries(error.details)) {
      if (!(key in pd)) {
        pd[key] = value;
      }
    }
  }

  return pd;
}

/**
 * Content-Type for RFC 9457 Problem Details responses.
 *
 * @remarks
 * Per RFC 9457, Problem Details responses MUST be served with this media type
 * to distinguish them from regular JSON responses.
 */
export const PROBLEM_DETAILS_CONTENT_TYPE = 'application/problem+json' as const;
