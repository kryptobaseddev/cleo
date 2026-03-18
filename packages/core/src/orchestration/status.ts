/**
 * Orchestration status computation.
 *
 * Provides status aggregation for epics, overall project state,
 * progress metrics, and orchestration check state.
 *
 * @task T5702
 */

import type { Task } from '@cleocode/contracts';
import { computeWaves } from './waves.js';

/** Status counts by task state. */
export interface StatusCounts {
  pending: number;
  active: number;
  blocked: number;
  done: number;
  cancelled?: number;
}

/** Epic-specific status result. */
export interface EpicStatus {
  epicId: string;
  epicTitle: string;
  totalTasks: number;
  byStatus: StatusCounts;
  waves: number;
  currentWave: number | null;
}

/** Overall orchestration status (no specific epic). */
export interface OverallStatus {
  totalEpics: number;
  totalTasks: number;
  byStatus: StatusCounts;
}

/** Progress metrics for orchestration check. */
export interface ProgressMetrics {
  total: number;
  done: number;
  pending: number;
  blocked: number;
  active: number;
  percentComplete: number;
}

/** Startup summary for an epic. */
export interface StartupSummary {
  epicId: string;
  epicTitle: string;
  initialized: boolean;
  summary: {
    totalTasks: number;
    totalWaves: number;
    readyTasks: number;
    byStatus: StatusCounts;
  };
  firstWave: import('./waves.js').Wave | null;
}

/**
 * Count tasks by status.
 */
export function countByStatus(tasks: Task[]): StatusCounts {
  return {
    pending: tasks.filter((t) => t.status === 'pending').length,
    active: tasks.filter((t) => t.status === 'active').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    done: tasks.filter((t) => t.status === 'done').length,
    cancelled: tasks.filter((t) => t.status === 'cancelled').length,
  };
}

/**
 * Compute epic-specific status.
 *
 * @param epicId - The epic task ID
 * @param epicTitle - The epic title
 * @param children - Child tasks of the epic
 * @returns Epic status with wave information
 */
export function computeEpicStatus(epicId: string, epicTitle: string, children: Task[]): EpicStatus {
  const waves = computeWaves(children);
  const byStatus = countByStatus(children);

  return {
    epicId,
    epicTitle,
    totalTasks: children.length,
    byStatus,
    waves: waves.length,
    currentWave: waves.find((w) => w.status !== 'completed')?.waveNumber || null,
  };
}

/**
 * Compute overall orchestration status across all tasks.
 *
 * @param tasks - All tasks in the project
 * @returns Overall status with epic count
 */
export function computeOverallStatus(tasks: Task[]): OverallStatus {
  const epics = tasks.filter(
    (t) => !t.parentId && (t.type === 'epic' || tasks.some((c) => c.parentId === t.id)),
  );

  return {
    totalEpics: epics.length,
    totalTasks: tasks.length,
    byStatus: {
      pending: tasks.filter((t) => t.status === 'pending').length,
      active: tasks.filter((t) => t.status === 'active').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      done: tasks.filter((t) => t.status === 'done').length,
    },
  };
}

/**
 * Compute progress metrics for all tasks.
 *
 * @param tasks - All tasks to measure
 * @returns Progress metrics with completion percentage
 */
export function computeProgress(tasks: Task[]): ProgressMetrics {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const active = tasks.filter((t) => t.status === 'active').length;

  return {
    total,
    done,
    pending,
    blocked,
    active,
    percentComplete: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/**
 * Compute startup summary for an epic.
 *
 * @param epicId - The epic task ID
 * @param epicTitle - The epic title
 * @param children - Child tasks of the epic
 * @param readyCount - Number of ready tasks
 * @returns Startup summary with wave information
 */
export function computeStartupSummary(
  epicId: string,
  epicTitle: string,
  children: Task[],
  readyCount: number,
): StartupSummary {
  const waves = computeWaves(children);
  const byStatus = countByStatus(children);

  return {
    epicId,
    epicTitle,
    initialized: true,
    summary: {
      totalTasks: children.length,
      totalWaves: waves.length,
      readyTasks: readyCount,
      byStatus,
    },
    firstWave: waves[0] || null,
  };
}
