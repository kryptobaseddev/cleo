/**
 * Wave computation and dependency graph operations.
 * @task T4784
 */

import type { ScoreTaskContext, Task, TaskPriority, TaskRef } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { orderByRanking } from '../task-tools/score-task-priority.js';
import {
  getReadinessDependencyBlockers,
  loadReadinessDependencyLookup,
} from '../tasks/dependency-check.js';
import { loadRankingContext } from '../tasks/task-next.js';

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
 * Tasks within the wave are in THE comparator's order (D11161, T12692):
 * priority band, attested severity, bounded tiebreak, createdAt, id.
 */
export interface EnrichedWave {
  /** 1-based wave number. */
  waveNumber: number;
  /** Enriched tasks for this wave, in comparator order. */
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
 * Order each wave's members by THE comparator (D11161, T12692). Only the
 * order WITHIN a wave moves; wave numbers stay structural depth (T12683).
 *
 * @param waves - Waves in structural order.
 * @param taskMap - Dependency closure the waves were computed over.
 * @param ranking - The project-wide ranking context (see `loadRankingContext`).
 * @returns The same waves with members in ranked order.
 */
function orderWaveMembers(
  waves: Wave[],
  taskMap: ReadonlyMap<string, Task>,
  ranking: ScoreTaskContext,
): Wave[] {
  return waves.map((w) => ({
    ...w,
    tasks: orderByRanking(w.tasks, (id) => id, taskMap, ranking),
  }));
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
 * Compute execution waves: each task's wave is its STRUCTURAL DEPTH in the
 * dependency graph (T12682, T12683 — owner option A).
 *
 * @remarks
 * `wave(t) = 1 + max(wave(d))` over every dependency `d` the lookup knows,
 * whatever `d`'s status and whichever epic holds it; 1 when there is none.
 * A wave number therefore never changes when work completes, a finished task
 * is archived, a dependency is re-parented to another epic, or an external
 * dependency finishes — only an edit to the dependency edges themselves can
 * move a task. Numbers can skip (a task whose external prerequisite sits at
 * depth 3 is in wave 4 even if waves 2–3 hold nothing of this epic); the
 * listing shows the waves that hold tasks, each under its own number.
 *
 * - A finished wave (every task done, cancelled or archived) is `completed`;
 *   a partly finished one, or one with an active task, is `in_progress`.
 * - A dependency the lookup does not know contributes nothing to depth;
 *   readiness still reports it as a blocker.
 * - Tasks on a dependency cycle have no depth; they share a final wave after
 *   the deepest one.
 * - Readiness (`ready`, `blockedBy`) is per task, not per wave: an earlier
 *   wave is ordering, not completion.
 *
 * @param tasks - Selected tasks to partition into dependency waves.
 * @param dependencyLookup - Dependency population: the selection plus every
 *   task reachable through `depends` (see {@link planEpicWaves}).
 * @returns Waves ordered by number, finished ones included as `completed`.
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
  const depth = new Map<string, number>();
  const cyclic = new Set<string>();
  const visiting = new Set<string>();
  const lookup = (id: string): Task | undefined =>
    dependencyLookup.get(id) ?? tasks.find((t) => t.id === id);

  // Iterative post-order DFS: no recursion limit, no wave cap.
  const depthOf = (root: string): number | null => {
    const stack: Array<{ id: string; next: number; best: number }> = [
      { id: root, next: 0, best: 1 },
    ];
    visiting.add(root);
    let result: number | null = null;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number; best: number };
      const deps = lookup(frame.id)?.depends ?? [];
      if (frame.next < deps.length) {
        const dep = deps[frame.next++] as string;
        if (!lookup(dep)) continue; // unknown: no depth contribution
        if (cyclic.has(dep) || visiting.has(dep)) {
          for (const f of stack) cyclic.add(f.id);
          continue;
        }
        const known = depth.get(dep);
        if (known !== undefined) {
          frame.best = Math.max(frame.best, known + 1);
          continue;
        }
        visiting.add(dep);
        stack.push({ id: dep, next: 0, best: 1 });
        continue;
      }
      stack.pop();
      visiting.delete(frame.id);
      const value = cyclic.has(frame.id) ? null : frame.best;
      if (value !== null) depth.set(frame.id, value);
      const parent = stack[stack.length - 1];
      if (parent && value !== null) parent.best = Math.max(parent.best, value + 1);
      if (stack.length === 0) result = value;
    }
    return result;
  };

  const byWave = new Map<number, Task[]>();
  const unplaced: Task[] = [];
  for (const task of tasks) {
    const d = depth.get(task.id) ?? (cyclic.has(task.id) ? null : depthOf(task.id));
    if (d === null) unplaced.push(task);
    else byWave.set(d, [...(byWave.get(d) ?? []), task]);
  }

  const statusOf = (members: readonly Task[]): Wave['status'] =>
    members.every((t) => isTerminalWaveStatus(t.status))
      ? 'completed'
      : members.some((t) => t.status === 'active' || isTerminalWaveStatus(t.status))
        ? 'in_progress'
        : 'pending';

  const waves: Wave[] = [...byWave.entries()]
    .sort(([a], [b]) => a - b)
    .map(([waveNumber, members]) => ({
      waveNumber,
      tasks: members.map((t) => t.id),
      status: statusOf(members),
    }));
  if (unplaced.length > 0) {
    waves.push({
      waveNumber: (waves[waves.length - 1]?.waveNumber ?? 0) + 1,
      tasks: unplaced.map((t) => t.id),
      status: statusOf(unplaced),
    });
  }
  return waves;
}

/**
 * The selection plus every task reachable from it through `depends`, loaded
 * by identity (archived and other-epic tasks included), so structural depth
 * sees the whole dependency graph (T12683).
 *
 * @param selected - Selected tasks.
 * @param accessor - Task accessor.
 * @returns Identity lookup of the dependency closure.
 * @task T12683
 */
async function loadDependencyClosure(
  selected: readonly Task[],
  accessor: DataAccessor,
): Promise<Map<string, Task>> {
  const closure = await loadReadinessDependencyLookup(selected, accessor);
  let frontier = [...closure.values()].filter((t) => !selected.some((s) => s.id === t.id));
  const asked = new Set(closure.keys());
  while (frontier.length > 0) {
    const missing = [...new Set(frontier.flatMap((t) => t.depends ?? []))].filter(
      (id) => !asked.has(id),
    );
    for (const id of missing) asked.add(id);
    if (missing.length === 0) break;
    const loaded = await accessor.loadTasks(missing);
    for (const task of loaded) closure.set(task.id, task);
    frontier = loaded;
  }
  return closure;
}

/**
 * The planned waves of an epic, numbered exactly as `cleo orchestrate waves`
 * prints them (from 1). The one plan every wave consumer reads — the waves
 * listing, `orchestrate roll-up --wave`, and the wave topic a spawned worker
 * publishes on — so a wave number means the same wave everywhere (T12682).
 *
 * Members of each wave are in THE comparator's order (D11161, T12692); the
 * wave numbers are structural depth and never depend on the ranking.
 *
 * @param epicId - Epic whose direct children are planned.
 * @param accessor - Task accessor.
 * @param parentIds - Containment parents to select; defaults to the epic.
 * @param ranking - Shared ranking context; when absent, the project-wide one
 *   `cleo next` and `orchestrate waves` use is loaded once (`loadRankingContext`),
 *   so every wave surface orders members identically (T12692). Pass it in when
 *   planning several waves or epics in one call.
 * @param cwd - Project root, for the ranking context's focus phase (T12501).
 * @returns The selected children, the dependency lookup and the waves.
 * @task T12682
 * @task T12692
 */
export async function planEpicWaves(
  epicId: string,
  accessor: DataAccessor,
  parentIds: readonly string[] = [epicId],
  ranking?: ScoreTaskContext,
  cwd?: string,
): Promise<{ children: Task[]; taskMap: Map<string, Task>; waves: Wave[] }> {
  const selected = new Map<string, Task>();
  for (const parentId of new Set(parentIds)) {
    for (const task of await accessor.getChildren(parentId)) selected.set(task.id, task);
  }
  const children = [...selected.values()];
  const taskMap = await loadDependencyClosure(children, accessor);
  const ctx = ranking ?? (await loadRankingContext(accessor, undefined, { cwd })).ctx;
  return {
    children,
    taskMap,
    waves: orderWaveMembers(computeWaves(children, taskMap), taskMap, ctx),
  };
}

/**
 * Get enriched wave data for an epic or a selected set of saga members.
 *
 * @remarks
 * Resolves the selected parents' direct children, computes one topological plan, enriches
 * each wave's task list with dependency metadata, keeps each wave's members in
 * the comparator order of {@link planEpicWaves} (D11161, T12692), and attaches
 * a `completedAt` timestamp to completed waves.
 *
 * @param epicId   - The epic task ID to compute waves for.
 * @param cwd      - Optional project root (falls back to `getTaskAccessor` default).
 * @param accessor - Optional pre-constructed data accessor (useful in tests).
 * @param parentIds - Containment parents to select; defaults to the requested epic.
 * @param ranking - Shared ranking context; when absent, the project-wide one
 *   `cleo next` and `orchestrate waves` use is loaded once (`loadRankingContext`),
 *   so every wave surface orders members identically (T12692). Pass it in when
 *   planning several waves or epics in one call.
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
  ranking?: ScoreTaskContext,
): Promise<{ epicId: string; waves: EnrichedWave[]; totalWaves: number; totalTasks: number }> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const { children, taskMap, waves } = await planEpicWaves(epicId, acc, parentIds, ranking, cwd);

  const enrichedWaves: EnrichedWave[] = waves.map((w) => {
    const enrichedTasks = w.tasks.map((id) => enrichTask(id, taskMap));

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
