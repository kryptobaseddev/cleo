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
  code: number | string;
  category: LAFSErrorCategory;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
}

/** LAFS warning. */
export interface Warning {
  code: string;
  message: string;
}

/** LAFS transport metadata. */
export type LAFSTransport = 'mcp' | 'cli' | 'http' | 'sdk';

/** MVI (Minimal Viable Information) level. */
export type MVILevel = 'minimal' | 'standard' | 'full';

/** LAFS page — no pagination. */
export interface LAFSPageNone {
  strategy: 'none';
}

/** LAFS page — offset-based pagination. */
export interface LAFSPageOffset {
  strategy: 'offset';
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/** LAFS page union. */
export type LAFSPage = LAFSPageNone | LAFSPageOffset;

/** LAFS metadata block. */
export interface LAFSMeta {
  transport: LAFSTransport;
  mvi: MVILevel;
  page?: LAFSPage;
  warnings?: Warning[];
  durationMs?: number;
}

/** LAFS envelope (canonical protocol type). */
export interface LAFSEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: LAFSError;
  _meta?: LAFSMeta;
}

/** Flag input for conformance checks. */
export interface FlagInput {
  flag: string;
  value: unknown;
}

/** Conformance report. */
export interface ConformanceReport {
  valid: boolean;
  violations: string[];
  warnings: string[];
}

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
export function isGatewayEnvelope<T>(envelope: CleoResponse<T>): envelope is GatewayEnvelope<T> {
  return '_meta' in envelope && envelope._meta !== undefined;
}
