/**
 * Task cancellation operations.
 * Ported from lib/tasks/cancel-ops.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';

/** Result of a cancel operation. */
export interface CancelResult {
  success: boolean;
  taskId: string;
  reason?: string;
  cancelledAt?: string;
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
      };
    }
    return t;
  });

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
): { tasks: Task[]; results: CancelResult[] } {
  const results: CancelResult[] = [];
  let currentTasks = [...tasks];

  for (const id of taskIds) {
    const { tasks: updated, result } = cancelTask(id, currentTasks, reason);
    currentTasks = updated;
    results.push(result);
  }

  return { tasks: currentTasks, results };
}
