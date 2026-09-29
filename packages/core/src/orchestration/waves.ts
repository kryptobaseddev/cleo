/**
 * Wave computation and dependency graph operations.
 * @task T4784
 */

import type { Task, TaskPriority, TaskRef } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  getReadinessDependencyBlockers,
  loadReadinessDependencyLookup,
} from '../tasks/dependency-check.js';

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

/** Statuses whose task has finished (it occupies its wave, but runs no more). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled', 'archived']);

/**
 * Whether a task has finished: done, cancelled or archived.
 *
 * @param status - Task status.
 * @returns True for a terminal status.
 * @task T12682
 */
export function isTerminalWaveStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Compute execution waves using topological sort.
 *
 * @remarks
 * Wave numbers are STABLE (T12682, owner option A): every selected task keeps
 * the wave its dependency depth gives it, whatever its status, so a finished
 * wave keeps its number (status `completed`) and no later wave renumbers when
 * work completes. Agents subscribe ahead to `epic-<id>.wave-<n>` and reuse
 * topics safely because n never shifts.
 *
 * - A dependency inside the selection orders the plan: it must sit in an
 *   earlier wave, whatever its status.
 * - A dependency outside the selection must be done or archived. An
 *   unfinished or missing one holds the task in the final pending wave; only
 *   that task moves when the dependency completes. A finished task ignores
 *   its external dependencies — it already ran.
 * - Readiness (`ready`, `blockedBy`) is reported per task by the enrichment,
 *   not by the wave number: an earlier wave establishes ordering, not
 *   completion.
 *
 * @param tasks - Selected tasks to partition into dependency waves.
 * @param dependencyLookup - Loaded dependency population, including external tasks.
 * @returns Ordered waves numbered from 1, finished ones included as `completed`.
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
  const selected = new Set(tasks.map((t) => t.id));
  let remaining = [...tasks];
  let waveNumber = 1;
  const maxWaves = 50;

  const placeable = (t: Task): boolean =>
    (t.depends ?? []).every((dep) =>
      selected.has(dep)
        ? planned.has(dep)
        : isTerminalWaveStatus(t.status) ||
          getReadinessDependencyBlockers([dep], dependencyLookup).length === 0,
    );
  const statusOf = (ids: readonly Task[]): Wave['status'] =>
    ids.every((t) => isTerminalWaveStatus(t.status))
      ? 'completed'
      : ids.some((t) => t.status === 'active' || isTerminalWaveStatus(t.status))
        ? 'in_progress'
        : 'pending';

  while (remaining.length > 0 && waveNumber <= maxWaves) {
    const waveTasks = remaining.filter(placeable);
    if (waveTasks.length === 0) break;

    waves.push({
      waveNumber,
      tasks: waveTasks.map((t) => t.id),
      status: statusOf(waveTasks),
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
      status: statusOf(remaining),
    });
  }

  return waves;
}

/**
 * The planned waves of an epic, numbered exactly as `cleo orchestrate waves`
 * prints them (from 1). The one plan every wave consumer reads — the waves
 * listing, `orchestrate roll-up --wave`, and the wave topic a spawned worker
 * publishes on — so a wave number means the same wave everywhere (T12682).
 *
 * @param epicId - Epic whose direct children are planned.
 * @param accessor - Task accessor.
 * @param parentIds - Containment parents to select; defaults to the epic.
 * @returns The selected children, the dependency lookup and the waves.
 * @task T12682
 */
export async function planEpicWaves(
  epicId: string,
  accessor: DataAccessor,
  parentIds: readonly string[] = [epicId],
): Promise<{ children: Task[]; taskMap: Map<string, Task>; waves: Wave[] }> {
  const selected = new Map<string, Task>();
  for (const parentId of new Set(parentIds)) {
    for (const task of await accessor.getChildren(parentId)) selected.set(task.id, task);
  }
  const children = [...selected.values()];
  const taskMap = await loadReadinessDependencyLookup(children, accessor);
  return { children, taskMap, waves: computeWaves(children, taskMap) };
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
  const { children, taskMap, waves } = await planEpicWaves(epicId, acc, parentIds);

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
