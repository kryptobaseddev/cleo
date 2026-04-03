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
