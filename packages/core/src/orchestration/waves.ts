/**
 * Wave computation and dependency graph operations.
 * @task T4784
 */

import type { Task, TaskPriority, TaskRef } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

/** Basic execution wave: task IDs grouped by dependency depth. */
export interface Wave {
  /** 1-based wave number. */
  waveNumber: number;
  /** Task IDs belonging to this wave. */
  tasks: string[];
  /** Computed lifecycle status of this wave. */
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Enriched task reference within a wave.
 *
 * Carries all fields needed by the wave renderer so callers do not need a
 * secondary lookup.  `blockedBy` lists open (non-terminal) dependency IDs;
 * `ready` is `true` when the task is immediately actionable.
 */
export interface EnrichedWaveTask extends TaskRef {
  /** Task priority level. */
  priority: TaskPriority;
  /**
   * All declared dependency IDs for this task.
   *
   * Empty array when the task has no dependencies.
   */
  depends: string[];
  /**
   * Open (non-terminal) dependency IDs that are currently blocking this task.
   *
   * A dependency is open when its status is not `'done'` or `'cancelled'`.
   */
  blockedBy: string[];
  /**
   * Whether this task is immediately actionable.
   *
   * `true` when `blockedBy` is empty AND `status` is `'pending'` or `'active'`.
   */
  ready: boolean;
}

/**
 * Enriched execution wave carrying per-task metadata for rendering.
 *
 * All tasks within the wave are sorted by priority (critical → high → medium →
 * low) descending, then by open-dependency count ascending, then by ID for
 * deterministic stability.
 */
export interface EnrichedWave {
  /** 1-based wave number. */
  waveNumber: number;
  /** Enriched, priority-sorted tasks for this wave. */
  tasks: EnrichedWaveTask[];
  /** Computed lifecycle status of this wave. */
  status: 'pending' | 'in_progress' | 'completed';
  /**
   * ISO timestamp of the latest `completedAt` among wave tasks.
   *
   * Present only when `status === 'completed'` and at least one task carries a
   * `completedAt` value.
   */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Numeric sort weight for each priority level (higher = sort first). */
const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Enrich a task ID into an {@link EnrichedWaveTask}.
 *
 * Computes `depends`, `blockedBy`, and `ready` against the live task map so
 * the wave renderer does not need a secondary lookup.
 *
 * @param id      - Task ID to enrich.
 * @param taskMap - Flat lookup map of all tasks by ID.
 */
function enrichTask(id: string, taskMap: Map<string, Task>): EnrichedWaveTask {
  const task = taskMap.get(id);
  const title = task?.title ?? id;
  const status = task?.status ?? 'unknown';
  const priority = (task?.priority ?? 'medium') as TaskPriority;
  const depends = task?.depends ?? [];

  const blockedBy = depends.filter((depId) => {
    const dep = taskMap.get(depId);
    if (!dep) return false;
    return dep.status !== 'done' && dep.status !== 'cancelled';
  });

  const ready = blockedBy.length === 0 && (status === 'pending' || status === 'active');

  return { id, title, status, priority, depends, blockedBy, ready };
}

/**
 * Sort enriched wave tasks by priority DESC → open-dep count ASC → ID ASC.
 *
 * Within a wave, tasks that are higher priority and have fewer open blockers
 * appear first, making the most actionable work immediately visible.
 *
 * @param tasks - Enriched tasks to sort (mutates the array in-place and returns it).
 */
function sortWaveTasks(tasks: EnrichedWaveTask[]): EnrichedWaveTask[] {
  return tasks.sort((a, b) => {
    // 1. Priority descending (critical > high > medium > low)
    const pa = PRIORITY_WEIGHT[a.priority] ?? 2;
    const pb = PRIORITY_WEIGHT[b.priority] ?? 2;
    if (pa !== pb) return pb - pa;

    // 2. Open-dependency count ascending (fewer blockers = more actionable)
    const ba = a.blockedBy.length;
    const bb = b.blockedBy.length;
    if (ba !== bb) return ba - bb;

    // 3. ID ascending for deterministic stability
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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
 * Resolves the epic's direct children, computes topological waves, enriches
 * each wave's task list with dependency metadata, sorts tasks within each wave
 * by priority descending then open-dep count ascending, and attaches a
 * `completedAt` timestamp to completed waves.
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

  const enrichedWaves: EnrichedWave[] = waves.map((w) => {
    const enrichedTasks = sortWaveTasks(w.tasks.map((id) => enrichTask(id, taskMap)));

    const wave: EnrichedWave = {
      waveNumber: w.waveNumber,
      status: w.status,
      tasks: enrichedTasks,
    };

    // Attach completedAt for completed waves: max of child completedAt values.
    if (w.status === 'completed') {
      const timestamps = w.tasks
        .map((id) => taskMap.get(id)?.completedAt)
        .filter((ts): ts is string => typeof ts === 'string' && ts.length > 0);
      if (timestamps.length > 0) {
        wave.completedAt = timestamps.reduce((max, ts) => (ts > max ? ts : max));
      }
    }

    return wave;
  });

  return {
    epicId,
    waves: enrichedWaves,
    totalWaves: waves.length,
    totalTasks: children.length,
  };
}
