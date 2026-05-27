/**
 * Task cancellation operations.
 * Ported from lib/tasks/cancel-ops.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '@cleocode/contracts';
import { teardownWorktree } from '../sentient/worktree-dispatch.js';

/** Result of a cancel operation. */
export interface CancelResult {
  success: boolean;
  taskId: string;
  reason?: string;
  cancelledAt?: string;
  /**
   * True when the task was already cancelled before this call. The cancel
   * is treated as a no-op success — see T9838 idempotency contract.
   *
   * @defaultValue undefined
   */
  alreadyCancelled?: boolean;
  error?: { code: string; message: string };
}

/**
 * Check if a task can be cancelled.
 */
export function canCancel(task: Task): { allowed: boolean; reason?: string } {
  if (task.status === 'done') {
    return { allowed: false, reason: 'Cannot cancel a completed task' };
  }
  if (task.status === 'cancelled') {
    return { allowed: false, reason: 'Task is already cancelled' };
  }
  return { allowed: true };
}

/**
 * Cancel a task in the tasks array (returns updated array).
 * Does NOT handle children - use deletion-strategy for that.
 */
export function cancelTask(
  taskId: string,
  tasks: Task[],
  reason?: string,
  projectRoot?: string,
): { tasks: Task[]; result: CancelResult } {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      tasks,
      result: {
        success: false,
        taskId,
        error: { code: 'E_NOT_FOUND', message: `Task ${taskId} not found` },
      },
    };
  }

  // T9838: idempotent re-cancel. If the task is already cancelled, return
  // success with `alreadyCancelled: true` and echo the existing cancelledAt
  // rather than failing with E_CANNOT_CANCEL.
  if (task.status === 'cancelled') {
    return {
      tasks,
      result: {
        success: true,
        taskId,
        reason: task.cancellationReason ?? undefined,
        cancelledAt: task.cancelledAt ?? task.updatedAt ?? undefined,
        alreadyCancelled: true,
      },
    };
  }

  const check = canCancel(task);
  if (!check.allowed) {
    return {
      tasks,
      result: {
        success: false,
        taskId,
        error: { code: 'E_CANNOT_CANCEL', message: check.reason! },
      },
    };
  }

  const timestamp = new Date().toISOString();
  const updatedTasks = tasks.map((t) => {
    if (t.id === taskId) {
      return {
        ...t,
        status: 'cancelled' as const,
        cancelledAt: timestamp,
        cancellationReason: reason ?? undefined,
        updatedAt: timestamp,
        // T877: DB invariant requires status='cancelled' ↔ pipeline_stage='cancelled'.
        // ALWAYS overwrite the stage on cancellation — the prior T871 carve-out
        // (`isTerminalPipelineStage ? keep : 'cancelled'`) left 'contribution' in
        // place for cancelled tasks that had finished contribution, tripping the
        // BEFORE-UPDATE trigger (T9838 repro).
        pipelineStage: 'cancelled' as const,
      };
    }
    return t;
  });

  // Best-effort worktree cleanup when cancelling a task.
  // Promise rejection (e.g. non-git directory) swallowed — must not propagate.
  if (projectRoot) {
    teardownWorktree(projectRoot, { taskId }).catch(() => {});
  }

  return {
    tasks: updatedTasks,
    result: {
      success: true,
      taskId,
      reason,
      cancelledAt: timestamp,
    },
  };
}

/**
 * Batch cancel multiple tasks.
 */
export function cancelMultiple(
  taskIds: string[],
  tasks: Task[],
  reason?: string,
  projectRoot?: string,
): { tasks: Task[]; results: CancelResult[] } {
  const results: CancelResult[] = [];
  let currentTasks = [...tasks];

  for (const id of taskIds) {
    const { tasks: updated, result } = cancelTask(id, currentTasks, reason, projectRoot);
    currentTasks = updated;
    results.push(result);
  }

  return { tasks: currentTasks, results };
}
