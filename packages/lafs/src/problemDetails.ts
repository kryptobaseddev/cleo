/**
 * Core RFC 9457 Problem Details bridge.
 * Converts LAFSError to RFC 9457-compliant Problem Details objects.
 * Available for any transport, not just HTTP.
 */
import type { LAFSError } from './types.js';
import { getRegistryCode } from './errorRegistry.js';

/** RFC 9457 Problem Details with LAFS extensions */
export interface LafsProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  // LAFS agent-actionable extensions
  retryable: boolean;
  agentAction?: string;
  retryAfterMs?: number;
  escalationRequired?: boolean;
  suggestedAction?: string;
  docUrl?: string;
  // Pass-through details
  [key: string]: unknown;
}

/**
 * Convert a LAFSError to an RFC 9457 Problem Details object.
 * Uses the error registry for HTTP status and type URI resolution.
 *
 * Agent-actionable fields (agentAction, escalationRequired, suggestedAction, docUrl)
 * are extracted from error.details if present, enabling forward-compatible extension
 * without requiring LAFSError type changes.
 */
export function lafsErrorToProblemDetails(
  error: LAFSError,
  requestId?: string
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
 */
export const PROBLEM_DETAILS_CONTENT_TYPE = 'application/problem+json' as const;
