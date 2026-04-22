/**
 * Wave computation and dependency graph operations.
 * @task T4784
 */

import type { Task, TaskRef } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

export interface Wave {
  waveNumber: number;
  tasks: string[];
  status: 'pending' | 'in_progress' | 'completed';
}

export interface EnrichedWave {
  waveNumber: number;
  tasks: TaskRef[];
  status: 'pending' | 'in_progress' | 'completed';
}

/** Build a dependency graph for tasks. */
function buildDependencyGraph(tasks: Task[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!graph.has(task.id)) {
      graph.set(task.id, new Set());
    }
    if (task.depends) {
      for (const dep of task.depends) {
        graph.get(task.id)!.add(dep);
      }
    }
  }
  return graph;
}

/**
 * Compute execution waves using topological sort.
 *
 * Tasks that are already done/cancelled are pre-seeded into the `completed` set
 * so their dependants can be scheduled in wave 1. Wave status is derived from
 * the live `task.status` field rather than the local `completed` set (which
 * excludes non-terminal tasks and would always yield `false` for in-flight work).
 *
 * @param tasks - All tasks to partition into dependency waves.
 * @returns Ordered waves where each wave's tasks can execute in parallel.
 */
export function computeWaves(tasks: Task[]): Wave[] {
  const graph = buildDependencyGraph(tasks);
  const waves: Wave[] = [];
  const completed = new Set<string>();

  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') {
      completed.add(task.id);
    }
  }

  let remaining = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  let waveNumber = 1;
  const maxWaves = 50;

  while (remaining.length > 0 && waveNumber <= maxWaves) {
    const waveTasks = remaining.filter((t) => {
      const deps = graph.get(t.id) || new Set();
      return Array.from(deps).every((d) => completed.has(d));
    });

    if (waveTasks.length === 0) break;

    // Determine wave status from task.status directly.
    // Note: `remaining` already excludes done/cancelled tasks, so checking
    // `completed.has(t.id)` here would always be false — dead code prior to T1197.
    const allDone = waveTasks.every((t) => t.status === 'done' || t.status === 'cancelled');
    const anyActive = waveTasks.some((t) => t.status === 'active');
    const waveStatus: Wave['status'] = allDone
      ? 'completed'
      : anyActive
        ? 'in_progress'
        : 'pending';

    waves.push({
      waveNumber,
      tasks: waveTasks.map((t) => t.id),
      status: waveStatus,
    });

    for (const t of waveTasks) {
      completed.add(t.id);
    }

    remaining = remaining.filter((t) => !waveTasks.some((wt) => wt.id === t.id));
    waveNumber++;
  }

  if (remaining.length > 0) {
    waves.push({
      waveNumber,
      tasks: remaining.map((t) => t.id),
      status: 'pending',
    });
  }

  return waves;
}

/**
 * Get enriched wave data for an epic.
 *
 * Resolves the epic's direct children, computes topological waves, and enriches
 * each wave's task list with title and status from the task store.
 *
 * @param epicId   - The epic task ID to compute waves for.
 * @param cwd      - Optional project root (falls back to `getAccessor` default).
 * @param accessor - Optional pre-constructed data accessor (useful in tests).
 */
export async function getEnrichedWaves(
  epicId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{ epicId: string; waves: EnrichedWave[]; totalWaves: number; totalTasks: number }> {
  const acc = accessor ?? (await getAccessor(cwd));
  const children = await acc.getChildren(epicId);
  const waves = computeWaves(children);
  const taskMap = new Map(children.map((t) => [t.id, t]));

  const enrichedWaves: EnrichedWave[] = waves.map((w) => ({
    ...w,
    tasks: w.tasks.map((id) => ({
      id,
      title: taskMap.get(id)?.title || id,
      status: taskMap.get(id)?.status || 'unknown',
    })),
  }));

  return {
    epicId,
    waves: enrichedWaves,
    totalWaves: waves.length,
    totalTasks: children.length,
  };
}
