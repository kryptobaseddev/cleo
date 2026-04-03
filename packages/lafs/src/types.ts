/**
 * Transport protocol used to deliver a LAFS envelope.
 *
 * @remarks
 * Each transport maps to different serialization and error-code conventions
 * (HTTP status codes, gRPC status codes, CLI exit codes). The `sdk` transport
 * is used for in-process calls where no network boundary is crossed.
 */
export type LAFSTransport = 'cli' | 'http' | 'grpc' | 'sdk';

/**
 * Classification category for a LAFS error.
 *
 * @remarks
 * Categories drive the default `agentAction` recommendation via
 * {@link CATEGORY_ACTION_MAP} in `envelope.ts`. They are also used for
 * telemetry grouping and dashboard filtering.
 */
export type LAFSErrorCategory =
  | 'VALIDATION'
  | 'AUTH'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT'
  | 'TRANSIENT'
  | 'INTERNAL'
  | 'CONTRACT'
  | 'MIGRATION';

/**
 * A non-fatal warning attached to a LAFS envelope's `_meta.warnings` array.
 *
 * @remarks
 * Warnings inform the consuming agent about deprecations, upcoming removals,
 * or soft policy violations without failing the request. Agents SHOULD log
 * warnings and surface them during development but MUST NOT treat them as errors.
 */
export interface Warning {
  /** Machine-readable warning code (e.g. `"W_DEPRECATED_FIELD"`). */
  code: string;
  /** Human-readable description of the warning. */
  message: string;
  /**
   * Name of the deprecated field, parameter, or feature.
   *
   * @defaultValue undefined
   */
  deprecated?: string;
  /**
   * Recommended replacement for the deprecated item.
   *
   * @defaultValue undefined
   */
  replacement?: string;
  /**
   * Semver version or ISO date after which the deprecated item will be removed.
   *
   * @defaultValue undefined
   */
  removeBy?: string;
}

/**
 * Minimum Viable Information level controlling envelope verbosity.
 *
 * @remarks
 * - `minimal` - Only essential fields; smallest token footprint.
 * - `standard` - Default level with all required fields populated.
 * - `full` - Includes all optional metadata (warnings, extensions, ledger).
 * - `custom` - Caller-defined subset; requires explicit field selection.
 */
export type MVILevel = 'minimal' | 'standard' | 'full' | 'custom';

/**
 * Immutable set of all valid {@link MVILevel} values.
 *
 * @remarks
 * Used by {@link isMVILevel} for runtime validation. Being a `ReadonlySet`
 * prevents accidental mutation of the canonical level list.
 *
 * @example
 * ```ts
 * if (MVI_LEVELS.has(input)) {
 *   // input is a valid MVILevel
 * }
 * ```
 */
export const MVI_LEVELS: ReadonlySet<MVILevel> = new Set<MVILevel>([
  'minimal',
  'standard',
  'full',
  'custom',
]);

/**
 * Type guard that checks whether an unknown value is a valid {@link MVILevel}.
 *
 * @param value - The value to test.
 * @returns `true` if `value` is one of the recognised MVI level strings.
 *
 * @remarks
 * Performs a string type check followed by a set membership lookup against
 * {@link MVI_LEVELS}. Safe to call with any input type.
 *
 * @example
 * ```ts
 * const level: unknown = 'minimal';
 * if (isMVILevel(level)) {
 *   // level is narrowed to MVILevel
 * }
 * ```
 */
export function isMVILevel(value: unknown): value is MVILevel {
  return typeof value === 'string' && MVI_LEVELS.has(value as MVILevel);
}

/**
 * Metadata block (`_meta`) embedded in every LAFS envelope.
 *
 * @remarks
 * The meta block carries protocol versioning, transport info, and tracing
 * identifiers that allow agents to correlate requests across multi-step
 * workflows. Fields like `strict` and `mvi` control envelope validation
 * and verbosity behaviour.
 */
export interface LAFSMeta {
  /** Semantic version of the LAFS protocol specification (e.g. `"1.0.0"`). */
  specVersion: string;
  /** Semantic version of the JSON Schema used for this envelope (e.g. `"1.0.0"`). */
  schemaVersion: string;
  /** ISO 8601 timestamp of when the envelope was created. */
  timestamp: string;
  /** Dot-delimited operation identifier (e.g. `"tasks.list"`). */
  operation: string;
  /** Unique identifier for correlating this request/response pair. */
  requestId: string;
  /** Transport protocol through which this envelope is delivered. */
  transport: LAFSTransport;
  /** When `true`, schema validation rejects unknown properties. */
  strict: boolean;
  /** Minimum Viable Information level controlling field inclusion. */
  mvi: MVILevel;
  /** Monotonically increasing version of the agent's context ledger. */
  contextVersion: number;
  /**
   * Session identifier for correlating multi-step agent workflows.
   *
   * @defaultValue undefined
   */
  sessionId?: string;
  /**
   * Non-fatal warnings to surface to the consuming agent.
   *
   * @defaultValue undefined
   */
  warnings?: Warning[];
}

/**
 * Recommended action an LLM agent should take in response to an error.
 *
 * @remarks
 * Agent actions are attached to {@link LAFSError.agentAction} and provide
 * machine-actionable recovery guidance. The default action for a given error
 * is derived from its {@link LAFSErrorCategory} via the category-action map.
 *
 * - `retry` - Repeat the same request (transient failure).
 * - `retry_modified` - Modify input and retry (validation / conflict).
 * - `escalate` - Hand off to a human or higher-privilege agent.
 * - `stop` - Cease the current workflow; recovery is not possible.
 * - `wait` - Back off and retry after a delay (rate limiting).
 * - `refresh_context` - Reload stale context before retrying.
 * - `authenticate` - Acquire or refresh credentials.
 */
export type LAFSAgentAction =
  | 'retry'
  | 'retry_modified'
  | 'escalate'
  | 'stop'
  | 'wait'
  | 'refresh_context'
  | 'authenticate';

/**
 * Immutable set of all valid {@link LAFSAgentAction} values.
 *
 * @remarks
 * Used by {@link isAgentAction} for runtime validation. Being a `ReadonlySet`
 * prevents accidental mutation of the canonical action list.
 *
 * @example
 * ```ts
 * if (AGENT_ACTIONS.has(action)) {
 *   // action is a valid LAFSAgentAction
 * }
 * ```
 */
export const AGENT_ACTIONS: ReadonlySet<LAFSAgentAction> = new Set<LAFSAgentAction>([
  'retry',
  'retry_modified',
  'escalate',
  'stop',
  'wait',
  'refresh_context',
  'authenticate',
]);

/**
 * Type guard that checks whether an unknown value is a valid {@link LAFSAgentAction}.
 *
 * @param value - The value to test.
 * @returns `true` if `value` is one of the recognised agent action strings.
 *
 * @remarks
 * Performs a string type check followed by a set membership lookup against
 * {@link AGENT_ACTIONS}. Safe to call with any input type.
 *
 * @example
 * ```ts
 * const action: unknown = 'retry';
 * if (isAgentAction(action)) {
 *   // action is narrowed to LAFSAgentAction
 * }
 * ```
 */
export function isAgentAction(value: unknown): value is LAFSAgentAction {
  return typeof value === 'string' && AGENT_ACTIONS.has(value as LAFSAgentAction);
}

/**
 * Structured error payload returned in a failing LAFS envelope.
 *
 * @remarks
 * Every error carries a stable `code`, a classification `category`, and
 * machine-actionable recovery hints (`agentAction`, `retryable`,
 * `retryAfterMs`). Error codes are stable within a major version and are
 * registered in `schemas/v1/error-registry.json`.
 */
export interface LAFSError {
  /** Stable, machine-readable error code (e.g. `"E_NOT_FOUND"`). */
  code: string;
  /** Human-readable description of the error. */
  message: string;
  /** High-level classification of the error. */
  category: LAFSErrorCategory;
  /** Whether the operation can be retried without modification. */
  retryable: boolean;
  /** Suggested delay in milliseconds before retrying, or `null` if not applicable. */
  retryAfterMs: number | null;
  /** Arbitrary key-value pairs with additional context about the error. */
  details: Record<string, unknown>;
  /**
   * Recommended action for the consuming agent to take.
   *
   * @defaultValue undefined
   */
  agentAction?: LAFSAgentAction;
  /**
   * When `true`, the error requires human intervention or a higher-privilege agent.
   *
   * @defaultValue undefined
   */
  escalationRequired?: boolean;
  /**
   * Free-text description of a suggested recovery action for the agent.
   *
   * @defaultValue undefined
   */
  suggestedAction?: string;
  /**
   * URL pointing to documentation about this error code.
   *
   * @defaultValue undefined
   */
  docUrl?: string;
}
/**
 * Cursor-based pagination metadata.
 *
 * @remarks
 * Cursor pagination is preferred for large or frequently-changing datasets
 * because it avoids the offset-drift problem. The `nextCursor` value is
 * opaque to the consumer and MUST be passed back verbatim on the next request.
 */
export interface LAFSPageCursor {
  /** Discriminant identifying cursor-based pagination. */
  mode: 'cursor';
  /** Opaque cursor for fetching the next page, or `null` when at the end. */
  nextCursor: string | null;
  /** Whether additional pages exist beyond the current one. */
  hasMore: boolean;
  /**
   * Maximum number of items per page.
   *
   * @defaultValue undefined
   */
  limit?: number;
  /**
   * Total number of items across all pages, or `null` if unknown.
   *
   * @defaultValue undefined
   */
  total?: number | null;
}

/**
 * Offset-based pagination metadata.
 *
 * @remarks
 * Offset pagination provides simple numeric indexing into the result set.
 * It is straightforward but may suffer from drift when items are inserted
 * or deleted between pages.
 */
export interface LAFSPageOffset {
  /** Discriminant identifying offset-based pagination. */
  mode: 'offset';
  /** Maximum number of items per page. */
  limit: number;
  /** Zero-based index of the first item in this page. */
  offset: number;
  /** Whether additional pages exist beyond the current one. */
  hasMore: boolean;
  /**
   * Total number of items across all pages, or `null` if unknown.
   *
   * @defaultValue undefined
   */
  total?: number | null;
}

/**
 * Sentinel pagination mode indicating no pagination is applied.
 *
 * @remarks
 * Used when the full result set is returned in a single envelope and no
 * further pages exist.
 */
export interface LAFSPageNone {
  /** Discriminant indicating no pagination. */
  mode: 'none';
}

/**
 * Discriminated union of all supported pagination modes.
 *
 * @remarks
 * Consumers should switch on the `mode` discriminant to determine which
 * pagination fields are available.
 */
export type LAFSPage = LAFSPageCursor | LAFSPageOffset | LAFSPageNone;

/**
 * A single entry in the context ledger recording one state mutation.
 *
 * @remarks
 * Each entry captures the delta applied to the agent's shared context by a
 * specific operation, enabling conflict detection and replay.
 */
export interface ContextLedgerEntry {
  /** Unique identifier for this ledger entry. */
  entryId: string;
  /** ISO 8601 timestamp of when the mutation occurred. */
  timestamp: string;
  /** Operation that produced this context change. */
  operation: string;
  /** Key-value delta describing the context fields that changed. */
  contextDelta: Record<string, unknown>;
  /**
   * Request identifier that triggered this entry, for tracing.
   *
   * @defaultValue undefined
   */
  requestId?: string;
}

/**
 * Append-only ledger tracking context mutations across agent interactions.
 *
 * @remarks
 * The context ledger enables optimistic concurrency control by pairing a
 * monotonically increasing `version` with a `checksum` of the current state.
 * Agents include `contextVersion` in the envelope meta to signal which ledger
 * version they are operating against.
 */
export interface ContextLedger {
  /** Unique identifier for this ledger instance. */
  ledgerId: string;
  /** Monotonically increasing version incremented on each mutation. */
  version: number;
  /** ISO 8601 timestamp of when the ledger was created. */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent mutation. */
  updatedAt: string;
  /** Ordered list of context mutations from oldest to newest. */
  entries: ContextLedgerEntry[];
  /** Integrity checksum of the current ledger state. */
  checksum: string;
  /** Maximum number of entries retained before oldest entries are pruned. */
  maxEntries: number;
}

/**
 * Top-level LAFS response envelope wrapping every operation result.
 *
 * @remarks
 * The envelope is the canonical response shape for all LAFS-compliant
 * operations. Exactly one of `result` or `error` MUST be non-null:
 * `success=true` implies `error` is `null`; `success=false` implies
 * `result` is `null` (unless the operation intentionally provides
 * actionable data alongside the error).
 */
export interface LAFSEnvelope {
  /** JSON Schema URL identifying the envelope schema version. */
  $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json';
  /** Protocol and request metadata. */
  _meta: LAFSMeta;
  /** Whether the operation completed successfully. */
  success: boolean;
  /** Operation result payload, or `null` on failure. */
  result: Record<string, unknown> | Record<string, unknown>[] | null;
  /**
   * Structured error payload, or `null` on success.
   *
   * @defaultValue undefined
   */
  error?: LAFSError | null;
  /**
   * Pagination metadata when the result is a paginated collection.
   *
   * @defaultValue undefined
   */
  page?: LAFSPage | null;
  /**
   * Vendor or protocol extension data keyed by extension identifier.
   *
   * @defaultValue undefined
   */
  _extensions?: Record<string, unknown>;
}

/**
 * Input parameters for resolving the output format via flag semantics.
 *
 * @remarks
 * The resolution precedence is: explicit flag (`--json` / `--human`) >
 * `requestedFormat` > project default > user default > TTY heuristic >
 * protocol default (`json`). See `flagSemantics.ts` for the full algorithm.
 */
export interface FlagInput {
  /**
   * Explicitly requested output format string.
   *
   * @defaultValue undefined
   */
  requestedFormat?: 'json' | 'human';
  /**
   * Whether the `--json` CLI flag was provided.
   *
   * @defaultValue undefined
   */
  jsonFlag?: boolean;
  /**
   * Whether the `--human` CLI flag was provided.
   *
   * @defaultValue undefined
   */
  humanFlag?: boolean;
  /**
   * Project-level default output format from configuration.
   *
   * @defaultValue undefined
   */
  projectDefault?: 'json' | 'human';
  /**
   * User-level default output format from configuration.
   *
   * @defaultValue undefined
   */
  userDefault?: 'json' | 'human';
  /**
   * When true, indicates the output is connected to an interactive terminal.
   * If no explicit format flag or project/user default is set, TTY terminals
   * default to `"human"` format while non-TTY (piped, CI, agents) defaults
   * to `"json"` per the LAFS protocol.
   *
   * CLI tools should pass `process.stdout.isTTY ?? false` here.
   *
   * @defaultValue undefined
   */
  tty?: boolean;
  /**
   * Suppress non-essential output for scripting. When true, only essential data is returned.
   *
   * @defaultValue undefined
   */
  quiet?: boolean;
}

/**
 * Result of a LAFS conformance test run.
 *
 * @remarks
 * Returned by the conformance test runners in `conformance.ts`. The `ok`
 * flag is `true` only when every individual check passed.
 */
export interface ConformanceReport {
  /** `true` if all checks passed; `false` if any check failed. */
  ok: boolean;
  /** Individual conformance check results. */
  checks: Array<{
    /** Name of the conformance check. */
    name: string;
    /** Whether this individual check passed. */
    pass: boolean;
    /**
     * Additional detail about a failure or the check's outcome.
     *
     * @defaultValue undefined
     */
    detail?: string;
  }>;
}

/**
 * Options controlling token-budget enforcement behaviour.
 *
 * @remarks
 * When a LAFS envelope's estimated token count exceeds the caller's budget,
 * these options determine whether the result is truncated and whether a
 * callback is invoked.
 */
export type BudgetEnforcementOptions = {
  /**
   * When `true`, oversized results are truncated to fit within the budget.
   *
   * @defaultValue undefined
   */
  truncateOnExceed?: boolean;
  /**
   * Callback invoked when the estimated token count exceeds the budget.
   *
   * @param estimated - Estimated token count of the envelope.
   * @param budget - Maximum allowed token count.
   *
   * @defaultValue undefined
   */
  onBudgetExceeded?: (estimated: number, budget: number) => void;
};

/**
 * Token-count estimate attached to a budget-aware envelope.
 *
 * @remarks
 * Provides transparency into the estimated cost of an envelope so agents
 * can track and enforce token budgets across multi-step workflows.
 */
export interface TokenEstimate {
  /** Estimated token count of the envelope after any truncation. */
  estimated: number;
  /**
   * Whether the result was truncated to fit within the budget.
   *
   * @defaultValue undefined
   */
  truncated?: boolean;
  /**
   * Original estimated token count before truncation, if truncation occurred.
   *
   * @defaultValue undefined
   */
  originalEstimate?: number;
}

/**
 * Extended metadata block that includes an optional token-budget estimate.
 *
 * @remarks
 * Extends {@link LAFSMeta} with a `_tokenEstimate` field used by the budget
 * enforcement middleware to record the estimated cost of the envelope.
 */
export interface LAFSMetaWithBudget extends LAFSMeta {
  /**
   * Token-count estimate for budget tracking.
   *
   * @defaultValue undefined
   */
  _tokenEstimate?: TokenEstimate;
}

/**
 * LAFS envelope variant whose metadata includes token-budget estimates.
 *
 * @remarks
 * Replaces the standard `_meta` with {@link LAFSMetaWithBudget} so that
 * budget enforcement results can be carried alongside the normal envelope
 * payload.
 */
export interface LAFSEnvelopeWithBudget extends Omit<LAFSEnvelope, '_meta'> {
  /** Metadata block extended with token-budget estimation. */
  _meta: LAFSMetaWithBudget;
}

/**
 * Middleware function that transforms a LAFS envelope.
 *
 * @remarks
 * Simple one-in-one-out transform with no `next` callback. Used for
 * post-processing pipelines where ordering is managed externally.
 *
 * @param envelope - The envelope to transform.
 * @returns The transformed envelope, optionally as a `Promise`.
 */
export type MiddlewareFunction = (envelope: LAFSEnvelope) => LAFSEnvelope | Promise<LAFSEnvelope>;

/**
 * Continuation function passed to {@link BudgetMiddleware} to invoke the next
 * middleware in the chain.
 *
 * @remarks
 * Calling `next()` delegates to the downstream middleware (or the terminal
 * handler). The returned envelope may be further transformed by the caller.
 *
 * @returns The envelope produced by the downstream handler.
 */
export type NextFunction = () => LAFSEnvelope | Promise<LAFSEnvelope>;

/**
 * Middleware function for token-budget enforcement with chain delegation.
 *
 * @remarks
 * Unlike {@link MiddlewareFunction}, budget middleware receives a `next`
 * callback allowing it to intercept, modify, or short-circuit the
 * downstream processing pipeline.
 *
 * @param envelope - The envelope entering this middleware stage.
 * @param next - Continuation to invoke the next middleware in the chain.
 * @returns The (possibly transformed) envelope.
 */
export type BudgetMiddleware = (
  envelope: LAFSEnvelope,
  next: NextFunction,
) => Promise<LAFSEnvelope> | LAFSEnvelope;

/**
 * Outcome of running budget enforcement on a LAFS envelope.
 *
 * @remarks
 * Returned by the budget enforcement pipeline so callers can inspect whether
 * the envelope was truncated and how the estimate compares to the budget.
 */
export interface BudgetEnforcementResult {
  /** The envelope after budget enforcement (possibly truncated). */
  envelope: LAFSEnvelope;
  /** `true` if the estimated token count is within the allowed budget. */
  withinBudget: boolean;
  /** Estimated token count of the final envelope. */
  estimatedTokens: number;
  /** Maximum allowed token count that was enforced. */
  budget: number;
  /** Whether the envelope's result was truncated to fit the budget. */
  truncated: boolean;
}
