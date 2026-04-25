/**
 * Tasks Domain Handler (Dispatch Layer)
 *
 * Handles all task CRUD and non-CRUD operations: show, list, find, exists,
 * tree, blockers, depends, analyze, next, relates, complexity.estimate,
 * current, add, update, complete, delete, archive, restore, reparent,
 * promote, reorder, relates.add, start, stop, sync.reconcile, sync.links,
 * sync.links.remove.
 *
 * Query operations delegate to task-engine; start/stop/current delegate
 * to session-engine (which hosts task-work functions).
 *
 * Operations are inferred from Core function signatures via OpsFromCore
 * (T1435 — dispatch refactor Wave 1). Zero per-op *Params/*Result type
 * imports from @cleocode/contracts; Core function signatures are the
 * single source of truth for Params/Result shapes.
 *
 * @epic T1435
 * @task T1445 — tasks domain refactor
 * @task T1425 — typed-dispatch migration
 */

import { getLogger, getProjectRoot } from '@cleocode/core';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../adapters/typed.js';
import {
  taskAnalyze,
  taskArchive,
  taskBlockers,
  taskCancel,
  taskClaim,
  taskCompleteStrict,
  taskComplexityEstimate,
  taskCreate,
  taskCurrentGet,
  taskDelete,
  taskDepends,
  taskDepsCycles,
  taskDepsOverview,
  taskFind,
  taskHistory,
  taskImpact,
  taskLabelList,
  taskList,
  taskNext,
  taskPlan,
  taskRelates,
  taskRelatesAdd,
  taskRelatesFind,
  taskReopen,
  taskReorder,
  taskReparent,
  taskRestore,
  taskShow,
  taskShowIvtrHistory,
  taskShowWithHistory,
  taskStart,
  taskStop,
  taskSyncLinks,
  taskSyncLinksRemove,
  taskSyncReconcile,
  taskTree,
  taskUnarchive,
  taskUnclaim,
  taskUpdate,
  taskWorkHistory,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Core operations registry (T1435 — source of truth for Params/Result)
// ---------------------------------------------------------------------------

/**
 * Map of task operations to their Core implementations.
 *
 * Each operation maps to the Core function that implements it. The mapping
 * uses operation names as dispatch keys (no domain prefix). Core function
 * signatures are the single source of truth for parameter and result types
 * via the OpsFromCore inference below.
 *
 * @task T1445 — tasks domain refactor (Wave 1 of T1435)
 */
const coreOps = {
  // Query operations
  show: taskShow,
  list: taskList,
  find: taskFind,
  tree: taskTree,
  blockers: taskBlockers,
  depends: taskDepends,
  analyze: taskAnalyze,
  impact: taskImpact,
  next: taskNext,
  plan: taskPlan,
  relates: taskRelates,
  'complexity.estimate': taskComplexityEstimate,
  history: taskHistory,
  current: taskCurrentGet,
  'label.list': taskLabelList,
  'sync.links': taskSyncLinks,
  // Mutate operations
  add: taskCreate,
  update: taskUpdate,
  complete: taskCompleteStrict,
  cancel: taskCancel,
  delete: taskDelete,
  archive: taskArchive,
  restore: taskRestore,
  reparent: taskReparent,
  reorder: taskReorder,
  'relates.add': taskRelatesAdd,
  start: taskStart,
  stop: taskStop,
  'sync.reconcile': taskSyncReconcile,
  'sync.links.remove': taskSyncLinksRemove,
  claim: taskClaim,
  unclaim: taskUnclaim,
} as const;

/**
 * Typed operation record for the tasks domain.
 *
 * Inferred from Core function signatures via OpsFromCore<typeof coreOps>.
 * Each entry maps an operation name to its [Params, Result] tuple.
 *
 * @task T1445 — tasks domain refactor (Wave 1 of T1435)
 */
type TasksOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler (T1425 — typed-dispatch migration)
//
// The typed handler holds all per-op logic with fully-narrowed params.
// The outer DomainHandler class delegates to it so the registry sees the
// expected query/mutate interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _tasksTypedHandler = defineTypedHandler<TasksOps>('tasks', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  show: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.ivtrHistory) {
      const result = await taskShowIvtrHistory(projectRoot, params.taskId);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'show',
        );
      }
      return lafsSuccess(result.data, 'show');
    }
    if (params.history) {
      const result = await taskShowWithHistory(projectRoot, params.taskId, true);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'show',
        );
      }
      return lafsSuccess(result.data, 'show');
    }
    const result = await taskShow(projectRoot, params.taskId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'show',
      );
    }
    return lafsSuccess(result.data, 'show');
  },

  list: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskList(projectRoot, {
      parent: params.parent,
      status: params.status,
      priority: params.priority,
      type: params.type,
      phase: params.phase,
      label: params.label,
      children: params.children,
      limit: params.limit,
      offset: params.offset,
      compact: params.compact,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'list',
      );
    }
    const envelope = lafsSuccess(result.data, 'list');
    // Attach page metadata if present in engine result
    if (result.page) {
      return {
        success: true as const,
        data: result.data,
        page: result.page,
      };
    }
    return envelope;
  },

  find: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskFind(projectRoot, params.query, params.limit, {
      id: params.id,
      exact: params.exact,
      status: params.status,
      includeArchive: params.includeArchive,
      offset: params.offset,
      fields: params.fields,
      verbose: params.verbose,
      // T944: role filter
      role: params.role,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'find',
      );
    }
    return lafsSuccess(result.data, 'find');
  },

  tree: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskTree(projectRoot, params.taskId, params.withBlockers);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'tree',
      );
    }
    return lafsSuccess(result.data, 'tree');
  },

  blockers: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskBlockers(projectRoot, params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'blockers',
      );
    }
    return lafsSuccess(result.data, 'blockers');
  },

  depends: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.action === 'overview') {
      const result = await taskDepsOverview(projectRoot);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'depends',
        );
      }
      return lafsSuccess(result.data, 'depends');
    }
    if (params.action === 'cycles') {
      const result = await taskDepsCycles(projectRoot);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'depends',
        );
      }
      return lafsSuccess(result.data, 'depends');
    }
    if (!params.taskId) {
      return lafsError(
        'E_INVALID_INPUT',
        'taskId is required (or use action: overview|cycles)',
        'depends',
      );
    }
    const result = await taskDepends(projectRoot, params.taskId, params.direction, params.tree);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'depends',
      );
    }
    return lafsSuccess(result.data, 'depends');
  },

  analyze: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskAnalyze(projectRoot, params.taskId, { tierLimit: params.tierLimit });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'analyze',
      );
    }
    return lafsSuccess(result.data, 'analyze');
  },

  impact: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskImpact(projectRoot, params.change, params.matchLimit);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'impact',
      );
    }
    return lafsSuccess(result.data, 'impact');
  },

  next: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskNext(projectRoot, params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'next',
      );
    }
    return lafsSuccess(result.data, 'next');
  },

  plan: async (_params) => {
    const projectRoot = getProjectRoot();
    const result = await taskPlan(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'plan',
      );
    }
    return lafsSuccess(result.data, 'plan');
  },

  relates: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.mode) {
      const result = await taskRelatesFind(projectRoot, params.taskId, {
        mode: params.mode,
        threshold: params.threshold,
      });
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'relates',
        );
      }
      return lafsSuccess(result.data, 'relates');
    }
    const result = await taskRelates(projectRoot, params.taskId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'relates',
      );
    }
    return lafsSuccess(result.data, 'relates');
  },

  'complexity.estimate': async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskComplexityEstimate(projectRoot, { taskId: params.taskId });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'complexity.estimate',
      );
    }
    return lafsSuccess(result.data, 'complexity.estimate');
  },

  history: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.taskId) {
      const result = await taskHistory(projectRoot, params.taskId, params.limit);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'history',
        );
      }
      return lafsSuccess(result.data, 'history');
    }
    const result = await taskWorkHistory(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'history',
      );
    }
    return lafsSuccess(result.data, 'history');
  },

  current: async (_params) => {
    const projectRoot = getProjectRoot();
    const result = await taskCurrentGet(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'current',
      );
    }
    return lafsSuccess(result.data, 'current');
  },

  'label.list': async (_params) => {
    const projectRoot = getProjectRoot();
    const result = await taskLabelList(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'label.list',
      );
    }
    return lafsSuccess(result.data, 'label.list');
  },

  'sync.links': async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskSyncLinks(projectRoot, params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'sync.links',
      );
    }
    return lafsSuccess(result.data, 'sync.links');
  },

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  add: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskCreate(projectRoot, {
      title: params.title,
      description: typeof params.description === 'string' ? params.description : undefined,
      parent: params.parent ?? params.parentId,
      depends: params.depends,
      priority: params.priority,
      labels: params.labels,
      type: params.type,
      acceptance: params.acceptance,
      phase: params.phase,
      size: params.size,
      notes: params.notes,
      files: params.files,
      dryRun: params.dryRun,
      parentSearch: params.parentSearch,
      // T944: orthogonal axes — role accepts 'kind' alias for CLI compat
      role: params.role ?? params.kind,
      scope: params.scope,
      severity: params.severity,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'add',
      );
    }
    return lafsSuccess(result.data, 'add');
  },

  update: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskUpdate(projectRoot, params.taskId, {
      title: params.title,
      description: params.description,
      status: params.status,
      priority: params.priority,
      notes: params.notes ?? params.note,
      labels: params.labels,
      addLabels: params.addLabels,
      removeLabels: params.removeLabels,
      depends: params.depends,
      addDepends: params.addDepends,
      removeDepends: params.removeDepends,
      acceptance: params.acceptance,
      parent: params.parent ?? params.parentId,
      type: params.type,
      size: params.size,
      // T1014: wire --files through dispatch to engine (parity with add).
      files: params.files,
      // T834 / ADR-051 Decision 4: wire --pipelineStage end-to-end.
      pipelineStage: params.pipelineStage,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'update',
      );
    }
    return lafsSuccess(result.data, 'update');
  },

  complete: async (params) => {
    const projectRoot = getProjectRoot();
    // T833 / ADR-051 Decision 3: --force has been removed. Any caller
    // passing `force` gets a structured rejection pointing to the ADR.
    if (params.force !== undefined) {
      return lafsError(
        'E_FLAG_REMOVED',
        '--force has been removed. Use evidence-based `cleo verify --gate … --evidence …` or set CLEO_OWNER_OVERRIDE=1 on verify for emergency bypass (audited). See ADR-051.',
        'complete',
      );
    }
    const result = await taskCompleteStrict(projectRoot, params.taskId, params.notes);
    // T994: Track memory usage on task completion (fire-and-forget; must not block).
    setImmediate(async () => {
      try {
        const { trackMemoryUsage } = await import('@cleocode/core/internal');
        await trackMemoryUsage(projectRoot, params.taskId, true, params.taskId, 'success');
      } catch {
        // Quality tracking errors must never surface to the complete flow
      }
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'complete',
      );
    }
    return lafsSuccess(result.data, 'complete');
  },

  cancel: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskCancel(projectRoot, params.taskId, params.reason);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'cancel',
      );
    }
    return lafsSuccess(result.data, 'cancel');
  },

  delete: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskDelete(projectRoot, params.taskId, params.force);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'delete',
      );
    }
    return lafsSuccess(result.data, 'delete');
  },

  archive: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskArchive(projectRoot, params.taskId, params.before, {
      taskIds: params.taskIds,
      includeCancelled: params.includeCancelled,
      dryRun: params.dryRun,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'archive',
      );
    }
    return lafsSuccess(result.data, 'archive');
  },

  restore: async (params) => {
    const projectRoot = getProjectRoot();
    // Consolidated: from param routes to reopen/unarchive logic (T5615/T5671)
    if (params.from === 'done') {
      const result = await taskReopen(projectRoot, params.taskId, {
        status: params.status,
        reason: params.reason,
      });
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'restore',
        );
      }
      return lafsSuccess(result.data, 'restore');
    }
    if (params.from === 'archived') {
      const result = await taskUnarchive(projectRoot, params.taskId, {
        status: params.status,
        preserveStatus: params.preserveStatus,
      });
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'restore',
        );
      }
      return lafsSuccess(result.data, 'restore');
    }
    const result = await taskRestore(projectRoot, params.taskId, {
      cascade: params.cascade,
      notes: params.notes,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'restore',
      );
    }
    return lafsSuccess(result.data, 'restore');
  },

  reparent: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskReparent(projectRoot, params.taskId, params.newParentId ?? null);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'reparent',
      );
    }
    return lafsSuccess(result.data, 'reparent');
  },

  reorder: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskReorder(projectRoot, params.taskId, params.position);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'reorder',
      );
    }
    return lafsSuccess(result.data, 'reorder');
  },

  'relates.add': async (params) => {
    const projectRoot = getProjectRoot();
    // Accept both targetId and relatedId for compatibility (T5149)
    const relatedId = params.relatedId ?? params.targetId;
    if (!relatedId) {
      return lafsError('E_INVALID_INPUT', 'relatedId (or targetId) is required', 'relates.add');
    }
    const result = await taskRelatesAdd(
      projectRoot,
      params.taskId,
      relatedId,
      params.type,
      params.reason,
    );
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'relates.add',
      );
    }
    return lafsSuccess(result.data, 'relates.add');
  },

  start: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskStart(projectRoot, params.taskId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'start',
      );
    }
    return lafsSuccess(result.data, 'start');
  },

  stop: async (_params) => {
    const projectRoot = getProjectRoot();
    const result = await taskStop(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'stop',
      );
    }
    return lafsSuccess(result.data, 'stop');
  },

  'sync.reconcile': async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskSyncReconcile(projectRoot, {
      providerId: params.providerId,
      externalTasks: params.externalTasks,
      dryRun: params.dryRun,
      conflictPolicy: params.conflictPolicy,
      defaultPhase: params.defaultPhase,
      defaultLabels: params.defaultLabels,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'sync.reconcile',
      );
    }
    return lafsSuccess(result.data, 'sync.reconcile');
  },

  'sync.links.remove': async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskSyncLinksRemove(projectRoot, params.providerId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'sync.links.remove',
      );
    }
    return lafsSuccess(result.data, 'sync.links.remove');
  },

  claim: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskClaim(projectRoot, params.taskId, params.agentId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'claim',
      );
    }
    return lafsSuccess(result.data, 'claim');
  },

  unclaim: async (params) => {
    const projectRoot = getProjectRoot();
    const result = await taskUnclaim(projectRoot, params.taskId);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'unclaim',
      );
    }
    return lafsSuccess(result.data, 'unclaim');
  },
});

// ---------------------------------------------------------------------------
// Envelope-to-EngineResult adapter
//
// Converts a LafsEnvelope into the minimal EngineResult shape accepted by
// wrapResult. The error.code is coerced to string since LafsErrorDetail.code
// is typed as `number | string` but EngineResult.error.code requires string.
// ---------------------------------------------------------------------------

/**
 * Convert a LAFS envelope into the minimal EngineResult shape expected by
 * {@link wrapResult}.
 *
 * @param envelope - The LAFS envelope returned by the typed op function.
 * @returns An object compatible with the `EngineResult` type in `_base.ts`.
 *
 * @internal
 */
function envelopeToEngineResult(envelope: {
  readonly success: boolean;
  readonly data?: unknown;
  readonly page?: import('@cleocode/lafs').LAFSPage;
  readonly error?: { readonly code: number | string; readonly message: string };
}): {
  success: boolean;
  data?: unknown;
  page?: import('@cleocode/lafs').LAFSPage;
  error?: { code: string; message: string };
} {
  if (envelope.success) {
    return { success: true, data: envelope.data, page: envelope.page };
  }
  return {
    success: false,
    error: {
      code: String(envelope.error?.code ?? 'E_INTERNAL'),
      message: envelope.error?.message ?? 'Unknown error',
    },
  };
}

// ---------------------------------------------------------------------------
// Op sets — validated before dispatch to prevent unsupported-op errors
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>([
  'show',
  'list',
  'find',
  'tree',
  'blockers',
  'depends',
  'analyze',
  'impact',
  'next',
  'plan',
  'relates',
  'complexity.estimate',
  'history',
  'current',
  'label.list',
  'sync.links',
]);

const MUTATE_OPS = new Set<string>([
  'add',
  'update',
  'complete',
  'cancel',
  'delete',
  'archive',
  'restore',
  'reparent',
  'reorder',
  'relates.add',
  'start',
  'stop',
  'sync.reconcile',
  'sync.links.remove',
  'claim',
  'unclaim',
]);

// ---------------------------------------------------------------------------
// TasksHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `tasks` domain.
 *
 * Delegates all per-op logic to the typed inner handler
 * `_tasksTypedHandler` (a `TypedDomainHandler<TasksOps>`). This satisfies
 * the registry's `DomainHandler` interface while keeping every param access
 * fully type-safe via the T1425 typed-dispatch adapter.
 *
 * Special cases handled at op level (no raw-params casts needed):
 * - `impact` and `depends` validate required fields and return structured errors
 * - `complete` guards against the removed `--force` flag (ADR-051)
 * - `relates.add` accepts both `relatedId` and `targetId` aliases
 * - `claim`/`unclaim` validate required fields before delegating
 */
export class TasksHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Execute a read-only tasks query operation.
   *
   * @param operation - The tasks query op name (e.g. 'show', 'list').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'tasks', operation, startTime);
    }

    // Special validation: impact requires `change` param
    if (operation === 'impact' && !params?.change) {
      return errorResult(
        'query',
        'tasks',
        operation,
        'E_INVALID_INPUT',
        'change is required (free-text description of the proposed change)',
        startTime,
      );
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid tasks query op name at this point.
      const envelope = await typedDispatch(
        _tasksTypedHandler,
        operation as keyof TasksOps & string,
        params ?? {},
      );
      return wrapResult(envelopeToEngineResult(envelope), 'query', 'tasks', operation, startTime);
    } catch (error) {
      getLogger('domain:tasks').error(
        { gateway: 'query', domain: 'tasks', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'tasks', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  /**
   * Execute a state-modifying tasks mutation operation.
   *
   * @param operation - The tasks mutate op name (e.g. 'add', 'update').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'tasks', operation, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid tasks mutate op name at this point.
      const envelope = await typedDispatch(
        _tasksTypedHandler,
        operation as keyof TasksOps & string,
        params ?? {},
      );
      return wrapResult(envelopeToEngineResult(envelope), 'mutate', 'tasks', operation, startTime);
    } catch (error) {
      getLogger('domain:tasks').error(
        { gateway: 'mutate', domain: 'tasks', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'tasks', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'show',
        'list',
        'find',
        'tree',
        'blockers',
        'depends',
        'analyze',
        'impact',
        'next',
        'plan',
        'relates',
        'complexity.estimate',
        'history',
        'current',
        'label.list',
        'sync.links',
      ],
      mutate: [
        'add',
        'update',
        'complete',
        'cancel',
        'delete',
        'archive',
        'restore',
        'reparent',
        'reorder',
        'relates.add',
        'start',
        'stop',
        'sync.reconcile',
        'sync.links.remove',
        'claim',
        'unclaim',
      ],
    };
  }
}
