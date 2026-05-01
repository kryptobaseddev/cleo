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
 * Param extraction is type-safe via OpsFromCore<typeof coreTasks.tasksCoreOps>
 * (T1445 — OpsFromCore inference migration). Zero per-op Params/Result
 * imports from contracts. Zero `as X` param casts at call sites.
 *
 * @epic T4820
 * @task T4818
 * @task T1425 — typed-dispatch migration
 * @task T1445 — OpsFromCore inference migration
 */

import type { tasks as coreTasks } from '@cleocode/core';
import { getLogger, getProjectRoot } from '@cleocode/core';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
  wrapCoreResult,
} from '../adapters/typed.js';
import {
  addTaskWithSessionScope,
  completeTaskStrict,
  taskAnalyze,
  taskArchive,
  taskBlockers,
  taskCancel,
  taskClaim,
  taskComplexityEstimate,
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
// OpsFromCore inference (T1445 — Core as type SSoT)
//
// TasksOps is derived from the Core operation signature registry so that
// params/results are always in sync with Core's declared contracts, not
// manually duplicated in the dispatch layer.
// ---------------------------------------------------------------------------

type TasksOps = OpsFromCore<typeof coreTasks.tasksCoreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler (T1425 / T1445 — typed-dispatch + OpsFromCore migration)
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
      return wrapCoreResult(await taskShowIvtrHistory(projectRoot, params.taskId), 'show');
    }
    if (params.history) {
      return wrapCoreResult(await taskShowWithHistory(projectRoot, params.taskId, true), 'show');
    }
    return wrapCoreResult(await taskShow(projectRoot, params.taskId), 'show');
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
    // Attach page metadata if present in engine result
    if (result.page) {
      return { success: true as const, data: result.data, page: result.page };
    }
    return lafsSuccess(result.data, 'list');
  },

  find: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskFind(projectRoot, params.query, params.limit, {
        id: params.id,
        exact: params.exact,
        status: params.status,
        includeArchive: params.includeArchive,
        offset: params.offset,
        fields: params.fields,
        verbose: params.verbose,
        // T944: role filter
        role: params.role,
      }),
      'find',
    );
  },

  tree: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskTree(projectRoot, params.taskId, params.withBlockers), 'tree');
  },

  blockers: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskBlockers(projectRoot, params), 'blockers');
  },

  depends: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.action === 'overview') {
      return wrapCoreResult(await taskDepsOverview(projectRoot), 'depends');
    }
    if (params.action === 'cycles') {
      return wrapCoreResult(await taskDepsCycles(projectRoot), 'depends');
    }
    if (!params.taskId) {
      return lafsError(
        'E_INVALID_INPUT',
        'taskId is required (or use action: overview|cycles)',
        'depends',
      );
    }
    return wrapCoreResult(
      await taskDepends(projectRoot, params.taskId, params.direction, params.tree),
      'depends',
    );
  },

  analyze: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskAnalyze(projectRoot, params.taskId, { tierLimit: params.tierLimit }),
      'analyze',
    );
  },

  impact: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskImpact(projectRoot, params.change, params.matchLimit),
      'impact',
    );
  },

  next: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskNext(projectRoot, params), 'next');
  },

  plan: async (_params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskPlan(projectRoot), 'plan');
  },

  relates: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.mode) {
      return wrapCoreResult(
        await taskRelatesFind(projectRoot, params.taskId, {
          mode: params.mode,
          threshold: params.threshold,
        }),
        'relates',
      );
    }
    return wrapCoreResult(await taskRelates(projectRoot, params.taskId), 'relates');
  },

  'complexity.estimate': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskComplexityEstimate(projectRoot, { taskId: params.taskId }),
      'complexity.estimate',
    );
  },

  history: async (params) => {
    const projectRoot = getProjectRoot();
    if (params.taskId) {
      return wrapCoreResult(await taskHistory(projectRoot, params.taskId, params.limit), 'history');
    }
    return wrapCoreResult(await taskWorkHistory(projectRoot), 'history');
  },

  current: async (_params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskCurrentGet(projectRoot), 'current');
  },

  'label.list': async (_params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskLabelList(projectRoot), 'label.list');
  },

  'sync.links': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskSyncLinks(projectRoot, params), 'sync.links');
  },

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  add: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await addTaskWithSessionScope(projectRoot, {
        title: params.title,
        description: typeof params.description === 'string' ? params.description : undefined,
        parent: params.parent,
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
        // T944: orthogonal axes — role is the canonical wire field (ADR-057 D2)
        role: params.role,
        scope: params.scope,
        severity: params.severity,
      }),
      'add',
    );
  },

  update: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskUpdate(projectRoot, params.taskId, {
        title: params.title,
        description: params.description,
        status: params.status,
        priority: params.priority,
        notes: params.notes,
        labels: params.labels,
        addLabels: params.addLabels,
        removeLabels: params.removeLabels,
        depends: params.depends,
        addDepends: params.addDepends,
        removeDepends: params.removeDepends,
        acceptance: params.acceptance,
        // ADR-057 D2: canonical wire field — no alias fallback
        parent: params.parent,
        type: params.type,
        size: params.size,
        // T1014: wire --files through dispatch to engine (parity with add).
        files: params.files,
        // T834 / ADR-051 Decision 4: wire --pipelineStage end-to-end.
        pipelineStage: params.pipelineStage,
      }),
      'update',
    );
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
    const result = await completeTaskStrict(projectRoot, params.taskId, {
      notes: params.notes,
      overrideReason: params.overrideReason,
      acknowledgeRisk: params.acknowledgeRisk,
    });
    // T994: Track memory usage on task completion (fire-and-forget; must not block).
    // SSoT-EXEMPT: fire-and-forget side-effect that must not block the complete flow
    setImmediate(async () => {
      try {
        const { trackMemoryUsage } = await import('@cleocode/core/internal');
        await trackMemoryUsage(projectRoot, params.taskId, true, params.taskId, 'success');
      } catch {
        // Quality tracking errors must never surface to the complete flow
      }
    });
    return wrapCoreResult(result, 'complete');
  },

  cancel: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskCancel(projectRoot, params.taskId, params.reason), 'cancel');
  },

  delete: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskDelete(projectRoot, params.taskId, params.force), 'delete');
  },

  archive: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskArchive(projectRoot, params.taskId, params.before, {
        taskIds: params.taskIds,
        includeCancelled: params.includeCancelled,
        dryRun: params.dryRun,
      }),
      'archive',
    );
  },

  restore: async (params) => {
    const projectRoot = getProjectRoot();
    // SSoT-EXEMPT: from param routes to different engine fns (T5615/T5671 consolidation)
    if (params.from === 'done') {
      return wrapCoreResult(
        await taskReopen(projectRoot, params.taskId, {
          status: params.status,
          reason: params.reason,
        }),
        'restore',
      );
    }
    if (params.from === 'archived') {
      return wrapCoreResult(
        await taskUnarchive(projectRoot, params.taskId, {
          status: params.status,
          preserveStatus: params.preserveStatus,
        }),
        'restore',
      );
    }
    return wrapCoreResult(
      await taskRestore(projectRoot, params.taskId, {
        cascade: params.cascade,
        notes: params.notes,
      }),
      'restore',
    );
  },

  reparent: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskReparent(projectRoot, params.taskId, params.newParentId ?? null),
      'reparent',
    );
  },

  reorder: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskReorder(projectRoot, params.taskId, params.position),
      'reorder',
    );
  },

  'relates.add': async (params) => {
    const projectRoot = getProjectRoot();
    // SSoT-EXEMPT: targetId is a backward-compat alias for relatedId (T5149); both fields exist in the relates.add params type by design
    const relatedId = params.relatedId ?? params.targetId;
    if (!relatedId) {
      return lafsError('E_INVALID_INPUT', 'relatedId (or targetId) is required', 'relates.add');
    }
    return wrapCoreResult(
      await taskRelatesAdd(projectRoot, params.taskId, relatedId, params.type, params.reason),
      'relates.add',
    );
  },

  start: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskStart(projectRoot, params.taskId), 'start');
  },

  stop: async (_params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskStop(projectRoot), 'stop');
  },

  'sync.reconcile': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskSyncReconcile(projectRoot, {
        providerId: params.providerId,
        externalTasks: params.externalTasks,
        dryRun: params.dryRun,
        conflictPolicy: params.conflictPolicy,
        defaultPhase: params.defaultPhase,
        defaultLabels: params.defaultLabels,
      }),
      'sync.reconcile',
    );
  },

  'sync.links.remove': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskSyncLinksRemove(projectRoot, params.providerId),
      'sync.links.remove',
    );
  },

  claim: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskClaim(projectRoot, params.taskId, params.agentId), 'claim');
  },

  unclaim: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskUnclaim(projectRoot, params.taskId), 'unclaim');
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
 * fully type-safe via the T1445 OpsFromCore inference adapter.
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
