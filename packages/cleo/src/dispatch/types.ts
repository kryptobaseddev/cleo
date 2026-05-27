/**
 * Unified CQRS Dispatch Layer — Shared Types
 *
 * Defines the canonical request/response shapes used by the CLI adapter.
 * Every operation flows through:
 *   DispatchRequest → Middleware → DomainHandler → DispatchResponse
 *
 * @epic T4820
 */

// ---------------------------------------------------------------------------
// Gateway, Tier, CanonicalDomain, CANONICAL_DOMAINS
// ---------------------------------------------------------------------------
// These primitives live in @cleocode/contracts (SSoT — promoted in T9954 /
// Phase 0b of SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832).
// Imported below for internal use (DispatchRequest/DispatchResponseMeta
// reference `Gateway`) AND re-exported so that packages/cleo internal code
// can continue to import from './types.js' without changing every import
// site.

import type { CanonicalDomain, Gateway, Tier } from '@cleocode/contracts';

export { CANONICAL_DOMAINS } from '@cleocode/contracts';
export type { CanonicalDomain, Gateway, Tier };

/** Where the request originated. */
export type Source = 'cli';

// ---------------------------------------------------------------------------
// ParamDef — per-operation parameter descriptor
// ---------------------------------------------------------------------------
// These types live in @cleocode/contracts (SSoT). Re-exported here so that
// packages/cleo internal code can continue to import from './types.js'
// without changing every import site in this package.

export type {
  OperationParams,
  ParamCliDef,
  ParamDef,
  ParamType,
} from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// DispatchRequest
// ---------------------------------------------------------------------------

/**
 * Canonical request shape that the CLI adapter produces.
 *
 * The dispatcher validates this against the OperationRegistry before
 * passing it through the middleware pipeline and into a DomainHandler.
 */
export interface DispatchRequest {
  /** CQRS gateway. */
  gateway: Gateway;
  /** Target domain (canonical name). */
  domain: string;
  /** Domain-specific operation name. */
  operation: string;
  /** Operation parameters (already sanitized by middleware). */
  params?: Record<string, unknown>;
  /** Where this request came from. */
  source: Source;
  /** Unique request identifier for tracing. */
  requestId: string;
  /** Bound session ID, if any. */
  sessionId?: string;
  /** Root session that originated the workflow/saga, if any. */
  originSessionId?: string;
  /** Specific execution instance for this command/step, if any. */
  executionSessionId?: string;
  /** LAFS field selection: filter response data to these fields only. */
  _fields?: string[];
  /** LAFS envelope verbosity. Defaults to 'standard'. 'custom' is server-set via _fields. */
  _mvi?: import('@cleocode/lafs').MVILevel;
}

// ---------------------------------------------------------------------------
// DispatchResponse
// ---------------------------------------------------------------------------

/**
 * Rate limit metadata attached to every response.
 */
export interface RateLimitMeta {
  limit: number;
  remaining: number;
  resetMs: number;
  category: string;
}

/**
 * Structured error shape (LAFS-compatible).
 */
export interface DispatchError {
  /** Machine-readable error code (E_NOT_FOUND, E_VALIDATION_FAILED, …). */
  code: string;
  /** LAFS exit code (1-99). */
  exitCode?: number;
  /** Human-readable message. */
  message: string;
  /** Additional structured details. */
  details?: Record<string, unknown>;
  /** Copy-paste fix command. */
  fix?: string;
  /** Alternative actions the caller can try. */
  alternatives?: Array<{ action: string; command: string }>;
  /** RFC 9457 Problem Details (optional, populated from CleoError.toProblemDetails()). */
  problemDetails?: import('@cleocode/core').ProblemDetails;
}

/**
 * Always-present metadata block on every {@link DispatchResponse}.
 *
 * Extracted as a named interface so consumers (CLI renderers, decorators,
 * envelope-extension pickers) can declare a structurally-typed parameter
 * without resorting to `as unknown as Record<string, unknown>` casts.
 *
 * The `[key: string]: unknown` index signature makes this type assignable
 * to `Record<string, unknown>` in covariant positions, eliminating the
 * T9767 cast-chain anti-pattern at every responseMeta call site.
 *
 * @task T9767
 */
export interface DispatchResponseMeta {
  gateway: Gateway;
  domain: string;
  operation: string;
  timestamp: string;
  duration_ms: number;
  source: Source;
  requestId: string;
  rateLimit?: RateLimitMeta;
  /** Session ID that processed this request (T4959). */
  sessionId?: string;
  /** Root session that originated the workflow/saga. */
  originSessionId?: string;
  /** Specific execution instance for this command/step. */
  executionSessionId?: string;
  /** Preserves protocol-level version for backward compat. */
  version?: string;
  /** Extensible metadata (verification gate info, etc.). */
  [key: string]: unknown;
}

/**
 * Canonical response shape returned by the dispatcher.
 *
 * The CLI adapter translates this into cliOutput() / cliError() + process.exit().
 *
 * `meta` (renamed from `_meta` in ADR-039) is always present and carries the
 * operation, requestId, duration_ms, timestamp, and extensible metadata fields.
 */
export interface DispatchResponse {
  /** Always-present metadata for every dispatch response. */
  meta: DispatchResponseMeta;
  success: boolean;
  data?: unknown;
  page?: import('@cleocode/lafs').LAFSPage;
  partial?: boolean;
  error?: DispatchError;
}

// ---------------------------------------------------------------------------
// DomainHandler
// ---------------------------------------------------------------------------

/**
 * Contract for domain handlers.
 *
 * Each of the 11 target domains (tasks, session, memory, check, pipeline,
 * orchestrate, tools, admin, nexus, sticky, intelligence) implements this interface.
 */
export interface DomainHandler {
  /** Execute a read-only query operation. */
  query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse>;

  /** Execute a state-modifying mutation operation. */
  mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse>;

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Async function that produces a DispatchResponse. */
export type DispatchNext = () => Promise<DispatchResponse>;

/**
 * Middleware function signature.
 *
 * Receives the request and a `next` continuation. Can short-circuit by
 * returning early (e.g., rate-limit exceeded) or modify the request/response.
 */
export type Middleware = (
  request: DispatchRequest,
  next: DispatchNext,
) => Promise<DispatchResponse>;
