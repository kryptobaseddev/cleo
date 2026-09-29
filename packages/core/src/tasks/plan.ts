/**
 * Composite planning view - aggregates multiple task queries for planning.
 * @task T4914
 * @epic T4454
 */

import type { Task } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { formatScoreFactor } from '../task-tools/score-task-priority.js';
import {
  getReadinessDependencyBlockers,
  loadReadinessDependencyLookup,
} from './dependency-check.js';
import { rankReadyTasks, resolveRankingPhase } from './task-next.js';

type TaskRecord = Task;

/** In-progress epic entry. */
export interface InProgressEpic {
  epicId: string;
  epicTitle: string;
  activeTasks: number;
  completionPercent: number;
}

/** Ready task entry with leverage analysis. */
export interface ReadyTask extends Pick<Task, 'id' | 'title' | 'priority'> {
  epicId: string;
  leverage: number;
  score: number;
  reasons: string[];
}

/** Blocked task entry. */
export interface BlockedTask extends Pick<Task, 'id' | 'title'> {
  blockedBy: string[];
  blocksCount: number;
}

/** Open bug entry. */
export interface OpenBug extends Pick<Task, 'id' | 'title' | 'priority'> {
  epicId: string;
}

/** Planning metrics. */
export interface PlanMetrics {
  totalEpics: number;
  activeEpics: number;
  totalTasks: number;
  actionable: number;
  blocked: number;
  openBugs: number;
  avgLeverage: number;
}

/** Composite planning view result. */
export interface PlanResult {
  inProgress: InProgressEpic[];
  ready: ReadyTask[];
  blocked: BlockedTask[];
  openBugs: OpenBug[];
  metrics: PlanMetrics;
}

/**
 * Calculate leverage score for a task based on how many other tasks depend on it.
 */
function calculateLeverage(taskId: string, taskMap: Map<string, TaskRecord>): number {
  let leverage = 0;
  for (const task of taskMap.values()) {
    if (task.depends?.includes(taskId)) {
      leverage++;
    }
  }
  return leverage;
}

/**
 * Find the epic ID for a task (parent epic, not immediate parent).
 */
function findEpicId(task: TaskRecord, taskMap: Map<string, TaskRecord>): string {
  let current: TaskRecord | undefined = task;
  const visited = new Set<string>();

  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = taskMap.get(current.parentId);
    if (!parent) break;
    if (parent.type === 'epic') {
      return parent.id;
    }
    current = parent;
  }

  // If task itself is an epic
  if (task.type === 'epic') {
    return task.id;
  }

  // Return parentId as fallback, or task's own id
  return task.parentId ?? task.id;
}

/**
 * Calculate completion percentage for an epic.
 */
function calculateEpicCompletion(
  epicId: string,
  taskMap: Map<string, TaskRecord>,
): { activeTasks: number; completionPercent: number } {
  let totalTasks = 0;
  let completedTasks = 0;
  let activeTasks = 0;

  // Count direct children and their descendants
  const collectTasks = (parentId: string): void => {
    for (const task of taskMap.values()) {
      if (task.parentId === parentId) {
        totalTasks++;
        if (task.status === 'done' || task.status === 'cancelled') {
          completedTasks++;
        }
        if (task.status === 'active') {
          activeTasks++;
        }
        // Recursively count descendants
        collectTasks(task.id);
      }
    }
  };

  collectTasks(epicId);

  const completionPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return { activeTasks, completionPercent };
}

/**
 * Build a composite plan with canonical hard-dependency evidence.
 *
 * @remarks
 * Candidate selection, hierarchy and metrics retain the active query population.
 * A separate lookup resolves explicit external dependencies, including archived
 * records. Missing or cancelled dependencies remain blockers; required read
 * failures propagate rather than returning an apparently healthy empty plan.
 *
 * @param projectRoot - Explicit owning project root.
 * @returns Ranked candidates, unresolved blockers and selected-population metrics.
 * @throws Error when required task or dependency evidence cannot be read.
 * @example
 * ```ts
 * const plan = await coreTaskPlan(projectRoot);
 * ```
 * @task T4914
 */
export async function coreTaskPlan(projectRoot: string): Promise<PlanResult> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks: allTasks } = await accessor.queryTasks({});
  const dependencyLookup = await loadReadinessDependencyLookup(allTasks, accessor);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  // ========================================================================
  // 1. In-Progress Epics (epics with active status)
  // ========================================================================
  const inProgressEpics: InProgressEpic[] = [];
  for (const task of allTasks) {
    if (task.type === 'epic' && task.status === 'active') {
      const { activeTasks, completionPercent } = calculateEpicCompletion(task.id, taskMap);
      inProgressEpics.push({
        epicId: task.id,
        epicTitle: task.title,
        activeTasks,
        completionPercent,
      });
    }
  }

  // ========================================================================
  // 2. Ready Tasks (pending tasks with deps satisfied)
  // ========================================================================
  // T12692: THE comparator (D11161) — the same ranking, candidates and
  // factors as `cleo next`; this view no longer keeps its own additive score.
  const { ranked } = await rankReadyTasks(accessor, allTasks, {
    currentPhase: await resolveRankingPhase(accessor),
  });
  const readyTasks: ReadyTask[] = ranked.map(({ task, score, factors }) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    epicId: findEpicId(task, taskMap),
    leverage: calculateLeverage(task.id, taskMap),
    score,
    reasons: factors.map(formatScoreFactor),
  }));

  // ========================================================================
  // 3. Blocked Tasks
  // ========================================================================
  const blockedTasks: BlockedTask[] = [];

  // Tasks with blocked status
  for (const task of allTasks) {
    if (task.status === 'blocked') {
      const blockedBy: string[] = [];
      if (task.blockedBy) {
        blockedBy.push(task.blockedBy);
      }
      blockedBy.push(...getReadinessDependencyBlockers(task.depends, dependencyLookup));

      // Calculate how many tasks this blocks
      let blocksCount = 0;
      for (const t of allTasks) {
        if (t.depends?.includes(task.id)) {
          blocksCount++;
        }
      }

      blockedTasks.push({
        id: task.id,
        title: task.title,
        blockedBy,
        blocksCount,
      });
    }
  }

  // Tasks with unresolved dependencies (pending + has incomplete deps)
  for (const task of allTasks) {
    if (task.status === 'pending' && task.depends && task.depends.length > 0) {
      const blockedBy = getReadinessDependencyBlockers(task.depends, dependencyLookup);
      if (blockedBy.length > 0 && !blockedTasks.some((b) => b.id === task.id)) {
        // Calculate how many tasks this blocks
        let blocksCount = 0;
        for (const t of allTasks) {
          if (t.depends?.includes(task.id)) {
            blocksCount++;
          }
        }

        blockedTasks.push({
          id: task.id,
          title: task.title,
          blockedBy,
          blocksCount,
        });
      }
    }
  }

  // ========================================================================
  // 4. Open Bugs (origin:bug-report OR label:bug)
  // ========================================================================
  const openBugs: OpenBug[] = [];

  for (const task of allTasks) {
    const isBug = task.origin === 'bug-report' || task.labels?.includes('bug');
    const isOpen = task.status !== 'done' && task.status !== 'cancelled';

    if (isBug && isOpen) {
      const epicId = findEpicId(task, taskMap);
      openBugs.push({
        id: task.id,
        title: task.title,
        priority: task.priority,
        epicId,
      });
    }
  }

  // ========================================================================
  // 5. Metrics
  // ========================================================================
  const epics = allTasks.filter((t) => t.type === 'epic');
  const activeEpics = epics.filter((t) => t.status === 'active').length;

  const actionable = allTasks.filter(
    (t) =>
      (t.status === 'pending' || t.status === 'active') && !blockedTasks.some((b) => b.id === t.id),
  ).length;

  const blocked = blockedTasks.length;

  // Calculate average leverage across all tasks
  let totalLeverage = 0;
  for (const task of allTasks) {
    totalLeverage += calculateLeverage(task.id, taskMap);
  }
  const avgLeverage =
    allTasks.length > 0 ? Math.round((totalLeverage / allTasks.length) * 100) / 100 : 0;

  const metrics: PlanMetrics = {
    totalEpics: epics.length,
    activeEpics,
    totalTasks: allTasks.length,
    actionable,
    blocked,
    openBugs: openBugs.length,
    avgLeverage,
  };

  return {
    inProgress: inProgressEpics,
    ready: readyTasks,
    blocked: blockedTasks,
    openBugs,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrapper (T1568 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * Compute a ranked plan: in-progress epics, ready tasks, blockers, bugs.
 * Wrapped in EngineResult for use by the dispatch layer.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with the plan data
 *
 * @task T1568
 * @epic T1566
 */
export async function taskPlan(projectRoot: string): Promise<EngineResult> {
  try {
    const result = await coreTaskPlan(projectRoot);
    return engineSuccess(result);
  } catch (err: unknown) {
    // T9940: preserve CleoError LAFS codes; non-CleoError → E_INTERNAL,
    // never the misleading E_NOT_INITIALIZED blanket label.
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to build task plan');
  }
}
