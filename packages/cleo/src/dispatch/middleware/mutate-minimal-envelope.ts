/**
 * Minimal-by-default mutate envelope middleware (T9931 / Saga T9855 / E9.4).
 *
 * Sibling to {@link createMviRecordProjection} — that middleware trims read-op
 * payloads, this one trims mutate-op payloads. For the ops declared in
 * {@link MUTATE_PROJECTION_PLANS} the data payload is replaced with a
 * `{count, ids[]}` envelope plus per-op routing extras. The single global
 * opt-out signal (`--full` / `--verbose` / `--human`, captured in
 * {@link getProjectionOptOut}) restores the verbose payload everywhere.
 *
 * `meta.mutateProjection` is stamped on every response that ran through a
 * planned mutate op so consumers can distinguish a minimal envelope from a
 * full record without re-implementing the policy.
 *
 * @module @cleocode/cleo/dispatch/middleware/mutate-minimal-envelope
 *
 * @epic T9855
 * @task T9931
 */

import {
  applyMutateProjection,
  isJsonPointer,
  MUTATE_PROJECTION_PLANS,
  type ProjectionMode,
  resolveProjectionMode,
} from '@cleocode/core';
import { getFieldContext } from '../../cli/field-context.js';
import { getProjectionOptOut } from '../../cli/projection-context.js';
import type { DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Resolve the projection mode for a single request.
 *
 * Priority: a per-request override carried as `req.params._projection` wins
 * (used by tests and any internal caller that wants to bypass the global
 * CLI flag). Otherwise the global opt-out signal from
 * {@link getProjectionOptOut} decides.
 */
function resolveModeFor(req: DispatchRequest): ProjectionMode {
  const override = req.params?.['_projection'];
  if (override === 'full' || override === 'mvi') return override;
  return resolveProjectionMode(getProjectionOptOut() || undefined);
}

type MutationBucket = 'created' | 'updated' | 'deleted';

const OPERATION_BUCKETS: Readonly<Record<string, MutationBucket>> = {
  'tasks.add': 'created',
  'tasks.add-batch': 'created',
  'tasks.update': 'updated',
  'tasks.complete': 'updated',
  'tasks.delete': 'deleted',
};

const BASE_DATA_FIELDS = new Set([
  'count',
  'created',
  'updated',
  'deleted',
  'ids',
  'fieldPathHints',
  'status',
  'completedAt',
  'changes',
  'dryRun',
  'duplicate',
  'acceptanceCriteriaIds',
  'autoCompleted',
  'cascadeDeleted',
]);

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function prevalidateMutateProjectionPointer(operation: string, pointer: string): string | null {
  if (pointer === '' || pointer === '/') return null;
  if (!pointer.startsWith('/data/')) return null;
  const [, root, field, index] = pointer.split('/').map(decodePointerToken);
  if (root !== 'data' || !field || !BASE_DATA_FIELDS.has(field)) {
    return `Pointer "${pointer}" is not available on the projected mutation envelope. Use /data/created/0, /data/updated/0, /data/deleted/0, or legacy /data/ids/0.`;
  }
  const bucket = OPERATION_BUCKETS[operation];
  if (
    index !== undefined &&
    ['created', 'updated', 'deleted'].includes(field) &&
    field !== bucket
  ) {
    return `Pointer "${pointer}" cannot resolve for ${operation}; use /data/${bucket}/0.`;
  }
  return null;
}

function fieldNotFoundResponse(req: DispatchRequest, message: string): DispatchResponse {
  return {
    meta: {
      gateway: req.gateway,
      domain: req.domain,
      operation: req.operation,
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      source: req.source,
      requestId: req.requestId,
      mutateProjection: 'mvi',
    },
    success: false,
    error: {
      code: 'E_FIELD_NOT_FOUND',
      exitCode: 4,
      message,
      details: { phase: 'prewrite-field-projection-validation' },
    },
  };
}

/**
 * Create the minimal mutate envelope middleware.
 *
 * @returns A `Middleware` that replaces mutate response data with a minimal
 *          `{count, ids[]}` envelope per {@link MUTATE_PROJECTION_PLANS} and
 *          stamps `meta.mutateProjection`.
 */
export function createMutateMinimalEnvelope(): Middleware {
  return async (
    req: DispatchRequest,
    next: () => Promise<DispatchResponse>,
  ): Promise<DispatchResponse> => {
    // Resolve mode BEFORE stripping the override token so the per-request
    // override survives the cleanup.
    const mode = resolveModeFor(req);

    // Note: we deliberately do NOT strip the `_projection` override here.
    // The read-side MVI middleware (createMviRecordProjection) owns that
    // strip step, runs in the same pipeline, and removes the token once.
    // Stripping it twice would mask bugs where one middleware ran but the
    // other didn't.

    const opKey = `${req.domain}.${req.operation}`;
    const hasPlan = MUTATE_PROJECTION_PLANS[opKey] !== undefined;

    const field = getFieldContext().field;
    if (hasPlan && mode === 'mvi' && field && isJsonPointer(field)) {
      const validationError = prevalidateMutateProjectionPointer(opKey, field);
      if (validationError) return fieldNotFoundResponse(req, validationError);
    }

    const response = await next();

    if (!hasPlan) return response;

    if (response.success && response.data !== undefined) {
      response.data = applyMutateProjection(response.data, opKey, mode);
    }
    // Stamp the choice on every response that ran through a planned mutate
    // op, including errors — agents inspecting an error envelope can still
    // see which mode the request resolved to.
    response.meta.mutateProjection = mode;
    return response;
  };
}
