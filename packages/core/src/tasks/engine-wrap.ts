/**
 * EngineResult-returning wrappers for non-CRUD task ops (T1568 / ADR-057 / ADR-058).
 * Consolidates all task* wrapper functions that wrap coreTask* in try/catch → EngineResult.
 * Also includes coreTaskCancel and claim/unclaim wrappers.
 * @task T10064
 * @epic T9834
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { predictImpact } from '../intelligence/impact.js';
import type { ImpactReport } from '../intelligence/types.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { canCancel } from './cancel-ops.js';
import { discoverRelated, suggestRelated } from './relates.js';
import { coreTaskAnalyze } from './task-analyze.js';
import { coreTaskBlockers } from './task-blockers.js';
import {
  coreTaskDeps,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskRelatesRemove,
} from './task-import.js';
import { coreTaskNext } from './task-next.js';
import {
  coreTaskPromote,
  coreTaskReopen,
  coreTaskReorder,
  coreTaskReparent,
  coreTaskRestore,
  coreTaskUnarchive,
} from './task-reparent.js';
import { coreTaskTree } from './task-tree.js';

// Data/query wrappers in companion file (LOC split)
export {
  taskBatchValidate,
  taskClaim,
  taskComplexityEstimate,
  taskDepends,
  taskDepsCycles,
  taskDepsOverview,
  taskDepsTree,
  taskDepsValidate,
  taskExport,
  taskHistory,
  taskImport,
  taskLint,
  taskStats,
  taskUnclaim,
} from './engine-wrap-ops.js';
// Re-export core functions so consumers can import directly
export {
  coreTaskAnalyze,
  coreTaskBlockers,
  coreTaskDeps,
  coreTaskNext,
  coreTaskPromote,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskRelatesRemove,
  coreTaskReopen,
  coreTaskReorder,
  coreTaskReparent,
  coreTaskRestore,
  coreTaskTree,
  coreTaskUnarchive,
};

/**
 * Convert a caught error to an EngineResult failure.
 *
 * T9940: extracts the real LAFS code from any thrown `CleoError`. Non-CleoError
 * exceptions fall through to `E_INTERNAL`, never the misleading
 * `E_NOT_INITIALIZED` blanket label that the pre-T9940 wrapper used.
 *
 * @task T9940
 * @epic T9862
 */
function nonCrudEngineError<T>(err: unknown, fallbackMsg: string): EngineResult<T> {
  return cleoErrorToEngineResult<T>(err, 'E_INTERNAL', fallbackMsg);
}

/**
 * Cancel a task (sets status to 'cancelled', a soft terminal state).
 * Use restore to reverse. Use delete for permanent removal.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to cancel
 * @param params - Optional cancel options
 * @param params.reason - Human-readable cancellation reason stored on the task
 * @returns Confirmation with cancelled flag and timestamp. When the task is
 *          already cancelled, the response includes `alreadyCancelled: true`
 *          and echoes the existing `cancelledAt` (idempotent — T9838).
 *
 * @remarks
 * Cancellation is a soft terminal state -- the task remains in the database and
 * can be restored via {@link coreTaskRestore}. Not all statuses are cancellable;
 * the `canCancel` guard determines eligibility.
 *
 * The T877 DB trigger enforces an invariant: when `status='cancelled'`, the
 * `pipeline_stage` MUST equal `'cancelled'`. This function therefore always
 * forces `pipelineStage='cancelled'` on a successful cancel, overriding any
 * prior terminal value such as `'contribution'`. The previous T871 carve-out
 * (skip overwrite when stage was already terminal) caused
 * `T877_INVARIANT_VIOLATION` for tasks that had reached the `'contribution'`
 * terminal stage before cancellation — see T9838 repro.
 *
 * @example
 * ```typescript
 * const result = await coreTaskCancel('/project', 'T077', { reason: 'Superseded by T080' });
 * console.log(result.cancelledAt);
 * ```
 *
 * @task T4529
 * @task T9838 (T877 invariant fix + idempotent re-cancel)
 */
export async function coreTaskCancel(
  projectRoot: string,
  taskId: string,
  params?: { reason?: string },
): Promise<{
  task: string;
  cancelled: boolean;
  reason?: string;
  cancelledAt: string;
  alreadyCancelled?: boolean;
}> {
  const accessor = await getTaskAccessor(projectRoot);
  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Idempotent: re-cancelling an already-cancelled task returns success with
  // `alreadyCancelled: true` and echoes the existing cancelledAt. T9838.
  if (task.status === 'cancelled') {
    return {
      task: taskId,
      cancelled: true,
      reason: task.cancellationReason ?? undefined,
      cancelledAt: task.cancelledAt ?? task.updatedAt ?? new Date().toISOString(),
      alreadyCancelled: true,
    };
  }

  const check = canCancel(task);
  if (!check.allowed) {
    // Reject with a sentinel that the dispatch layer maps to E_INVALID_STATE
    // rather than the catch-all E_NOT_FOUND.
    throw new Error(`E_INVALID_STATE: ${check.reason!}`);
  }

  const cancelledAt = new Date().toISOString();
  task.status = 'cancelled';
  task.cancelledAt = cancelledAt;
  task.cancellationReason = params?.reason ?? undefined;
  task.updatedAt = cancelledAt;
  // T877: DB invariant requires status='cancelled' ↔ pipeline_stage='cancelled'.
  // ALWAYS force the stage to 'cancelled' on a successful cancel — the prior
  // T871 carve-out (skip when already terminal) would leave 'contribution'
  // in place and trip the BEFORE-UPDATE trigger. T9838 repro.
  task.pipelineStage = 'cancelled';
  await accessor.upsertSingleTask(task);

  // Best-effort worktree cleanup when cancelling a task.
  // Promise rejection (e.g. non-git directory) swallowed — must not propagate.
  const { teardownWorktree } = await import('../sentient/worktree-dispatch.js');
  teardownWorktree(projectRoot, { taskId }).catch(() => {});

  return { task: taskId, cancelled: true, reason: params?.reason, cancelledAt };
}

// ---------------------------------------------------------------------------
// EngineResult wrappers
// ---------------------------------------------------------------------------

/**
 * Suggest next task to work on.
 * @task T1568
 * @epic T1566
 */
export async function taskNext(
  projectRoot: string,
  params?: { count?: number; explain?: boolean },
): Promise<
  EngineResult<{
    suggestions: Array<{
      id: string;
      title: string;
      priority: string;
      phase: string | null;
      score: number;
      reasons?: string[];
    }>;
    totalCandidates: number;
  }>
> {
  try {
    const result = await coreTaskNext(projectRoot, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Show blocked tasks and analyze blocking chains.
 * @task T1568
 * @epic T1566
 */
export async function taskBlockers(
  projectRoot: string,
  params?: { analyze?: boolean; limit?: number },
): Promise<
  EngineResult<{
    blockedTasks: Array<{
      id: string;
      title: string;
      status: string;
      depends?: string[];
      blockingChain: string[];
    }>;
    criticalBlockers: Array<{ id: string; title: string; blocksCount: number }>;
    summary: string;
    total: number;
    limit: number;
  }>
> {
  try {
    const result = await coreTaskBlockers(projectRoot, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Build hierarchy tree.
 * @task T1568
 * @epic T1566
 */
export async function taskTree(
  projectRoot: string,
  taskId?: string,
  withBlockers?: boolean,
): Promise<EngineResult> {
  try {
    const result = await coreTaskTree(projectRoot, taskId, withBlockers);
    return engineSuccess(result);
  } catch (err: unknown) {
    // T9940: preserve CleoError LAFS codes; fall through to E_NOT_FOUND
    // (the canonical tree-wrapper fallback) only when no CleoError shape.
    return cleoErrorToEngineResult(err, 'E_NOT_FOUND', 'Task not found');
  }
}

/**
 * Show dependencies for a task.
 * @task T1568
 * @epic T1566
 */
export async function taskDeps(
  projectRoot: string,
  taskId: string,
): Promise<
  EngineResult<{
    taskId: string;
    dependsOn: Array<{ id: string; title: string; status: string }>;
    dependedOnBy: Array<{ id: string; title: string; status: string }>;
    unresolvedDeps: string[];
    allDepsReady: boolean;
  }>
> {
  try {
    const result = await coreTaskDeps(projectRoot, taskId);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Show task relations.
 * @task T1568
 * @epic T1566
 */
export async function taskRelates(
  projectRoot: string,
  taskId: string,
): Promise<
  EngineResult<{
    taskId: string;
    relations: Array<{ taskId: string; type: string; reason?: string }>;
    count: number;
  }>
> {
  try {
    const result = await coreTaskRelates(projectRoot, taskId);
    return engineSuccess(result);
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_GENERAL', 'Failed to read task relations');
  }
}

/**
 * Add a relation between two tasks.
 * @task T1568
 * @epic T1566
 */
export async function taskRelatesAdd(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type: string,
  reason?: string,
): Promise<EngineResult<{ from: string; to: string; type: string; added: boolean }>> {
  try {
    const result = await coreTaskRelatesAdd(projectRoot, taskId, relatedId, type, reason);
    return engineSuccess(result);
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_GENERAL', 'Failed to update task relations');
  }
}

/**
 * Remove a relation between two tasks.
 * @task T9240
 */
export async function taskRelatesRemove(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type?: string,
): Promise<EngineResult<{ from: string; to: string; type?: string; removed: boolean }>> {
  try {
    const result = await coreTaskRelatesRemove(projectRoot, taskId, relatedId, type);
    return engineSuccess(result);
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_GENERAL', 'Failed to remove task relation');
  }
}

/**
 * Find related tasks using semantic search or keyword matching.
 * @task T1568
 * @epic T1566
 */
export async function taskRelatesFind(
  projectRoot: string,
  taskId: string,
  params?: { mode?: 'suggest' | 'discover'; threshold?: number },
): Promise<EngineResult<Record<string, unknown>>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const mode = params?.mode ?? 'suggest';
    let result: Record<string, unknown>;
    if (mode === 'discover') {
      result = await discoverRelated(taskId, undefined, accessor);
    } else {
      const threshold = params?.threshold ?? 50;
      result = await suggestRelated(taskId, { threshold }, accessor);
    }
    return engineSuccess(result);
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Task relates find failed');
  }
}

/**
 * Analyze task quality and project health.
 * @task T1568
 * @epic T1566
 */
export async function taskAnalyze(
  projectRoot: string,
  taskId?: string,
  params?: { tierLimit?: number },
): Promise<
  EngineResult<{
    recommended: { id: string; title: string; leverage: number; reason: string } | null;
    bottlenecks: Array<{ id: string; title: string; blocksCount: number }>;
    tiers: {
      critical: Array<{ id: string; title: string; leverage: number }>;
      high: Array<{ id: string; title: string; leverage: number }>;
      normal: Array<{ id: string; title: string; leverage: number }>;
    };
    metrics: { totalTasks: number; actionable: number; blocked: number; avgLeverage: number };
    tierLimit: number;
  }>
> {
  try {
    const result = await coreTaskAnalyze(projectRoot, taskId, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_GENERAL', 'Task analysis failed');
  }
}

/**
 * Predict downstream impact of a change.
 * @task T1568
 * @epic T1566
 */
export async function taskImpact(
  projectRoot: string,
  change: string,
  matchLimit?: number,
): Promise<EngineResult<ImpactReport>> {
  try {
    const result = await predictImpact(change, projectRoot, undefined, matchLimit);
    return engineSuccess(result);
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_GENERAL', 'Impact prediction failed');
  }
}

/**
 * Restore a cancelled task back to pending.
 * @task T1568
 * @epic T1566
 */
export async function taskRestore(
  projectRoot: string,
  taskId: string,
  params?: { cascade?: boolean; notes?: string },
): Promise<EngineResult<{ task: string; restored: string[]; count: number }>> {
  try {
    const result = await coreTaskRestore(projectRoot, taskId, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to restore task');
  }
}

/**
 * Move an archived task back to active.
 * @task T1568
 * @epic T1566
 */
export async function taskUnarchive(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; preserveStatus?: boolean },
): Promise<EngineResult<{ task: string; unarchived: boolean; title: string; status: string }>> {
  try {
    const result = await coreTaskUnarchive(projectRoot, taskId, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to unarchive task');
  }
}

/**
 * Change task position within its sibling group.
 * @task T1568
 * @epic T1566
 */
export async function taskReorder(
  projectRoot: string,
  taskId: string,
  position: number,
): Promise<
  EngineResult<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number }>
> {
  try {
    const result = await coreTaskReorder(projectRoot, taskId, position);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to reorder task');
  }
}

/**
 * Move task under a different parent.
 * @task T1568
 * @epic T1566
 */
export async function taskReparent(
  projectRoot: string,
  taskId: string,
  newParentId: string | null,
): Promise<
  EngineResult<{
    task: string;
    reparented: boolean;
    oldParent: string | null;
    newParent: string | null;
    newType?: string;
  }>
> {
  try {
    const result = await coreTaskReparent(projectRoot, taskId, newParentId);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to reparent task');
  }
}

/**
 * Promote a subtask to task or task to root.
 * @task T1568
 * @epic T1566
 */
export async function taskPromote(
  projectRoot: string,
  taskId: string,
): Promise<
  EngineResult<{
    task: string;
    promoted: boolean;
    previousParent: string | null;
    typeChanged: boolean;
  }>
> {
  try {
    const result = await coreTaskPromote(projectRoot, taskId);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to promote task');
  }
}

/**
 * Reopen a completed task.
 * @task T1568
 * @epic T1566
 */
export async function taskReopen(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; reason?: string },
): Promise<
  EngineResult<{ task: string; reopened: boolean; previousStatus: string; newStatus: string }>
> {
  try {
    const result = await coreTaskReopen(projectRoot, taskId, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to reopen task');
  }
}

/**
 * Cancel a task (soft terminal state).
 * @task T1568
 * @epic T1566
 */
export async function taskCancel(
  projectRoot: string,
  taskId: string,
  reason?: string,
): Promise<
  EngineResult<{
    task: string;
    cancelled: boolean;
    reason?: string;
    cancelledAt: string;
    alreadyCancelled?: boolean;
  }>
> {
  try {
    const result = await coreTaskCancel(projectRoot, taskId, { reason });
    return engineSuccess(result);
  } catch (err: unknown) {
    // T9838: distinguish "task missing" from "task exists but cannot be
    // cancelled" from underlying engine/DB failures. Prior to this fix
    // every error mapped to E_NOT_FOUND, including T877_INVARIANT_VIOLATION
    // and E_CANNOT_CANCEL — masking real bugs as missing tasks.
    // T9940: prefer the real LAFS code when a CleoError bubbles up before
    // applying the legacy string-prefix heuristics for plain Errors.
    const e = err as { message?: string };
    const message = e?.message ?? 'Failed to cancel task';
    if (message.startsWith('E_INVALID_STATE:')) {
      return engineError('E_INVALID_STATE', message.replace(/^E_INVALID_STATE:\s*/, ''));
    }
    if (message.includes(' not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return cleoErrorToEngineResult(err, 'E_INTERNAL', message);
  }
}
