/**
 * MVI-aware envelope projection.
 * Strips fields based on declared MVI level to reduce token cost.
 * At 'minimal': ~38 tokens per error (vs ~162 at 'full').
 */
import type { LAFSEnvelope, LAFSError, LAFSMeta, MVILevel } from './types.js';

/** Extended meta type that includes optional _tokenEstimate from budget enforcement. */
type MetaWithEstimate = LAFSMeta & { _tokenEstimate?: unknown };

/** Extended error type that includes optional agent-action fields (may be added by types agent). */
type ErrorWithAgent = LAFSError & {
  agentAction?: string;
  escalationRequired?: boolean;
};

/**
 * Project an envelope to the declared MVI verbosity level.
 * - 'minimal': Only fields required for agent control flow
 * - 'standard': All commonly useful fields (current default behavior)
 * - 'full': Complete echo-back including request parameters
 * - 'custom': No projection (controlled by _fields)
 */
export function projectEnvelope(
  envelope: LAFSEnvelope,
  mviLevel?: MVILevel,
): Record<string, unknown> {
  const level = mviLevel ?? envelope._meta.mvi ?? 'standard';
  switch (level) {
    case 'minimal':
      return projectMinimal(envelope);
    case 'standard':
      return projectStandard(envelope);
    case 'full':
    case 'custom':
      return envelope as unknown as Record<string, unknown>;
  }
}

function projectMinimal(env: LAFSEnvelope): Record<string, unknown> {
  const result: Record<string, unknown> = {
    success: env.success,
    _meta: projectMetaMinimal(env._meta),
  };

  if (env.success) {
    result.result = env.result;
  } else if (env.error) {
    result.error = projectErrorMinimal(env.error);
  }

  if (env._extensions && Object.keys(env._extensions).length > 0) {
    result._extensions = env._extensions;
  }

  return result;
}

function projectStandard(env: LAFSEnvelope): Record<string, unknown> {
  const result: Record<string, unknown> = {
    $schema: env.$schema,
    success: env.success,
    _meta: projectMetaStandard(env._meta),
  };

  if (env.success) {
    result.result = env.result;
  } else {
    result.result = null;
    if (env.error) {
      result.error = env.error;
    }
  }

  if (env.page) {
    result.page = env.page;
  }

  if (env._extensions && Object.keys(env._extensions).length > 0) {
    result._extensions = env._extensions;
  }

  return result;
}

function projectMetaMinimal(meta: LAFSMeta): Record<string, unknown> {
  const m = meta as MetaWithEstimate;
  const projected: Record<string, unknown> = {
    requestId: m.requestId,
    contextVersion: m.contextVersion,
  };
  if (m.sessionId) projected.sessionId = m.sessionId;
  if (m.warnings?.length) projected.warnings = m.warnings;
  if (m._tokenEstimate) projected._tokenEstimate = m._tokenEstimate;
  return projected;
}

function projectMetaStandard(meta: LAFSMeta): Record<string, unknown> {
  const m = meta as MetaWithEstimate;
  const projected: Record<string, unknown> = {
    timestamp: m.timestamp,
    operation: m.operation,
    requestId: m.requestId,
    mvi: m.mvi,
    contextVersion: m.contextVersion,
  };
  if (m.sessionId) projected.sessionId = m.sessionId;
  if (m.warnings?.length) projected.warnings = m.warnings;
  if (m._tokenEstimate) projected._tokenEstimate = m._tokenEstimate;
  return projected;
}

function projectErrorMinimal(error: LAFSError): Record<string, unknown> {
  const e = error as ErrorWithAgent;
  const projected: Record<string, unknown> = {
    code: e.code,
  };

  if (e.agentAction) {
    projected.agentAction = e.agentAction;
  }

  if (e.retryAfterMs !== null && e.retryAfterMs !== undefined) {
    projected.retryAfterMs = e.retryAfterMs;
  }

  if (e.details && Object.keys(e.details).length > 0) {
    projected.details = e.details;
  }

  if (e.escalationRequired !== undefined) {
    projected.escalationRequired = e.escalationRequired;
  }

  return projected;
}

/**
 * Estimate token count for a projected envelope.
 * Uses simple heuristic: 1 token per ~4 characters of JSON.
 */
export function estimateProjectedTokens(projected: Record<string, unknown>): number {
  const json = JSON.stringify(projected);
  return Math.ceil(json.length / 4);
}
