/**
 * Task graph operations - dependency waves, ordering, and critical path.
 * Ported from lib/tasks/graph-ops.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';
import { topologicalSort } from './dependency-check.js';

/** A wave of parallelizable tasks. */
export interface DependencyWave {
  wave: number;
  taskIds: string[];
}

/**
 * Compute dependency waves for parallel execution.
 * Tasks in the same wave can run in parallel; waves must be sequential.
 */
export function computeDependencyWaves(tasks: Task[]): DependencyWave[] {
  const activeTasks = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled',
  );

  if (activeTasks.length === 0) return [];

  const taskMap = new Map(activeTasks.map((t) => [t.id, t]));
  const completedIds = new Set(
    tasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  // Compute in-degree for each task (only counting active deps)
  const inDegree = new Map<string, number>();
  for (const task of activeTasks) {
    const activeDeps = (task.depends ?? []).filter(
      (d) => !completedIds.has(d) && taskMap.has(d),
    );
    inDegree.set(task.id, activeDeps.length);
  }

  const waves: DependencyWave[] = [];
  const assigned = new Set<string>();

  let waveNum = 0;
  while (assigned.size < activeTasks.length) {
    // Find all tasks with in-degree 0 that haven't been assigned
    const wave: string[] = [];
    for (const [id, degree] of inDegree) {
      if (!assigned.has(id) && degree === 0) {
        wave.push(id);
      }
    }

    if (wave.length === 0) {
      // Remaining tasks have cycles - add them all to final wave
      const remaining = activeTasks
        .filter((t) => !assigned.has(t.id))
        .map((t) => t.id);
      if (remaining.length > 0) {
        waves.push({ wave: waveNum, taskIds: remaining });
      }
      break;
    }

    waves.push({ wave: waveNum, taskIds: wave.sort() });

    // Mark wave tasks as assigned and reduce in-degree
    for (const id of wave) {
      assigned.add(id);
      // Reduce in-degree for dependents
      for (const task of activeTasks) {
        if (task.depends?.includes(id) && !assigned.has(task.id)) {
          inDegree.set(task.id, (inDegree.get(task.id) ?? 1) - 1);
        }
      }
    }

    waveNum++;
  }

  return waves;
}

/**
 * Get the next task to work on (highest priority ready task).
 */
export function getNextTask(tasks: Task[]): Task | null {
  const completedIds = new Set(
    tasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const ready = tasks
    .filter((t) => {
      if (t.status === 'done' || t.status === 'cancelled') return false;
      if (t.status === 'active') return true; // Already active = highest priority
      if (!t.depends?.length) return true;
      return t.depends.every((d) => completedIds.has(d));
    })
    .sort((a, b) => {
      // Active tasks first
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      // Then by priority
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      return pa - pb;
    });

  return ready[0] ?? null;
}

/**
 * Calculate the critical path (longest dependency chain).
 * Returns task IDs along the critical path.
 */
export function getCriticalPath(tasks: Task[]): string[] {
  const activeTasks = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled',
  );

  if (activeTasks.length === 0) return [];

  const sorted = topologicalSort(activeTasks);
  if (!sorted) return []; // Cycle detected

  const taskMap = new Map(activeTasks.map((t) => [t.id, t]));
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();

  // Initialize distances
  for (const id of sorted) {
    dist.set(id, 0);
  }

  // Process in topological order
  for (const id of sorted) {
    const task = taskMap.get(id);
    if (!task?.depends) continue;

    for (const depId of task.depends) {
      if (!taskMap.has(depId)) continue;
      const newDist = (dist.get(depId) ?? 0) + 1;
      if (newDist > (dist.get(id) ?? 0)) {
        dist.set(id, newDist);
        prev.set(id, depId);
      }
    }
  }

  // Find the task with maximum distance
  let maxDist = 0;
  let endId = '';
  for (const [id, d] of dist) {
    if (d >= maxDist) {
      maxDist = d;
      endId = id;
    }
  }

  if (!endId) return [];

  // Trace back the path
  const path: string[] = [endId];
  let current = endId;
  while (prev.has(current)) {
    current = prev.get(current)!;
    path.unshift(current);
  }

  return path;
}

/**
 * Get task ordering by dependency + priority.
 */
export function getTaskOrder(tasks: Task[]): string[] {
  const sorted = topologicalSort(tasks);
  if (sorted) return sorted;

  // Fallback: sort by priority if cycle detected
  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return [...tasks]
    .sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2))
    .map((t) => t.id);
}

/**
 * Get parallelizable tasks (tasks with no unmet dependencies).
 */
export function getParallelTasks(tasks: Task[]): string[] {
  const waves = computeDependencyWaves(tasks);
  return waves[0]?.taskIds ?? [];
}
