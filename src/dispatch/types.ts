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

// ---------------------------------------------------------------------------
// ParamDef — per-operation parameter descriptor
// ---------------------------------------------------------------------------

/**
 * The concrete value types a parameter can carry at runtime.
 * Drives JSON Schema `type` and Commander argument/option parsing.
 */
export type ParamType = 'string' | 'number' | 'boolean' | 'array';

/**
 * CLI-specific decoration for a parameter.
 * All fields are optional — omit the entire `cli` key for MCP-only params.
 */
export interface ParamCliDef {
  /**
   * When true, registers as `.argument('<name>')` (positional).
   * When false or omitted, registers as `.option('--name <value>')`.
   * @default false
   */
  positional?: boolean;

  /**
   * Short flag alias, e.g. `'-t'` for `--type`, `'-s'` for `--status`.
   * Only meaningful when `positional` is false/omitted.
   */
  short?: string;

  /**
   * Override the CLI flag name when it differs from the param's `name`.
   * e.g. `name: 'includeArchive'` but `flag: 'include-archive'`
   * Defaults to kebab-case of `name`.
   */
  flag?: string;

  /**
   * For array-type params on the CLI: when true the option can be repeated.
   * When false/omitted, the CLI accepts a single comma-separated string.
   * @default false
   */
  variadic?: boolean;

  /**
   * Custom parse function applied by Commander (e.g. `parseInt`).
   */
  parse?: (value: string) => unknown;
}

/**
 * MCP-specific decoration for a parameter.
 * All fields are optional — omit the entire `mcp` key for CLI-only params.
 */
export interface ParamMcpDef {
  /**
   * When true, the parameter is excluded from the generated MCP `input_schema`.
   * Use for CLI-only params (e.g. `--dry-run`, `--offset`).
   * @default false
   */
  hidden?: boolean;

  /**
   * JSON Schema `enum` constraint for this parameter.
   */
  enum?: readonly string[];
}

/**
 * A fully-described parameter definition.
 *
 * One `ParamDef` entry drives:
 *  - Commander: `.argument()` (positional) or `.option()` (flag)
 *  - MCP: a JSON Schema property with `type`, `description`, and optionally `enum`
 */
export interface ParamDef {
  /** Canonical camelCase parameter name (matches the key in `params` dict). */
  name: string;

  /** Runtime value type. Drives JSON Schema `type` and Commander parsing. */
  type: ParamType;

  /**
   * When true:
   *  - Commander: positional argument (`<name>` or `[name]`)
   *  - MCP: included in `required[]` array of the input_schema
   */
  required: boolean;

  /** Human-readable description used in Commander help text and MCP tool docs. */
  description: string;

  /** CLI-specific metadata. Omit entire key if this param has no CLI surface. */
  cli?: ParamCliDef;

  /** MCP-specific metadata. Omit entire key if this param has no MCP surface. */
  mcp?: ParamMcpDef;
}

/**
 * The 9 canonical domain names.
 */
export const CANONICAL_DOMAINS = [
  'tasks', 'session', 'memory', 'check', 'pipeline',
  'orchestrate', 'tools', 'admin', 'nexus',
] as const;

export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

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
  _mvi?: import('@cleocode/lafs-protocol').MVILevel;
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
    /** Session ID that processed this request (T4959). */
    sessionId?: string;
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
