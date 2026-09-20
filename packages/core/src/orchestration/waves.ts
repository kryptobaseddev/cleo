/**
 * Wave computation and dependency graph operations.
 * @task T4784
 */

import type { Task, TaskPriority, TaskRef } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getReadinessDependencyBlockers } from '../tasks/dependency-check.js';

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
 * secondary lookup.  `blockedBy` lists dependencies that do not satisfy spawn readiness;
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
   * Dependency IDs that are currently blocking this task from spawning.
   *
   * Only `'done'` and `'archived'` satisfy dependencies; missing records block.
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
  /**
   * Plain task ID list — convenience alias for `tasks.map(t => t.id)`.
   *
   * Orchestrators and scripts that only need the IDs (e.g. to spawn agents or
   * log wave membership) can read this field directly without mapping over
   * the enriched task objects.  Always populated when `tasks` is non-empty.
   */
  taskIds: string[];
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

  const blockedBy = getReadinessDependencyBlockers(depends, taskMap);

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

/**
 * Compute execution waves using topological sort.
 *
 * @remarks
 * Only done or archived dependencies satisfy readiness. Earlier planned waves
 * establish ordering, not evidence that their tasks have already completed.
 * Missing or unfinished dependencies outside the selected population remain
 * unresolved and are retained in the final pending wave. Terminal tasks are
 * excluded from scheduling; cancelled dependencies still block their dependants.
 *
 * @param tasks - Selected tasks to partition into dependency waves.
 * @param dependencyLookup - Loaded dependency population, including external tasks.
 * @returns Ordered planned waves, with unresolved work retained as pending.
 *
 * @example
 * ```ts
 * const waves = computeWaves(tasks, projectTaskMap);
 * ```
 */
export function computeWaves(
  tasks: Task[],
  dependencyLookup: ReadonlyMap<string, Task> = new Map(tasks.map((task) => [task.id, task])),
): Wave[] {
  const waves: Wave[] = [];
  const planned = new Set<string>();
  let remaining = tasks.filter((task) => !['done', 'cancelled', 'archived'].includes(task.status));
  let waveNumber = 1;
  const maxWaves = 50;

  while (remaining.length > 0 && waveNumber <= maxWaves) {
    const waveTasks = remaining.filter((t) => {
      return getReadinessDependencyBlockers(t.depends, dependencyLookup).every((id) =>
        planned.has(id),
      );
    });

    if (waveTasks.length === 0) break;

    const waveStatus: Wave['status'] = waveTasks.some((task) => task.status === 'active')
      ? 'in_progress'
      : 'pending';

    waves.push({
      waveNumber,
      tasks: waveTasks.map((t) => t.id),
      status: waveStatus,
    });

    for (const t of waveTasks) {
      planned.add(t.id);
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
 * Get enriched wave data for an epic or a selected set of saga members.
 *
 * @remarks
 * Resolves the selected parents' direct children, computes one topological plan, enriches
 * each wave's task list with dependency metadata, sorts tasks within each wave
 * by priority descending then open-dep count ascending, and attaches a
 * `completedAt` timestamp to completed waves.
 *
 * @param epicId   - The epic task ID to compute waves for.
 * @param cwd      - Optional project root (falls back to `getTaskAccessor` default).
 * @param accessor - Optional pre-constructed data accessor (useful in tests).
 * @param parentIds - Containment parents to select; defaults to the requested epic.
 * @returns Selected task counts and waves with current dependency readiness.
 *
 * @example
 * ```ts
 * const plan = await getEnrichedWaves(sagaId, root, accessor, memberEpicIds);
 * ```
 */
export async function getEnrichedWaves(
  epicId: string,
  cwd?: string,
  accessor?: DataAccessor,
  parentIds: readonly string[] = [epicId],
): Promise<{ epicId: string; waves: EnrichedWave[]; totalWaves: number; totalTasks: number }> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const selected = new Map<string, Task>();
  for (const parentId of new Set(parentIds)) {
    for (const task of await acc.getChildren(parentId)) selected.set(task.id, task);
  }
  const children = [...selected.values()];
  const taskMap = new Map(selected);
  const externalIds = [...new Set(children.flatMap((task) => task.depends ?? []))].filter(
    (id) => !selected.has(id),
  );
  if (externalIds.length > 0) {
    for (const task of await acc.loadTasks(externalIds)) taskMap.set(task.id, task);
  }
  const waves = computeWaves(children, taskMap);

  const enrichedWaves: EnrichedWave[] = waves.map((w) => {
    const enrichedTasks = sortWaveTasks(w.tasks.map((id) => enrichTask(id, taskMap)));

    const wave: EnrichedWave = {
      waveNumber: w.waveNumber,
      status: w.status,
      tasks: enrichedTasks,
      taskIds: enrichedTasks.map((t) => t.id),
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
