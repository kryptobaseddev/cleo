/**
 * Tasks Domain Handler (Dispatch Layer)
 *
 * Handles all task CRUD and non-CRUD operations: show, list, find, exists,
 * tree, blockers, depends, analyze, next, relates, complexity.estimate,
 * current, add, update, complete, delete, archive, restore, reparent,
 * promote, reorder, relates.add, relates.remove, start, stop,
 * sync.reconcile, sync.links, sync.links.remove,
 * saga.create, saga.add, saga.detach, saga.list, saga.members, saga.rollup,
 * saga.repair, saga.reconcile.
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
import { getLogger, getProjectRoot, TASKS_SUGGESTED_NEXT_BUILDERS } from '@cleocode/core';
import { taskContext } from '@cleocode/core/internal';
// Saga core ops — pure business logic moved out of dispatch in T10124.
// T10117 adds `sagaRepair` (`saga.repair`) for I5 violation cleanup.
// T10118 adds the `detach` op for repair of nested-saga relations.
// T10121 adds the `reconcile` op for idempotent cron-safe auto-close repair.
import {
  sagaAdd as coreSagaAdd,
  sagaCreate as coreSagaCreate,
  detachSagaMember as coreSagaDetach,
  sagaList as coreSagaList,
  sagaMembers as coreSagaMembers,
  reconcileSaga as coreSagaReconcile,
  repairSaga as coreSagaRepair,
  sagaRollup as coreSagaRollup,
} from '@cleocode/core/sagas';
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
  taskDepsTree,
  taskDepsValidate,
  taskFind,
  taskHistory,
  taskImpact,
  taskLabelList,
  taskList,
  taskNext,
  taskPlan,
  taskRelates,
  taskRelatesAdd,
  taskRelatesAddBatch,
  taskRelatesFind,
  taskRelatesRemove,
  taskReopen,
  taskReorder,
  taskReparent,
  taskRestore,
  taskShowOperation,
  taskSlice,
  taskStart,
  taskStop,
  taskSyncLinks,
  taskSyncLinksRemove,
  taskSyncReconcile,
  tasksAddBatchOp,
  taskTree,
  taskUnarchive,
  taskUnclaim,
  taskUpdate,
  taskWorkHistory,
} from '@cleocode/runtime/gateway';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
  wrapCoreResult,
} from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import {
  envelopeToEngineResult,
  errorResult,
  handleErrorResult,
  unsupportedOp,
  wrapResult,
} from './_base.js';

// ---------------------------------------------------------------------------
// OpsFromCore inference (T1445 — Core as type SSoT)
//
// TasksOps is derived from the Core operation signature registry so that
// params/results are always in sync with Core's declared contracts, not
// manually duplicated in the dispatch layer.
// ---------------------------------------------------------------------------

type TasksOps = OpsFromCore<typeof coreTasks.tasksCoreOps>;
type LafsEnvelope<T = unknown> = ReturnType<typeof wrapCoreResult<T>>;

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
    return wrapCoreResult(await taskShowOperation(projectRoot, params), 'show');
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
        // T944/T9072: kind filter
        kind: params.kind,
        // T9905: unified urgency surface
        urgent: params.urgent,
        // T9904: label filter — `cleo find --label <name>` (closes GH#393).
        label: params.label,
        // T10108: parent filter — `cleo find --parent <id>`. Saga-aware via
        // resolveSagaMemberIds (ADR-073 §1) so saga members surface through
        // the same routing as `cleo list --parent`.
        parent: params.parent,
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

  slice: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskSlice(projectRoot, params.taskId, {
        radius: params.radius,
        depth: params.depth,
        budget: params.budget,
        direction: params.direction,
        includeRelates: params.includeRelates,
      }),
      'slice',
    );
  },

  context: async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskContext(projectRoot, params), 'context');
  },

  'deps.validate': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await taskDepsValidate(projectRoot, params.epicId, params.scope),
      'deps.validate',
    );
  },

  'deps.tree': async (params) => {
    const projectRoot = getProjectRoot();
    if (!params.epicId) {
      return lafsError('E_INVALID_INPUT', 'epicId is required for deps.tree', 'deps.tree');
    }
    return wrapCoreResult(
      await taskDepsTree(projectRoot, params.epicId, params.format),
      'deps.tree',
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
    return wrapCoreResult(
      await taskRelates(projectRoot, params.taskId, {
        direction: params.direction,
        type: params.type,
        includeDependencies: params.includeDependencies,
      }),
      'relates',
    );
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

  'add-batch': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(
      await tasksAddBatchOp(projectRoot, {
        tasks: (params.tasks ?? []) as Parameters<typeof tasksAddBatchOp>[1]['tasks'],
        defaultParent: typeof params.defaultParent === 'string' ? params.defaultParent : undefined,
        dryRun: typeof params.dryRun === 'boolean' ? params.dryRun : undefined,
      }),
      'add-batch',
    );
  },

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
        // T944/T9072: orthogonal axes — kind is the canonical wire field
        kind: params.kind,
        scope: params.scope,
        severity: params.severity,
        // T1633: BRAIN duplicate-bypass flag
        forceDuplicate: params.forceDuplicate,
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
        addFiles: params.addFiles,
        removeFiles: params.removeFiles,
        // T834 / ADR-051 Decision 4: wire --pipelineStage end-to-end.
        pipelineStage: params.pipelineStage,
        // T944/T9072: kind axis (renamed from role)
        kind: params.kind,
        scope: params.scope,
        // T9073: severity — orthogonal to priority, valid for any kind
        severity: params.severity,
        // T1590: AC-immutability override reason
        reason: params.reason,
        // T9241: clear the free-text blockedBy reason
        clearBlockedBy: params.clearBlockedBy,
        // T9327: relates mutations
        relates: params.relates,
        addRelates: params.addRelates,
        removeRelates: params.removeRelates,
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
      // T10509 — AC-coverage gate waiver path
      waiveAc: params.waiveAc,
      waiveReason: params.waiveReason,
      // T10538 — cancelled-child waiver (PM-Core V2 agent-trust)
      cancelledChildWaiverReason: params.cancelledChildWaiverReason,
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
    return wrapCoreResult(
      await taskCancel(projectRoot, params.taskId, {
        reason: params.reason,
        children: params.children,
        force: params.force,
        cascadeThreshold: params.cascadeThreshold,
        allowCascade: params.allowCascade,
      }),
      'cancel',
    );
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

  'relates.add-batch': async (params) => {
    const projectRoot = getProjectRoot();
    return wrapCoreResult(await taskRelatesAddBatch(projectRoot, params), 'relates.add-batch');
  },

  'relates.remove': async (params) => {
    const projectRoot = getProjectRoot();
    if (!params.relatedId) {
      return lafsError('E_INVALID_INPUT', 'relatedId is required', 'relates.remove');
    }
    return wrapCoreResult(
      await taskRelatesRemove(projectRoot, params.taskId, params.relatedId, params.type),
      'relates.remove',
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
// Op sets — validated before dispatch to prevent unsupported-op errors
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>([
  'show',
  'list',
  'find',
  'tree',
  'blockers',
  'depends',
  'deps.validate',
  'deps.tree',
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
  // Saga sub-domain (ADR-073)
  'saga.list',
  'saga.members',
  'saga.rollup',
]);

const MUTATE_OPS = new Set<string>([
  'add',
  'add-batch',
  'update',
  'complete',
  'cancel',
  'delete',
  'archive',
  'restore',
  'reparent',
  'reorder',
  'relates.add',
  // T11575 — without this entry the domain mutate() gate rejects the op with
  // E_INVALID_OPERATION even though the handler exists below. Mirrors the
  // OperationDef registered in @cleocode/contracts operations-registry.
  'relates.add-batch',
  'relates.remove',
  'start',
  'stop',
  'sync.reconcile',
  'sync.links.remove',
  'claim',
  'unclaim',
  // Saga sub-domain (ADR-073)
  'saga.create',
  'saga.add',
  // T10117 — repair an I5-violating saga (detach parentId, write groups edge).
  'saga.repair',
  // T10118 — repair verb for ADR-073 §1.2 I7 violations (detach saga member).
  'saga.detach',
  // T10121 — idempotent cron-safe auto-close repair (supersedes T10098 scope).
  'saga.reconcile',
]);

// ---------------------------------------------------------------------------
// Saga sub-domain handlers (ADR-073 — T9521; T10125 dispatch shrink)
//
// THIN PASS-THROUGHS: every op delegates to the corresponding pure-business
// function in `packages/core/src/sagas/` and wraps the EngineResult in a
// LAFS envelope. NO business logic in this file.
//
// Saga T10113 (SG-SAGA-FIRST-CLASS) / Epic T10208 (E-SAGAS-CORE-MODULE).
// ---------------------------------------------------------------------------

/** saga.create — create a labeled top-level Epic. See `core/sagas/create.ts`. */
async function sagaCreate(params: Record<string, unknown>): Promise<LafsEnvelope<unknown>> {
  const title = typeof params.title === 'string' ? params.title : '';
  const description = typeof params.description === 'string' ? params.description : undefined;
  const acceptance = Array.isArray(params.acceptance) ? (params.acceptance as string[]) : undefined;
  const dryRun = params.dryRun === true;
  return wrapCoreResult(
    await coreSagaCreate(getProjectRoot(), { title, description, acceptance, dryRun }),
    'saga.create',
  );
}

/** saga.add — link an Epic to a Saga. See `core/sagas/add.ts`. */
async function sagaAdd(params: Record<string, unknown>): Promise<LafsEnvelope<unknown>> {
  const sagaId = typeof params.sagaId === 'string' ? params.sagaId : '';
  const epicId = typeof params.epicId === 'string' ? params.epicId : '';
  return wrapCoreResult(await coreSagaAdd(getProjectRoot(), { sagaId, epicId }), 'saga.add');
}

/**
 * saga.detach — remove a `task_relations.type='groups'` row between a saga
 * and a member. Idempotent + audit-logged. See `core/sagas/detach.ts`.
 *
 * @task T10118
 */
async function sagaDetach(params: Record<string, unknown>): Promise<LafsEnvelope<unknown>> {
  const sagaId = typeof params.sagaId === 'string' ? params.sagaId : '';
  const memberId = typeof params.memberId === 'string' ? params.memberId : '';
  const reason = typeof params.reason === 'string' ? params.reason : undefined;
  return wrapCoreResult(
    await coreSagaDetach(getProjectRoot(), { sagaId, memberId, reason }),
    'saga.detach',
  );
}

/** saga.list — list all top-level Sagas. See `core/sagas/list.ts`. */
async function sagaList(): Promise<LafsEnvelope<unknown>> {
  return wrapCoreResult(await coreSagaList(getProjectRoot()), 'saga.list');
}

/** saga.members — list member Epics for a Saga. See `core/sagas/members.ts`. */
async function sagaMembers(params: Record<string, unknown>): Promise<LafsEnvelope<unknown>> {
  const sagaId = typeof params.sagaId === 'string' ? params.sagaId : '';
  return wrapCoreResult(await coreSagaMembers(getProjectRoot(), { sagaId }), 'saga.members');
}

/** saga.rollup — aggregate member Epic statuses. See `core/sagas/rollup.ts`. */
async function sagaRollup(params: Record<string, unknown>): Promise<LafsEnvelope<unknown>> {
  const sagaId = typeof params.sagaId === 'string' ? params.sagaId : '';
  return wrapCoreResult(await coreSagaRollup(getProjectRoot(), { sagaId }), 'saga.rollup');
}

/**
 * saga.repair — detach an I5-violating `parentId` from a saga and re-attach
 * the former parent via `task_relations.type='groups'`. Idempotent.
 *
 * See `core/sagas/repair.ts`.
 *
 * @task T10117
 */
async function sagaRepair(params: Record<string, unknown>): Promise<LafsEnvelope<unknown>> {
  const sagaId = typeof params.sagaId === 'string' ? params.sagaId : '';
  return wrapCoreResult(await coreSagaRepair(getProjectRoot(), { sagaId }), 'saga.repair');
}

/**
 * saga.reconcile — idempotent cron-safe re-application of the T10116 saga
 * auto-close logic for any saga whose members reached 100% terminal status
 * via mutation paths OTHER than `completeTask` (bulk SQL repair, crash
 * recovery, manual state edits).
 *
 * Per-saga advisory lock + audit log at `.cleo/audit/saga-reconcile.jsonl`.
 *
 * Supersedes T10098 standalone scope. See `core/sagas/reconcile.ts`.
 *
 * @task T10121
 */
async function sagaReconcile(params: Record<string, unknown>): Promise<LafsEnvelope<unknown>> {
  const sagaId =
    typeof params.sagaId === 'string' && params.sagaId.length > 0 ? params.sagaId : undefined;
  const dryRun = params.dryRun === true;
  return wrapCoreResult(
    await coreSagaReconcile(getProjectRoot(), { sagaId, dryRun }),
    'saga.reconcile',
  );
}

/**
 * `task_relations.type='groups'` for Epics. Non-Epic children are
 * documented as conflicts.
 *
 *
 *
 * @task T10637
 */

// ---------------------------------------------------------------------------
// suggestedNext auto-population (T9921 — Saga T9855 / E8.2)
//
// After a successful dispatch, look up the per-op suggestion builder in
// `TASKS_SUGGESTED_NEXT_BUILDERS` and stamp the result onto
// `response.meta.suggestedNext`. Failures (no builder, builder throws,
// empty result) leave the response untouched — `suggestedNext` is purely
// additive metadata and must never destabilise the dispatch path.
//
// The local `pickDecoratorMetaExtensionsLocal` in renderers/index.ts
// forwards `suggestedNext` from `response.meta` onto the emitted
// `CliEnvelope.meta` so agents see the hints in the JSON envelope.
// ---------------------------------------------------------------------------

/**
 * Stamp `meta.suggestedNext` onto a successful tasks-domain dispatch response.
 *
 * Pure transformer — returns a new response object with `suggestedNext`
 * merged into `meta`. The original response is never mutated. Errors,
 * unsupported ops, and ops with no registered builder pass through
 * unchanged.
 *
 * @param response  - The original dispatch response (may be success or error).
 * @param operation - The tasks operation key (e.g. `'add'`, `'add-batch'`).
 * @param params    - Raw params passed to the handler.
 * @returns A new `DispatchResponse` with `meta.suggestedNext` populated
 *   when a builder is registered and produces a non-empty array; otherwise
 *   returns the input unchanged.
 *
 * @task T9921
 */
function stampSuggestedNext(
  response: DispatchResponse,
  operation: string,
  params: Record<string, unknown>,
): DispatchResponse {
  if (!response.success) return response;
  const builder = TASKS_SUGGESTED_NEXT_BUILDERS[operation];
  if (!builder) return response;
  let suggestions: string[];
  try {
    suggestions = builder(params, response.data);
  } catch {
    return response;
  }
  if (suggestions.length === 0) return response;
  return {
    ...response,
    meta: {
      ...response.meta,
      suggestedNext: suggestions,
    },
  };
}

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

    // Saga sub-domain query ops (ADR-073) — handled outside typed handler
    // because they call existing functions and don't need OpsFromCore inference.
    try {
      if (operation === 'saga.list') {
        const envelope = await sagaList();
        return wrapResult(envelopeToEngineResult(envelope), 'query', 'tasks', operation, startTime);
      }
      if (operation === 'saga.members') {
        const envelope = await sagaMembers(params ?? {});
        return wrapResult(envelopeToEngineResult(envelope), 'query', 'tasks', operation, startTime);
      }
      if (operation === 'saga.rollup') {
        const envelope = await sagaRollup(params ?? {});
        return wrapResult(envelopeToEngineResult(envelope), 'query', 'tasks', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:tasks').error(
        { gateway: 'query', domain: 'tasks', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'tasks', operation, error, startTime);
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
      const response = wrapResult(
        envelopeToEngineResult(envelope),
        'query',
        'tasks',
        operation,
        startTime,
      );
      return stampSuggestedNext(response, operation, params ?? {});
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

    // Saga sub-domain mutate ops (ADR-073) — handled outside typed handler.
    try {
      if (operation === 'saga.create') {
        const envelope = await sagaCreate(params ?? {});
        return wrapResult(
          envelopeToEngineResult(envelope),
          'mutate',
          'tasks',
          operation,
          startTime,
        );
      }
      if (operation === 'saga.add') {
        const envelope = await sagaAdd(params ?? {});
        return wrapResult(
          envelopeToEngineResult(envelope),
          'mutate',
          'tasks',
          operation,
          startTime,
        );
      }
      if (operation === 'saga.repair') {
        const envelope = await sagaRepair(params ?? {});
        return wrapResult(
          envelopeToEngineResult(envelope),
          'mutate',
          'tasks',
          operation,
          startTime,
        );
      }
      if (operation === 'saga.detach') {
        const envelope = await sagaDetach(params ?? {});
        return wrapResult(
          envelopeToEngineResult(envelope),
          'mutate',
          'tasks',
          operation,
          startTime,
        );
      }
      if (operation === 'saga.reconcile') {
        const envelope = await sagaReconcile(params ?? {});
        return wrapResult(
          envelopeToEngineResult(envelope),
          'mutate',
          'tasks',
          operation,
          startTime,
        );
      }
    } catch (error) {
      getLogger('domain:tasks').error(
        { gateway: 'mutate', domain: 'tasks', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'tasks', operation, error, startTime);
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
      const response = wrapResult(
        envelopeToEngineResult(envelope),
        'mutate',
        'tasks',
        operation,
        startTime,
      );
      return stampSuggestedNext(response, operation, params ?? {});
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
        'deps.validate',
        'deps.tree',
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
        // Saga sub-domain (ADR-073)
        'saga.list',
        'saga.members',
        'saga.rollup',
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
        'relates.remove',
        'start',
        'stop',
        'sync.reconcile',
        'sync.links.remove',
        'claim',
        'unclaim',
        // Saga sub-domain (ADR-073)
        'saga.create',
        'saga.add',
        // T10117 — repair an I5-violating saga.
        'saga.repair',
        // T10118 — repair verb for ADR-073 §1.2 I7 violations
        'saga.detach',
        // T10121 — idempotent cron-safe auto-close repair.
        'saga.reconcile',
      ],
    };
  }
}
