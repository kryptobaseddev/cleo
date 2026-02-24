/**
 * LAFS (LLM-Agent-First Schema) unified envelope types.
 *
 * Re-exports canonical types from @cleocode/lafs-protocol and defines
 * CLEO-specific extensions for the MCP gateway layer.
 *
 * CLI responses use the base LafsEnvelope (no _meta).
 * MCP responses extend with GatewayMeta via GatewayEnvelope.
 *
 * @epic T4654
 * @task T4655
 */

// ---------------------------------------------------------------------------
// Re-export canonical LAFS types from the protocol package
// ---------------------------------------------------------------------------

export type {
  LAFSMeta,
  LAFSError,
  LAFSErrorCategory,
  LAFSPage,
  LAFSEnvelope,
  LAFSTransport,
  ConformanceReport,
  FlagInput,
  MVILevel,
} from '@cleocode/lafs-protocol';

// ---------------------------------------------------------------------------
// CLEO-specific error detail (backward compatible)
// ---------------------------------------------------------------------------

/** Actionable alternative the caller can try. */
export interface LafsAlternative {
  action: string;
  command: string;
}

/** LAFS error detail shared between CLI and MCP. */
export interface LafsErrorDetail {
  code: number | string;
  name?: string;
  message: string;
  fix?: string;
  alternatives?: LafsAlternative[];
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CLI envelope (base) - backward compatible
// ---------------------------------------------------------------------------

/** LAFS success envelope (CLI). */
export interface LafsSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
  noChange?: boolean;
}

/** LAFS error envelope (CLI). */
export interface LafsError {
  success: false;
  error: LafsErrorDetail;
}

/** CLI envelope union type. */
export type LafsEnvelope<T = unknown> = LafsSuccess<T> | LafsError;

// ---------------------------------------------------------------------------
// MCP / gateway envelope extension (extends LAFSMeta)
// ---------------------------------------------------------------------------

import type { LAFSMeta } from '@cleocode/lafs-protocol';

/**
 * Metadata attached to every MCP gateway response.
 * Extends the canonical LAFSMeta with CLEO gateway-specific fields.
 *
 * @task T4655
 */
export interface GatewayMeta extends LAFSMeta {
  gateway: string;
  domain: string;
  duration_ms: number;
}

/** MCP success envelope (extends CLI base with _meta). */
export interface GatewaySuccess<T = unknown> extends LafsSuccess<T> {
  _meta: GatewayMeta;
}

/** MCP error envelope (extends CLI base with _meta). */
export interface GatewayError extends LafsError {
  _meta: GatewayMeta;
}

/** MCP envelope union type. */
export type GatewayEnvelope<T = unknown> = GatewaySuccess<T> | GatewayError;

// ---------------------------------------------------------------------------
// Unified envelope (covers both CLI and MCP)
// ---------------------------------------------------------------------------

/**
 * Unified CLEO response envelope.
 *
 * Every CLEO response (CLI or MCP) is a CleoResponse. MCP responses include
 * the _meta field; CLI responses do not.
 */
export type CleoResponse<T = unknown> = LafsEnvelope<T> | GatewayEnvelope<T>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard for success responses. */
export function isLafsSuccess<T>(envelope: LafsEnvelope<T>): envelope is LafsSuccess<T> {
  return envelope.success === true;
}

/** Type guard for error responses. */
export function isLafsError<T>(envelope: LafsEnvelope<T>): envelope is LafsError {
  return envelope.success === false;
}

/** Type guard for MCP gateway responses (has _meta). */
export function isGatewayEnvelope<T>(
  envelope: CleoResponse<T>,
): envelope is GatewayEnvelope<T> {
  return '_meta' in envelope && envelope._meta !== undefined;
}
