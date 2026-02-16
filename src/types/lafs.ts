/**
 * LAFS (LLM-Agent-First Schema) unified envelope types.
 *
 * Single source of truth for all CLEO response shapes. Both CLI and MCP
 * gateways produce responses conforming to these types.
 *
 * CLI responses use the base LafsEnvelope (no _meta).
 * MCP responses extend with GatewayMeta via GatewayEnvelope.
 *
 * @epic T4454
 * @task T4649
 */

// ---------------------------------------------------------------------------
// Shared error detail
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
// CLI envelope (base)
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
// MCP / gateway envelope extension
// ---------------------------------------------------------------------------

/** Metadata attached to every MCP gateway response. */
export interface GatewayMeta {
  gateway: string;
  domain: string;
  operation: string;
  version: string;
  timestamp: string;
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
