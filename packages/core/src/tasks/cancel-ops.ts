/**
 * Task cancellation eligibility. The cancel itself is `coreTaskCancel`
 * (engine-wrap.ts); the in-memory cancelTask/cancelMultiple were deleted
 * as dead code (T14273).
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '@cleocode/contracts';

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
