import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getAgentAction,
  getDocUrl,
  getRegistryCode,
  isRegisteredErrorCode,
} from './errorRegistry.js';
import type {
  LAFSAgentAction,
  LAFSEnvelope,
  LAFSError,
  LAFSErrorCategory,
  LAFSMeta,
  LAFSTransport,
  MVILevel,
  Warning,
} from './types.js';
import { assertEnvelope } from './validateEnvelope.js';

/**
 * Canonical JSON Schema URL for the LAFS v1 envelope.
 *
 * @remarks
 * Every LAFS envelope includes this URL in its `$schema` field so that
 * validators and tooling can locate the authoritative schema definition.
 *
 * @example
 * ```ts
 * import { LAFS_SCHEMA_URL } from '@cleocode/lafs';
 * console.log(LAFS_SCHEMA_URL);
 * // => 'https://lafs.dev/schemas/v1/envelope.schema.json'
 * ```
 */
export const LAFS_SCHEMA_URL = 'https://lafs.dev/schemas/v1/envelope.schema.json' as const;

/**
 * Input for constructing the `_meta` block of a LAFS envelope.
 *
 * @remarks
 * Only `operation` and `requestId` are required; all other fields have
 * sensible defaults (see {@link createEnvelope} for the resolution logic).
 */
export interface CreateEnvelopeMetaInput {
  /** Dot-delimited operation identifier (e.g. `"tasks.list"`). */
  operation: string;
  /** Unique identifier for correlating this request/response pair. */
  requestId: string;
  /**
   * Transport protocol for this envelope.
   *
   * @defaultValue 'sdk'
   */
  transport?: LAFSTransport;
  /**
   * LAFS spec version to stamp on the envelope.
   *
   * @defaultValue '1.0.0'
   */
  specVersion?: string;
  /**
   * JSON Schema version to stamp on the envelope.
   *
   * @defaultValue '1.0.0'
   */
  schemaVersion?: string;
  /**
   * ISO 8601 timestamp; auto-generated when omitted.
   *
   * @defaultValue undefined
   */
  timestamp?: string;
  /**
   * Whether strict schema validation should be applied.
   *
   * @defaultValue true
   */
  strict?: boolean;
  /**
   * MVI level as a string, or `true` for `'minimal'` / `false` for `'standard'`.
   *
   * @defaultValue 'standard'
   */
  mvi?: MVILevel | boolean;
  /**
   * Context ledger version the caller is operating against.
   *
   * @defaultValue 0
   */
  contextVersion?: number;
  /**
   * Session identifier for multi-step workflow correlation.
   *
   * @defaultValue undefined
   */
  sessionId?: string;
  /**
   * Non-fatal warnings to attach to the envelope metadata.
   *
   * @defaultValue undefined
   */
  warnings?: LAFSMeta['warnings'];
}

/**
 * Input for creating a successful LAFS envelope.
 *
 * @remarks
 * When `success` is `true`, the `result` field carries the operation payload
 * and `error` is forced to `null` in the output envelope.
 */
export interface CreateEnvelopeSuccessInput {
  /** Discriminant marking this as a success input. */
  success: true;
  /** Operation result payload (object, array, or `null`). */
  result: LAFSEnvelope['result'];
  /**
   * Pagination metadata for collection results.
   *
   * @defaultValue undefined
   */
  page?: LAFSEnvelope['page'];
  /**
   * Must be `null` for success inputs; exists for type uniformity with error inputs.
   *
   * @defaultValue undefined
   */
  error?: null;
  /**
   * Vendor or protocol extension data.
   *
   * @defaultValue undefined
   */
  _extensions?: LAFSEnvelope['_extensions'];
  /** Metadata input for constructing the envelope's `_meta` block. */
  meta: CreateEnvelopeMetaInput;
}

/**
 * Input for creating a failing LAFS envelope.
 *
 * @remarks
 * When `success` is `false`, the `error` field is required and will be
 * normalized (category, agent action, doc URL) via the error registry.
 * An optional `result` can carry actionable data alongside the error.
 */
export interface CreateEnvelopeErrorInput {
  /** Discriminant marking this as an error input. */
  success: false;
  /** Partial error object; at minimum `code` and `message` are required. */
  error: Partial<LAFSError> & Pick<LAFSError, 'code' | 'message'>;
  /**
   * Optional result payload to include alongside the error.
   * For validation tools (linters, type checkers), the actionable data
   * (what to fix, suggested fixes) IS the result even when the operation
   * "fails". Setting this allows agents to access both the error metadata
   * and the detailed result in a single response.
   *
   * When omitted or null, the envelope emits `result: null` (default behavior).
   *
   * @defaultValue undefined
   */
  result?: LAFSEnvelope['result'] | null;
  /**
   * Pagination metadata, if applicable even in error scenarios.
   *
   * @defaultValue undefined
   */
  page?: LAFSEnvelope['page'];
  /**
   * Vendor or protocol extension data.
   *
   * @defaultValue undefined
   */
  _extensions?: LAFSEnvelope['_extensions'];
  /** Metadata input for constructing the envelope's `_meta` block. */
  meta: CreateEnvelopeMetaInput;
}

/**
 * Discriminated union of success and error inputs for {@link createEnvelope}.
 *
 * @remarks
 * The `success` boolean discriminant determines which branch is active and
 * which fields are required.
 */
export type CreateEnvelopeInput = CreateEnvelopeSuccessInput | CreateEnvelopeErrorInput;

/**
 * Resolve an MVI input (string, boolean, or undefined) to a canonical {@link MVILevel}.
 *
 * @param input - MVI value from the caller: a level string, `true` for minimal,
 *   `false` for standard, or `undefined` for the default.
 * @returns The resolved {@link MVILevel} string.
 *
 * @remarks
 * Boolean shorthand exists for CLI convenience: `--mvi` (no value) maps to
 * `true` which resolves to `'minimal'`.
 */
function resolveMviLevel(input: CreateEnvelopeMetaInput['mvi']): MVILevel {
  if (typeof input === 'boolean') {
    return input ? 'minimal' : 'standard';
  }
  return input ?? 'standard';
}

/**
 * Build a fully populated {@link LAFSMeta} object from partial input.
 *
 * @param input - Caller-supplied metadata fields; missing values receive defaults.
 * @returns A complete {@link LAFSMeta} ready for embedding in an envelope.
 *
 * @remarks
 * Defaults: `specVersion` and `schemaVersion` to `'1.0.0'`, `transport` to
 * `'sdk'`, `strict` to `true`, `mvi` to `'standard'`, `contextVersion` to `0`,
 * and `timestamp` to the current time.
 */
function createMeta(input: CreateEnvelopeMetaInput): LAFSMeta {
  return {
    specVersion: input.specVersion ?? '1.0.0',
    schemaVersion: input.schemaVersion ?? '1.0.0',
    timestamp: input.timestamp ?? new Date().toISOString(),
    operation: input.operation,
    requestId: input.requestId,
    transport: input.transport ?? 'sdk',
    strict: input.strict ?? true,
    mvi: resolveMviLevel(input.mvi),
    contextVersion: input.contextVersion ?? 0,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
  };
}

/**
 * Default agent action for each error category.
 *
 * @remarks
 * When a {@link LAFSError} does not specify an explicit `agentAction` and the
 * error registry has no override, this map provides the fallback recommendation
 * based on the error's category.
 *
 * @example
 * ```ts
 * import { CATEGORY_ACTION_MAP } from '@cleocode/lafs';
 * const action = CATEGORY_ACTION_MAP['RATE_LIMIT']; // => 'wait'
 * ```
 */
export const CATEGORY_ACTION_MAP: Record<LAFSErrorCategory, LAFSAgentAction> = {
  VALIDATION: 'retry_modified',
  AUTH: 'authenticate',
  PERMISSION: 'escalate',
  NOT_FOUND: 'stop',
  CONFLICT: 'retry_modified',
  RATE_LIMIT: 'wait',
  TRANSIENT: 'retry',
  INTERNAL: 'escalate',
  CONTRACT: 'retry_modified',
  MIGRATION: 'stop',
};

/**
 * Normalize a partial error input into a fully populated {@link LAFSError}.
 *
 * @param error - Partial error with at least `code` and `message`.
 * @returns A complete {@link LAFSError} with category, retryable flag, agent
 *   action, and optional doc URL resolved from the error registry and
 *   category-action map.
 *
 * @remarks
 * Resolution precedence for `agentAction`: explicit caller value > error
 * registry entry > {@link CATEGORY_ACTION_MAP} fallback. The same pattern
 * applies to `category`, `retryable`, and `docUrl`.
 */
function normalizeError(error: CreateEnvelopeErrorInput['error']): LAFSError {
  const registryEntry = getRegistryCode(error.code);

  const category = (error.category ?? registryEntry?.category ?? 'INTERNAL') as LAFSErrorCategory;
  const retryable = error.retryable ?? registryEntry?.retryable ?? false;

  // Derive agentAction: explicit > registry > category fallback
  const agentAction: LAFSAgentAction | undefined =
    error.agentAction ?? getAgentAction(error.code) ?? CATEGORY_ACTION_MAP[category];

  const docUrl = error.docUrl ?? getDocUrl(error.code);

  const result: LAFSError = {
    code: error.code,
    message: error.message,
    category,
    retryable,
    retryAfterMs: error.retryAfterMs ?? null,
    details: error.details ?? {},
  };

  if (agentAction !== undefined) {
    result.agentAction = agentAction;
  }
  if (error.escalationRequired !== undefined) {
    result.escalationRequired = error.escalationRequired;
  }
  if (error.suggestedAction !== undefined) {
    result.suggestedAction = error.suggestedAction;
  }
  if (docUrl !== undefined) {
    result.docUrl = docUrl;
  }

  return result;
}

/**
 * Create a fully validated LAFS envelope from a success or error input.
 *
 * @param input - Discriminated union of success or error input data.
 * @returns A complete {@link LAFSEnvelope} ready for serialization.
 *
 * @remarks
 * This is the primary factory for LAFS envelopes. It delegates to
 * internal `createMeta` for metadata construction and `normalizeError`
 * for error normalization. Optional fields (`page`, `_extensions`) are only
 * included when explicitly provided, keeping the envelope minimal.
 *
 * @example
 * ```ts
 * import { createEnvelope } from '@cleocode/lafs';
 *
 * const envelope = createEnvelope({
 *   success: true,
 *   result: { items: [] },
 *   meta: { operation: 'tasks.list', requestId: 'req-1' },
 * });
 * ```
 */
export function createEnvelope(input: CreateEnvelopeInput): LAFSEnvelope {
  const meta = createMeta(input.meta);

  if (input.success) {
    return {
      $schema: LAFS_SCHEMA_URL,
      _meta: meta,
      success: true,
      result: input.result,
      ...(input.page !== undefined ? { page: input.page } : {}),
      ...(input.error !== undefined ? { error: null } : {}),
      ...(input._extensions !== undefined ? { _extensions: input._extensions } : {}),
    };
  }

  return {
    $schema: LAFS_SCHEMA_URL,
    _meta: meta,
    success: false,
    // Pass through result if provided — validation tools need actionable data
    // alongside error metadata. Default to null for traditional error responses.
    result: input.result ?? null,
    error: normalizeError(input.error),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input._extensions !== undefined ? { _extensions: input._extensions } : {}),
  };
}

/**
 * Error subclass that carries the full {@link LAFSError} payload.
 *
 * @remarks
 * Thrown by {@link parseLafsResponse} when the envelope indicates failure.
 * Implements {@link LAFSError} so consumers can access structured error
 * metadata directly on the caught error instance. The `registered` flag
 * indicates whether the error code exists in the canonical error registry.
 *
 * @example
 * ```ts
 * try {
 *   parseLafsResponse(envelope);
 * } catch (err) {
 *   if (err instanceof LafsError) {
 *     console.log(err.code, err.agentAction);
 *   }
 * }
 * ```
 */
export class LafsError extends Error implements LAFSError {
  /** Stable, machine-readable error code. */
  code: string;
  /** High-level classification of the error. */
  category: LAFSErrorCategory;
  /** Whether the operation can be retried without modification. */
  retryable: boolean;
  /** Suggested delay in milliseconds before retrying, or `null` if not applicable. */
  retryAfterMs: number | null;
  /** Arbitrary key-value pairs with additional context about the error. */
  details: Record<string, unknown>;
  /** Whether this error code exists in the canonical error registry. */
  registered: boolean;
  /**
   * Recommended action for the consuming agent.
   *
   * @defaultValue undefined
   */
  agentAction?: LAFSAgentAction;
  /**
   * Whether the error requires human or higher-privilege intervention.
   *
   * @defaultValue undefined
   */
  escalationRequired?: boolean;
  /**
   * Free-text description of a suggested recovery action.
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

  /**
   * Create a new `LafsError` from a structured {@link LAFSError} payload.
   *
   * @param error - The structured error data to wrap.
   *
   * @remarks
   * Copies all fields from the input and sets `registered` by checking the
   * error code against the canonical registry via {@link isRegisteredErrorCode}.
   */
  constructor(error: LAFSError) {
    super(error.message);
    this.name = 'LafsError';
    this.code = error.code;
    this.category = error.category;
    this.retryable = error.retryable;
    this.retryAfterMs = error.retryAfterMs;
    this.details = error.details;
    this.registered = isRegisteredErrorCode(error.code);
    if (error.agentAction !== undefined) this.agentAction = error.agentAction;
    if (error.escalationRequired !== undefined) this.escalationRequired = error.escalationRequired;
    if (error.suggestedAction !== undefined) this.suggestedAction = error.suggestedAction;
    if (error.docUrl !== undefined) this.docUrl = error.docUrl;
  }
}

/**
 * Options for {@link parseLafsResponse}.
 *
 * @remarks
 * Controls how strictly the parser validates the error code against the
 * canonical error registry.
 */
export interface ParseLafsResponseOptions {
  /**
   * When `true`, unregistered error codes cause an additional `Error` to be
   * thrown instead of the normal {@link LafsError}.
   *
   * @defaultValue undefined
   */
  requireRegisteredErrorCode?: boolean;
}

/**
 * Parse and unwrap a raw LAFS envelope, returning the result or throwing on error.
 *
 * @typeParam T - Expected type of the result payload.
 * @param input - Raw value expected to be a valid {@link LAFSEnvelope}.
 * @param options - Parsing options controlling error-code validation.
 * @returns The `result` field of the envelope cast to `T`.
 * @throws {LafsError} When the envelope indicates failure (`success=false`).
 * @throws {Error} When the envelope is structurally invalid or
 *   `requireRegisteredErrorCode` is `true` and the code is unregistered.
 *
 * @remarks
 * Delegates to {@link assertEnvelope} for schema validation before inspecting
 * the `success` flag. On success, the `result` is returned directly. On
 * failure, the `error` payload is wrapped in a {@link LafsError} and thrown.
 *
 * @example
 * ```ts
 * import { parseLafsResponse } from '@cleocode/lafs';
 *
 * interface TaskList { items: Task[] }
 * const tasks = parseLafsResponse<TaskList>(rawEnvelope);
 * ```
 */
export function parseLafsResponse<T = unknown>(
  input: unknown,
  options: ParseLafsResponseOptions = {},
): T {
  const envelope = assertEnvelope(input);
  if (envelope.success) {
    return envelope.result as T;
  }

  const error = envelope.error;
  if (!error) {
    throw new Error('Invalid LAFS envelope: success=false requires error object');
  }

  if (options.requireRegisteredErrorCode && !isRegisteredErrorCode(error.code)) {
    throw new Error(`Unregistered LAFS error code: ${error.code}`);
  }

  throw new LafsError(error);
}

// ---------------------------------------------------------------------------
// WarningCollector — async-local carrier for non-fatal warnings (T9768)
//
// Producer code anywhere in the call chain (CORE bridges, CAAMP commands,
// dispatch middleware) calls `pushWarning(w)` to attach a non-fatal notice
// to the current operation. The CLI renderer (or any other adapter that
// runs handlers inside `withWarningCollector`) drains the collector at
// envelope-construction time and merges the result into `meta.warnings[]`.
//
// When `pushWarning` is called OUTSIDE an active `withWarningCollector`
// scope, it silently no-ops — preserving the current behaviour for any
// caller that has not yet adopted the new carrier.
// ---------------------------------------------------------------------------

/**
 * Async-local collector for non-fatal {@link Warning} entries.
 *
 * @remarks
 * Producers anywhere in the synchronous OR asynchronous call chain can
 * push warnings into the active collector via {@link pushWarning} without
 * knowing which adapter (CLI, HTTP, etc.) is going to drain them. The
 * collector is intentionally lightweight: it owns a plain array and a
 * `Set` of seen codes for `pushIfMissing` deduplication. Instances are
 * cheap to construct — adapters typically allocate one per request.
 *
 * @example
 * ```ts
 * import { WarningCollector, withWarningCollector, pushWarning } from '@cleocode/lafs';
 *
 * const collector = new WarningCollector();
 * await withWarningCollector(collector, async () => {
 *   pushWarning({ code: 'W_BRIDGE_WRITE_FAILED', message: 'memory bridge unavailable' });
 * });
 * const warnings = collector.drain(); // → [Warning] or undefined
 * ```
 *
 * @public
 */
export class WarningCollector {
  /** Backing store of pushed warnings, in insertion order. */
  private readonly warnings: Warning[] = [];
  /** Set of codes seen via {@link pushIfMissing}, for dedup tracking. */
  private readonly seenCodes: Set<string> = new Set();

  /**
   * Append a warning to the collector.
   *
   * @param warning - The {@link Warning} to attach. The collector does not
   *   normalise or copy the input — callers retain ownership of mutable
   *   `context` objects.
   *
   * @remarks
   * No deduplication is performed. Pass the same code twice and you get two
   * entries. For dedup-by-code semantics use {@link pushIfMissing} instead.
   */
  push(warning: Warning): void {
    this.warnings.push(warning);
  }

  /**
   * Append a warning only when no entry for {@link code} has been added via
   * `pushIfMissing` yet on this collector.
   *
   * @param code - Warning code to dedupe on.
   * @param factory - Lazy constructor invoked only when the code is unseen.
   * @returns `true` when the warning was added, `false` when skipped.
   *
   * @remarks
   * Dedup state is tracked separately from {@link push} so a `push` call with
   * the same code does NOT prevent a later `pushIfMissing` from firing —
   * the two paths intentionally have independent dedup semantics. Use
   * `pushIfMissing` for warnings that are likely to be emitted from a hot
   * loop (e.g. per-iteration bridge failure during a sweep).
   */
  pushIfMissing(code: string, factory: () => Warning): boolean {
    if (this.seenCodes.has(code)) return false;
    this.seenCodes.add(code);
    this.warnings.push(factory());
    return true;
  }

  /**
   * Return a copy of every warning pushed so far, or `undefined` when empty.
   *
   * @returns A fresh array of warnings, or `undefined` if none were pushed.
   *
   * @remarks
   * The collector is NOT cleared by `drain()` — calling drain twice returns
   * the same set of warnings. This matches the renderer's "snapshot then
   * emit" pattern: a single envelope construction reads the collector once.
   * The `undefined` return (rather than an empty array) lets callers cheaply
   * omit the field via `...(drained ? { warnings: drained } : {})`.
   */
  drain(): Warning[] | undefined {
    return this.warnings.length > 0 ? [...this.warnings] : undefined;
  }

  /**
   * Read-only count of warnings currently held by the collector.
   *
   * @returns The number of warnings pushed since construction.
   *
   * @remarks
   * Useful for fast "did anything happen?" checks without allocating the
   * `drain()` snapshot array.
   */
  size(): number {
    return this.warnings.length;
  }
}

/**
 * AsyncLocalStorage carrier holding the active {@link WarningCollector}, if any.
 *
 * @remarks
 * Exported so adapters that need to inspect (or temporarily replace) the
 * active collector can do so without instantiating their own ALS. Most
 * producers should use {@link pushWarning} and most adapters should use
 * {@link withWarningCollector} instead of touching this directly.
 *
 * @public
 */
export const currentWarningCollector = new AsyncLocalStorage<WarningCollector>();

/**
 * Run {@link fn} with {@link collector} bound as the active warning collector.
 *
 * @typeParam T - Return type of the wrapped function.
 * @param collector - The collector that should receive `pushWarning` calls
 *   originating from within `fn` (synchronous or asynchronous descendants).
 * @param fn - Function to execute inside the bound scope.
 * @returns Whatever `fn` returns. If `fn` returns a Promise, the binding is
 *   preserved for the entire async chain via AsyncLocalStorage semantics.
 *
 * @remarks
 * Adapters (CLI, HTTP middleware, etc.) call this once per request, drain
 * the collector when constructing the response envelope, and discard it.
 * Nested calls are supported — the innermost collector wins for any
 * `pushWarning` originating inside the nested scope.
 *
 * @example
 * ```ts
 * import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
 *
 * const collector = new WarningCollector();
 * const result = await withWarningCollector(collector, () => runHandler(req));
 * const warnings = collector.drain();
 * ```
 *
 * @public
 */
export function withWarningCollector<T>(collector: WarningCollector, fn: () => T): T {
  return currentWarningCollector.run(collector, fn);
}

/**
 * Return the currently-active {@link WarningCollector}, or `undefined` when
 * no `withWarningCollector` scope is bound.
 *
 * @returns The active collector, or `undefined`.
 *
 * @remarks
 * Use this from adapter code that needs to read state but not push (e.g.
 * a logger that wants to mirror warnings to a structured sink). Producers
 * should prefer {@link pushWarning}, which handles the missing-scope case
 * silently.
 *
 * @public
 */
export function getCurrentWarningCollector(): WarningCollector | undefined {
  return currentWarningCollector.getStore();
}

/**
 * Attach a non-fatal warning to the active operation's envelope.
 *
 * @param warning - The {@link Warning} to attach.
 *
 * @remarks
 * No-op when there is no active {@link WarningCollector} bound via
 * {@link withWarningCollector}. This means CORE / library code can call
 * `pushWarning` unconditionally without checking whether it is running
 * under a CLI adapter, a test harness, or an SDK consumer that has not yet
 * adopted the carrier.
 *
 * @example
 * ```ts
 * import { pushWarning } from '@cleocode/lafs';
 *
 * try {
 *   await writeBridge(...);
 * } catch (err) {
 *   pushWarning({
 *     code: 'W_BRIDGE_WRITE_FAILED',
 *     message: 'memory bridge write failed',
 *     severity: 'warn',
 *     context: { error: err instanceof Error ? err.message : String(err) },
 *   });
 * }
 * ```
 *
 * @public
 */
export function pushWarning(warning: Warning): void {
  const collector = currentWarningCollector.getStore();
  if (collector) collector.push(warning);
}

// ---------------------------------------------------------------------------
// Canonical CLI envelope — the unified shape every CLEO CLI command emits.
// Replaces the three legacy shapes:
//   {ok, r, _m}            (minimal MVI)
//   {success, result}      (observe command)
//   {success, error}       (error responses, no meta)
// ---------------------------------------------------------------------------

/**
 * Metadata block present on every canonical CLI envelope (success or failure).
 *
 * @remarks
 * `operation` and `requestId` are the only required fields; `duration_ms`,
 * `timestamp`, and `sessionId` are populated by the CLI adapter. Additional
 * vendor fields can be added via the index signature without breaking
 * downstream consumers.
 *
 * This is the CLI-tier counterpart to {@link LAFSMeta} (which is used
 * internally by the LAFS SDK for protocol-level envelopes). The CLI meta
 * intentionally uses the unprefixed `meta` key to match the canonical
 * CLEO CLI envelope shape (ADR-039).
 */
export interface CliMeta {
  /** Dot-delimited operation identifier, e.g. `"tasks.add"`. */
  operation: string;
  /** Unique request identifier (UUID) for tracing and correlation. */
  requestId: string;
  /** Wall-clock duration of the operation in milliseconds. */
  duration_ms: number;
  /** ISO 8601 timestamp of when the envelope was created. */
  timestamp: string;
  /** Active session identifier, if present. */
  sessionId?: string;
  /**
   * Array of suggested follow-up commands (LAFS hint for chained reasoning).
   *
   * Envelope-wide first-class field promoted from the nexus-only
   * `meta._nexus.suggestedNext` structured form (Saga T9855 / E8 — T9920).
   * Each entry is a copy-pasteable CLI string the agent can run next.
   * Producers (operation handlers, decorators) SHOULD attach this via
   * `attachSuggestedNext()` from `@cleocode/core/dispatch/suggested-next`.
   *
   * Renderers MUST drop this field from human output when the array is
   * empty. Backward-compatible: existing `meta._nexus.suggestedNext`
   * structured consumers continue to function unchanged — this field is
   * the flat string projection layered alongside.
   */
  suggestedNext?: ReadonlyArray<string>;
  /**
   * First-class token-cost annotation for this CLI envelope.
   *
   * @remarks
   * Promotes the legacy underscore-prefixed `meta._tokenEstimate` field
   * (still emitted for backwards compatibility — see {@link CliMetaTokens}
   * deprecation notice). Renderers and orchestrators MAY use this to
   * surface the envelope's approximate token cost without depending on
   * LAFS-tier internals.
   *
   * Promoted in Saga T9855 / E8 — T9923 (ADR-039).
   */
  tokens?: CliMetaTokens;
  /**
   * Legacy underscore-prefixed token-cost annotation.
   *
   * @deprecated removeAt v2026.7.0 — use {@link CliMeta.tokens} instead.
   * Retained for ONE release so existing consumers can migrate.
   */
  _tokenEstimate?: { estimate: number; [key: string]: unknown };
  /** Extensible metadata; vendor fields go here. */
  [key: string]: unknown;
}

/**
 * Structured token-cost annotation attached to a CLI envelope's `meta.tokens`.
 *
 * @remarks
 * First-class promotion of the legacy `meta._tokenEstimate` field, introduced
 * in Saga T9855 / E8 — T9923. Consumers SHOULD read `meta.tokens.estimate`
 * directly; the legacy underscore-prefixed field is retained for ONE release
 * and removed at v2026.7.0.
 */
export interface CliMetaTokens {
  /** Approximate token count of the envelope payload. */
  estimate: number;
  /**
   * Tokenizer identifier used to compute {@link CliMetaTokens.estimate}.
   *
   * @example `"cl100k"`, `"o200k"`, `"approx"` (heuristic fallback).
   */
  model: string;
  /** ISO 8601 timestamp of when the estimate was computed. */
  calculatedAt: string;
}

/**
 * Structured error payload in a canonical CLI error envelope.
 *
 * @remarks
 * Extends the legacy error shape with optional protocol-level fields.
 * All optional fields are omitted from the serialised output when absent.
 */
export interface CliEnvelopeError {
  /** Numeric CLI exit code (1-99). */
  code: number | string;
  /** Symbolic error code name, e.g. `"E_NOT_FOUND"`. */
  codeName?: string;
  /** Human-readable error description. */
  message: string;
  /** Copy-pasteable fix hint for the operator or agent. */
  fix?: unknown;
  /** Alternative actions the agent can try. */
  alternatives?: Array<{ action: string; command: string }>;
  /** Additional structured context about the error. */
  details?: unknown;
  /** RFC 9457 Problem Details object (optional). */
  problemDetails?: unknown;
  /** Extensible vendor fields. */
  [key: string]: unknown;
}

/**
 * Canonical CLI response envelope emitted by every CLEO CLI command.
 *
 * @typeParam T - The type of the operation result payload.
 *
 * @remarks
 * This is the **single** response shape that all CLEO CLI commands produce,
 * replacing the three legacy shapes that required consumers to branch on
 * shape before parsing (ADR-039). Key invariants:
 *
 * - `success` is **always** present.
 * - `meta` is **always** present (success and failure).
 * - `data` is present when `success === true`.
 * - `error` is present when `success === false`.
 * - `page` is present when the result is paginated.
 *
 * @example
 * ```ts
 * import type { CliEnvelope } from '@cleocode/lafs';
 *
 * const response: CliEnvelope<{ task: Task }> = JSON.parse(output);
 * if (response.success) {
 *   console.log(response.data.task.id);
 * }
 * ```
 */
export interface CliEnvelope<T = Record<string, unknown>> {
  /** Whether the operation completed successfully. */
  success: boolean;
  /** Operation result payload. Present when `success === true`. */
  data?: T;
  /** Structured error payload. Present when `success === false`. */
  error?: CliEnvelopeError;
  /** Envelope metadata. Always present. */
  meta: CliMeta;
  /** Pagination metadata. Present when the result is a paginated collection. */
  page?: import('./types.js').LAFSPage;
}
