/**
 * Task size weighting and priority scoring.
 * Ported from lib/tasks/size-weighting.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task, TaskSize, TaskPriority } from '../../types/task.js';

/** Size weight multipliers. */
const SIZE_WEIGHTS: Record<TaskSize, number> = {
  small: 1,
  medium: 3,
  large: 8,
};

/** Priority weight multipliers. */
const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1,
};

/**
 * Get weight for a task size.
 */
export function getSizeWeight(size: TaskSize | null | undefined): number {
  return SIZE_WEIGHTS[size ?? 'medium'] ?? SIZE_WEIGHTS.medium;
}

/**
 * Get weight for a task priority.
 */
export function getPriorityWeight(priority: TaskPriority): number {
  return PRIORITY_WEIGHTS[priority] ?? PRIORITY_WEIGHTS.medium;
}

/**
 * Calculate a composite score for task ordering.
 * Higher score = should be worked on first.
 */
export function calculateTaskScore(task: Task): number {
  const sizeW = getSizeWeight(task.size);
  const priorityW = getPriorityWeight(task.priority);

  // Base score from priority (dominant factor)
  let score = priorityW * 10;

  // Bonus for smaller tasks (quick wins with same priority)
  score += (8 - sizeW) * 2;

  // Active status bonus
  if (task.status === 'active') score += 50;

  // Blocked penalty
  if (task.status === 'blocked') score -= 20;

  return score;
}

/**
 * Sort tasks by weighted score (highest first).
 */
export function sortByWeight(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => calculateTaskScore(b) - calculateTaskScore(a));
}

/**
 * Calculate total weighted effort for a set of tasks.
 */
export function calculateTotalEffort(tasks: Task[]): number {
  return tasks.reduce((total, t) => total + getSizeWeight(t.size), 0);
}

/**
 * Calculate completion percentage by weight.
 */
export function calculateWeightedProgress(tasks: Task[]): number {
  if (tasks.length === 0) return 0;

  const total = calculateTotalEffort(tasks);
  if (total === 0) return 0;

  const completed = tasks
    .filter((t) => t.status === 'done' || t.status === 'cancelled')
    .reduce((sum, t) => sum + getSizeWeight(t.size), 0);

  return Math.round((completed / total) * 100);
}

/**
 * Estimate remaining effort (weighted sum of non-complete tasks).
 */
export function calculateRemainingEffort(tasks: Task[]): number {
  return tasks
    .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
    .reduce((sum, t) => sum + getSizeWeight(t.size), 0);
}
