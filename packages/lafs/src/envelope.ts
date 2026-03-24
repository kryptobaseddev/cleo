import { isRegisteredErrorCode, getRegistryCode, getAgentAction, getDocUrl } from "./errorRegistry.js";
import type {
  LAFSEnvelope,
  LAFSError,
  LAFSErrorCategory,
  LAFSAgentAction,
  LAFSMeta,
  LAFSTransport,
  MVILevel,
} from "./types.js";
import { assertEnvelope } from "./validateEnvelope.js";

export const LAFS_SCHEMA_URL = "https://lafs.dev/schemas/v1/envelope.schema.json" as const;

export interface CreateEnvelopeMetaInput {
  operation: string;
  requestId: string;
  transport?: LAFSTransport;
  specVersion?: string;
  schemaVersion?: string;
  timestamp?: string;
  strict?: boolean;
  mvi?: MVILevel | boolean;
  contextVersion?: number;
  sessionId?: string;
  warnings?: LAFSMeta["warnings"];
}

export interface CreateEnvelopeSuccessInput {
  success: true;
  result: LAFSEnvelope["result"];
  page?: LAFSEnvelope["page"];
  error?: null;
  _extensions?: LAFSEnvelope["_extensions"];
  meta: CreateEnvelopeMetaInput;
}

export interface CreateEnvelopeErrorInput {
  success: false;
  error: Partial<LAFSError> & Pick<LAFSError, "code" | "message">;
  /**
   * Optional result payload to include alongside the error.
   * For validation tools (linters, type checkers), the actionable data
   * (what to fix, suggested fixes) IS the result even when the operation
   * "fails". Setting this allows agents to access both the error metadata
   * and the detailed result in a single response.
   *
   * When omitted or null, the envelope emits `result: null` (default behavior).
   */
  result?: LAFSEnvelope["result"] | null;
  page?: LAFSEnvelope["page"];
  _extensions?: LAFSEnvelope["_extensions"];
  meta: CreateEnvelopeMetaInput;
}

export type CreateEnvelopeInput = CreateEnvelopeSuccessInput | CreateEnvelopeErrorInput;

function resolveMviLevel(input: CreateEnvelopeMetaInput["mvi"]): MVILevel {
  if (typeof input === "boolean") {
    return input ? "minimal" : "standard";
  }
  return input ?? "standard";
}

function createMeta(input: CreateEnvelopeMetaInput): LAFSMeta {
  return {
    specVersion: input.specVersion ?? "1.0.0",
    schemaVersion: input.schemaVersion ?? "1.0.0",
    timestamp: input.timestamp ?? new Date().toISOString(),
    operation: input.operation,
    requestId: input.requestId,
    transport: input.transport ?? "sdk",
    strict: input.strict ?? true,
    mvi: resolveMviLevel(input.mvi),
    contextVersion: input.contextVersion ?? 0,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
  };
}

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

function normalizeError(error: CreateEnvelopeErrorInput["error"]): LAFSError {
  const registryEntry = getRegistryCode(error.code);

  const category = (error.category ?? registryEntry?.category ?? "INTERNAL") as LAFSErrorCategory;
  const retryable = error.retryable ?? registryEntry?.retryable ?? false;

  // Derive agentAction: explicit > registry > category fallback
  const agentAction: LAFSAgentAction | undefined =
    error.agentAction ??
    getAgentAction(error.code) ??
    CATEGORY_ACTION_MAP[category];

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

export class LafsError extends Error implements LAFSError {
  code: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
  registered: boolean;
  agentAction?: LAFSAgentAction;
  escalationRequired?: boolean;
  suggestedAction?: string;
  docUrl?: string;

  constructor(error: LAFSError) {
    super(error.message);
    this.name = "LafsError";
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

export interface ParseLafsResponseOptions {
  requireRegisteredErrorCode?: boolean;
}

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
    throw new Error("Invalid LAFS envelope: success=false requires error object");
  }

  if (options.requireRegisteredErrorCode && !isRegisteredErrorCode(error.code)) {
    throw new Error(`Unregistered LAFS error code: ${error.code}`);
  }

  throw new LafsError(error);
}
