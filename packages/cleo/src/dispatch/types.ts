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
// Gateway & Source
// ---------------------------------------------------------------------------

/** CQRS gateway: read-only queries vs state-modifying mutations. */
export type Gateway = 'query' | 'mutate';

/** Where the request originated. */
export type Source = 'cli';

/**
 * Progressive disclosure tier.
 * 0 = tasks + session (80% of agents)
 * 1 = + memory + check (15% of agents)
 * 2 = + pipeline + orchestrate + tools + admin + nexus (5%)
 */
export type Tier = 0 | 1 | 2;

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

/**
 * The 15 canonical domain names.
 *
 * T964: `conduit` promoted to first-class domain (supersedes ADR-042 Decision 1).
 * CONDUIT is agent-to-agent messaging and is semantically disjoint from
 * ORCHESTRATE (wave planning + spawn-prompt generation). The original
 * "exactly 10 canonical domains" invariant that justified folding CONDUIT
 * under ORCHESTRATE has been broken multiple times (intelligence, diagnostics,
 * docs, playbook); promoting CONDUIT aligns registry with wire-format, CLI,
 * and core module structure at zero behavior cost.
 */
export const CANONICAL_DOMAINS = [
  'tasks',
  'session',
  'memory',
  'check',
  'pipeline',
  'orchestrate',
  'tools',
  'admin',
  'nexus',
  'sticky',
  'intelligence',
  'diagnostics',
  'docs',
  'playbook',
  'conduit',
] as const;

export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

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
 * Canonical response shape returned by the dispatcher.
 *
 * The CLI adapter translates this into cliOutput() / cliError() + process.exit().
 *
 * `meta` (renamed from `_meta` in ADR-039) is always present and carries the
 * operation, requestId, duration_ms, timestamp, and extensible metadata fields.
 */
export interface DispatchResponse {
  /** Always-present metadata for every dispatch response. */
  meta: {
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
    /** Preserves protocol-level version for backward compat. */
    version?: string;
    /** Extensible metadata (verification gate info, etc.). */
    [key: string]: unknown;
  };
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
