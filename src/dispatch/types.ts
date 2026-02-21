/**
 * Unified CQRS Dispatch Layer — Shared Types
 *
 * Defines the canonical request/response shapes used by both CLI and MCP
 * adapters. Every operation flows through:
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
export type Source = 'cli' | 'mcp';

/**
 * Progressive disclosure tier.
 * 0 = tasks + session (80% of agents)
 * 1 = + memory + check (15% of agents)
 * 2 = + pipeline + orchestrate + tools + admin + nexus (5%)
 */
export type Tier = 0 | 1 | 2;

/**
 * The 9 canonical domain names.
 */
export const CANONICAL_DOMAINS = [
  'tasks', 'session', 'memory', 'check', 'pipeline',
  'orchestrate', 'tools', 'admin', 'nexus',
] as const;

export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

/**
 * Legacy domain names that alias to canonical domains.
 */
export const LEGACY_DOMAINS = [
  'research', 'validate', 'lifecycle', 'release',
  'skills', 'providers', 'issues', 'system',
] as const;

export type LegacyDomain = (typeof LEGACY_DOMAINS)[number];

/** Any domain name accepted by the dispatcher. */
export type AnyDomain = CanonicalDomain | LegacyDomain;

// ---------------------------------------------------------------------------
// DispatchRequest
// ---------------------------------------------------------------------------

/**
 * Canonical request shape that both CLI and MCP adapters produce.
 *
 * The dispatcher validates this against the OperationRegistry before
 * passing it through the middleware pipeline and into a DomainHandler.
 */
export interface DispatchRequest {
  /** CQRS gateway. */
  gateway: Gateway;
  /** Target domain (canonical name — aliases resolved before dispatch). */
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
  /** LAFS exit code (1-94). */
  exitCode?: number;
  /** Human-readable message. */
  message: string;
  /** Additional structured details. */
  details?: Record<string, unknown>;
  /** Copy-paste fix command. */
  fix?: string;
  /** Alternative actions the caller can try. */
  alternatives?: Array<{ action: string; command: string }>;
}

/**
 * Canonical response shape returned by the dispatcher.
 *
 * Adapters translate this into their wire format:
 * - CLI adapter → cliOutput() / cliError() + process.exit()
 * - MCP adapter → MCP SDK JSON envelope
 */
export interface DispatchResponse {
  _meta: {
    gateway: Gateway;
    domain: string;
    operation: string;
    timestamp: string;
    duration_ms: number;
    source: Source;
    requestId: string;
    rateLimit?: RateLimitMeta;
    /** Preserves MCP-level version for backward compat. */
    version?: string;
    /** Extensible metadata (verification gate info, etc.). */
    [key: string]: unknown;
  };
  success: boolean;
  data?: unknown;
  partial?: boolean;
  error?: DispatchError;
}

// ---------------------------------------------------------------------------
// DomainHandler
// ---------------------------------------------------------------------------

/**
 * Contract for domain handlers.
 *
 * Each of the 9 target domains (tasks, session, memory, check, pipeline,
 * orchestrate, tools, admin, nexus) implements this interface.
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
