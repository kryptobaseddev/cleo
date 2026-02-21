/**
 * Unblock opportunities analysis.
 * @task T4784
 */

import { readJson } from '../../store/json.js';
import { getTodoPath } from '../paths.js';
import type { Task, TodoFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

export interface HighImpactTask {
  taskId: string;
  title: string;
  wouldUnblock: number;
  dependents: string[];
}

export interface SingleBlockerTask {
  taskId: string;
  title: string;
  remainingBlocker: { id: string; title: string };
}

export interface CommonBlocker {
  taskId: string;
  title: string;
  blocksCount: number;
  blockedTasks: string[];
}

export interface UnblockResult {
  highImpact: HighImpactTask[];
  singleBlocker: SingleBlockerTask[];
  commonBlockers: CommonBlocker[];
}

/** Build a reverse dependency map. */
function buildReverseDependencyMap(tasks: Task[]): Map<string, string[]> {
  const reverseMap = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.depends) {
      for (const dep of task.depends) {
        const existing = reverseMap.get(dep) || [];
        existing.push(task.id);
        reverseMap.set(dep, existing);
      }
    }
  }
  return reverseMap;
}

/** Count all transitive dependents. */
function countTransitiveDependents(
  taskId: string,
  reverseMap: Map<string, string[]>,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(taskId)) return [];
  visited.add(taskId);

  const directDependents = reverseMap.get(taskId) || [];
  const allDependents: string[] = [...directDependents];

  for (const dep of directDependents) {
    const transitive = countTransitiveDependents(dep, reverseMap, visited);
    allDependents.push(...transitive);
  }

  return allDependents;
}

/** Analyze dependency graph for unblocking opportunities. */
export async function getUnblockOpportunities(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<UnblockResult> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJson<TodoFile>(getTodoPath(cwd));

  const tasks = data?.tasks ?? [];
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const completedIds = new Set(
    tasks.filter(t => t.status === 'done' || t.status === 'cancelled').map(t => t.id),
  );
  const nonDoneTasks = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
  const reverseMap = buildReverseDependencyMap(tasks);

  // 1. High-impact completions
  const highImpact: HighImpactTask[] = [];
  for (const task of nonDoneTasks) {
    const allDependents = countTransitiveDependents(task.id, reverseMap, new Set());
    const uniqueDependents = [...new Set(allDependents)];
    if (uniqueDependents.length > 0) {
      highImpact.push({
        taskId: task.id,
        title: task.title,
        wouldUnblock: uniqueDependents.length,
        dependents: uniqueDependents,
      });
    }
  }
  highImpact.sort((a, b) => b.wouldUnblock - a.wouldUnblock);

  // 2. Single-blocker tasks
  const singleBlocker: SingleBlockerTask[] = [];
  for (const task of tasks) {
    if (!task.depends || task.depends.length === 0) continue;
    const incompleteDeps = task.depends.filter(depId => !completedIds.has(depId));
    if (incompleteDeps.length === 1) {
      const blockerId = incompleteDeps[0]!;
      const blockerTask = taskMap.get(blockerId);
      singleBlocker.push({
        taskId: task.id,
        title: task.title,
        remainingBlocker: {
          id: blockerId,
          title: blockerTask?.title || blockerId,
        },
      });
    }
  }

  // 3. Common blockers
  const blockerCounts = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.depends) continue;
    for (const depId of task.depends) {
      if (!completedIds.has(depId)) {
        const existing = blockerCounts.get(depId) || [];
        existing.push(task.id);
        blockerCounts.set(depId, existing);
      }
    }
  }

  const commonBlockers: CommonBlocker[] = [];
  for (const [blockerId, blockedTasks] of blockerCounts) {
    if (blockedTasks.length > 1) {
      const blockerTask = taskMap.get(blockerId);
      commonBlockers.push({
        taskId: blockerId,
        title: blockerTask?.title || blockerId,
        blocksCount: blockedTasks.length,
        blockedTasks,
      });
    }
  }
  commonBlockers.sort((a, b) => b.blocksCount - a.blocksCount);

  return { highImpact, singleBlocker, commonBlockers };
}
