/**
 * Sticky Domain Handler (Dispatch Layer)
 *
 * Handles sticky note operations: list, show, add, convert, archive, purge.
 *
 * Type-safe dispatch via `TypedDomainHandler<StickyDispatchOps>` per ADR-058.
 * Param extraction inferred via `OpsFromCore<typeof stickyCoreOps>`.
 * Zero `params?.x as Type` casts at call sites.
 *
 * T1537 convert split: the old monolithic `convert` branch is replaced by
 * four typed sub-operation wrappers keyed as `convert.task`, `convert.memory`,
 * `convert.session_note`, and `convert.task_note`. The public dispatch surface
 * retains the single `convert` operation; the `mutate` gateway uses the
 * `targetType` discriminant to route to the correct wrapper, then delegates
 * to `typedDispatch` for type-safe param extraction.
 *
 * @task T5280
 * @epic T5267
 * @task T1535 — OpsFromCore migration per ADR-058
 * @task T1537 — convert handler sub-operation split
 */

import type {
  StickyAddParams,
  StickyArchiveParams,
  StickyListParams,
  StickyPurgeParams,
  StickyShowParams,
} from '@cleocode/contracts/operations/sticky';
import { getLogger, getProjectRoot } from '@cleocode/core';
import type {
  StickyConvertMemoryParams,
  StickyConvertResult,
  StickyConvertSessionNoteParams,
  StickyConvertTaskNoteParams,
  StickyConvertTaskParams,
} from '@cleocode/core/internal';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../adapters/typed.js';
import {
  stickyAdd,
  stickyArchive,
  stickyConvertToMemory,
  stickyConvertToSessionNote,
  stickyConvertToTask,
  stickyConvertToTaskNote,
  stickyListFiltered,
  stickyPurge,
  stickyShow,
} from '../engines/sticky-engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

const log = getLogger('domain:sticky');

// ---------------------------------------------------------------------------
// Core op wrappers — single-param functions for OpsFromCore inference
// ---------------------------------------------------------------------------

/** @task T1535 */
async function stickyListOp(params: StickyListParams) {
  return stickyListFiltered(
    getProjectRoot(),
    {
      status: params.status,
      color: params.color,
      priority: params.priority,
      tags: params.tags,
    },
    params.limit,
    params.offset,
  );
}

/** @task T1535 */
async function stickyShowOp(params: StickyShowParams) {
  return stickyShow(getProjectRoot(), params.stickyId);
}

/** @task T1535 */
async function stickyAddOp(params: StickyAddParams) {
  return stickyAdd(getProjectRoot(), {
    content: params.content,
    tags: params.tags,
    color: params.color,
    priority: params.priority,
  });
}

/** @task T1535 */
async function stickyArchiveOp(params: StickyArchiveParams) {
  return stickyArchive(getProjectRoot(), params.stickyId);
}

/** @task T1535 */
async function stickyPurgeOp(params: StickyPurgeParams) {
  return stickyPurge(getProjectRoot(), params.stickyId);
}

// ---------------------------------------------------------------------------
// Convert sub-operation wrappers (T1537 split)
// ---------------------------------------------------------------------------

/** Convert sticky to new task. @task T1537 */
async function stickyConvertTaskOp(params: StickyConvertTaskParams): Promise<StickyConvertResult> {
  const result = await stickyConvertToTask(getProjectRoot(), params.stickyId, params.title);
  if (!result.success) return { taskId: undefined };
  return { taskId: (result.data as { taskId: string }).taskId };
}

/** Convert sticky to memory observation. @task T1537 */
async function stickyConvertMemoryOp(
  params: StickyConvertMemoryParams,
): Promise<StickyConvertResult> {
  const result = await stickyConvertToMemory(getProjectRoot(), params.stickyId, params.memoryType);
  if (!result.success) return { memoryId: undefined };
  return { memoryId: (result.data as { memoryId: string }).memoryId };
}

/** Convert sticky to session note. @task T1537 */
async function stickyConvertSessionNoteOp(
  params: StickyConvertSessionNoteParams,
): Promise<StickyConvertResult> {
  const result = await stickyConvertToSessionNote(
    getProjectRoot(),
    params.stickyId,
    params.sessionId,
  );
  if (!result.success) return { sessionId: undefined };
  return { sessionId: (result.data as { sessionId: string }).sessionId };
}

/** Attach sticky as note on an existing task. @task T1537 */
async function stickyConvertTaskNoteOp(
  params: StickyConvertTaskNoteParams,
): Promise<StickyConvertResult> {
  const result = await stickyConvertToTaskNote(getProjectRoot(), params.stickyId, params.taskId);
  if (!result.success) return { taskId: undefined };
  return { taskId: (result.data as { taskId: string }).taskId };
}

// ---------------------------------------------------------------------------
// Core op registry
// ---------------------------------------------------------------------------

/**
 * Sticky operation registry for `OpsFromCore<typeof stickyCoreOps>` inference.
 *
 * @task T1535 — OpsFromCore migration
 * @task T1537 — convert sub-operation split
 */
const stickyCoreOps = {
  list: stickyListOp,
  show: stickyShowOp,
  add: stickyAddOp,
  archive: stickyArchiveOp,
  purge: stickyPurgeOp,
  'convert.task': stickyConvertTaskOp,
  'convert.memory': stickyConvertMemoryOp,
  'convert.session_note': stickyConvertSessionNoteOp,
  'convert.task_note': stickyConvertTaskNoteOp,
} as const;

// ---------------------------------------------------------------------------
// Typed operation record
// ---------------------------------------------------------------------------

/** Inferred typed operation record for the sticky domain (ADR-058 T1535). */
export type StickyDispatchOps = OpsFromCore<typeof stickyCoreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler
// ---------------------------------------------------------------------------

/**
 * Inner typed handler for sticky operations.
 *
 * @task T1535 — sticky OpsFromCore migration
 * @task T1537 — convert sub-operation split
 */
const _stickyTypedHandler = defineTypedHandler<StickyDispatchOps>('sticky', {
  list: async (params) => {
    const result = await stickyCoreOps.list(params);
    if (!result.success) {
      return lafsError(result.error.code, result.error.message, 'list');
    }
    return lafsSuccess(result.data, 'list', result.page ? { page: result.page } : undefined);
  },

  show: async (params) => {
    if (!params.stickyId) return lafsError('E_INVALID_INPUT', 'stickyId is required', 'show');
    const result = await stickyCoreOps.show(params);
    return result.success
      ? lafsSuccess(result.data, 'show')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'show');
  },

  add: async (params) => {
    if (!params.content) return lafsError('E_INVALID_INPUT', 'content is required', 'add');
    const result = await stickyCoreOps.add(params);
    return result.success
      ? lafsSuccess(result.data, 'add')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'add');
  },

  archive: async (params) => {
    if (!params.stickyId) return lafsError('E_INVALID_INPUT', 'stickyId is required', 'archive');
    const result = await stickyCoreOps.archive(params);
    return result.success
      ? lafsSuccess(result.data, 'archive')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'archive');
  },

  purge: async (params) => {
    if (!params.stickyId) return lafsError('E_INVALID_INPUT', 'stickyId is required', 'purge');
    const result = await stickyCoreOps.purge(params);
    return result.success
      ? lafsSuccess(result.data, 'purge')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'purge');
  },

  'convert.task': async (params) => {
    if (!params.stickyId)
      return lafsError('E_INVALID_INPUT', 'stickyId is required', 'convert.task');
    const data = await stickyCoreOps['convert.task'](params);
    return data.taskId
      ? lafsSuccess(data, 'convert.task')
      : lafsError('E_CONVERT_FAILED', 'convert to task failed', 'convert.task');
  },

  'convert.memory': async (params) => {
    if (!params.stickyId)
      return lafsError('E_INVALID_INPUT', 'stickyId is required', 'convert.memory');
    const data = await stickyCoreOps['convert.memory'](params);
    return data.memoryId
      ? lafsSuccess(data, 'convert.memory')
      : lafsError('E_CONVERT_FAILED', 'convert to memory failed', 'convert.memory');
  },

  'convert.session_note': async (params) => {
    if (!params.stickyId)
      return lafsError('E_INVALID_INPUT', 'stickyId is required', 'convert.session_note');
    const data = await stickyCoreOps['convert.session_note'](params);
    return data.sessionId
      ? lafsSuccess(data, 'convert.session_note')
      : lafsError('E_CONVERT_FAILED', 'convert to session note failed', 'convert.session_note');
  },

  'convert.task_note': async (params) => {
    if (!params.stickyId)
      return lafsError('E_INVALID_INPUT', 'stickyId is required', 'convert.task_note');
    if (!params.taskId)
      return lafsError(
        'E_INVALID_INPUT',
        'taskId is required for task_note conversion',
        'convert.task_note',
      );
    const data = await stickyCoreOps['convert.task_note'](params);
    return data.taskId
      ? lafsSuccess(data, 'convert.task_note')
      : lafsError('E_CONVERT_FAILED', 'convert to task note failed', 'convert.task_note');
  },
});

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>(['list', 'show']);
const MUTATE_OPS = new Set<string>(['add', 'convert', 'archive', 'purge']);

const CONVERT_TARGET_TO_KEY = {
  task: 'convert.task',
  memory: 'convert.memory',
  session_note: 'convert.session_note',
  task_note: 'convert.task_note',
} as const satisfies Record<string, keyof StickyDispatchOps>;

type StickyConvertTargetType = keyof typeof CONVERT_TARGET_TO_KEY;

function envelopeToDispatch(
  envelope: Awaited<ReturnType<typeof typedDispatch<StickyDispatchOps, keyof StickyDispatchOps>>>,
  gateway: string,
  operation: string,
  startTime: number,
): DispatchResponse {
  if (envelope.success) {
    const withPage = envelope as typeof envelope & {
      page?: import('@cleocode/contracts').LAFSPage;
    };
    return {
      meta: dispatchMeta(gateway, 'sticky', operation, startTime),
      success: true,
      data: envelope.data,
      ...(withPage.page ? { page: withPage.page } : {}),
    };
  }
  return {
    meta: dispatchMeta(gateway, 'sticky', operation, startTime),
    success: false,
    error: {
      code: envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
      message: envelope.error?.message ?? 'Unknown error',
    },
  };
}

// ---------------------------------------------------------------------------
// StickyHandler
// ---------------------------------------------------------------------------

/**
 * Dispatch handler for the sticky domain.
 *
 * @task T1535 — OpsFromCore migration per ADR-058
 * @task T1537 — convert sub-operation split
 */
export class StickyHandler implements DomainHandler {
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'sticky', operation, startTime);
    }
    try {
      const envelope = await typedDispatch(
        _stickyTypedHandler,
        operation as keyof StickyDispatchOps & string,
        params ?? {},
      );
      return envelopeToDispatch(envelope, 'query', operation, startTime);
    } catch (error) {
      log.error({ gateway: 'query', domain: 'sticky', operation, err: error }, String(error));
      return handleErrorResult('query', 'sticky', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'sticky', operation, startTime);
    }
    try {
      if (operation === 'convert') {
        const targetType = params?.['targetType'] as StickyConvertTargetType | undefined;
        if (!targetType || !(targetType in CONVERT_TARGET_TO_KEY)) {
          return {
            meta: dispatchMeta('mutate', 'sticky', operation, startTime),
            success: false,
            error: {
              code: 'E_INVALID_INPUT',
              message: 'targetType is required (task, memory, session_note, or task_note)',
            },
          };
        }
        const subOp = CONVERT_TARGET_TO_KEY[targetType];
        const envelope = await typedDispatch(_stickyTypedHandler, subOp, params ?? {});
        return envelopeToDispatch(envelope, 'mutate', operation, startTime);
      }
      const envelope = await typedDispatch(
        _stickyTypedHandler,
        operation as keyof StickyDispatchOps & string,
        params ?? {},
      );
      return envelopeToDispatch(envelope, 'mutate', operation, startTime);
    } catch (error) {
      log.error({ gateway: 'mutate', domain: 'sticky', operation, err: error }, String(error));
      return handleErrorResult('mutate', 'sticky', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list', 'show'],
      mutate: ['add', 'convert', 'archive', 'purge'],
    };
  }
}
