/**
 * Unblock opportunities analysis.
 * @task T4784
 */

import type { Task, TaskRef } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  getReadinessDependencyBlockers,
  loadReadinessDependencyLookup,
} from '../tasks/dependency-check.js';

export interface HighImpactTask {
  taskId: string;
  title: string;
  wouldUnblock: number;
  dependents: string[];
}

export interface SingleBlockerTask {
  taskId: string;
  title: string;
  remainingBlocker: Pick<TaskRef, 'id' | 'title'>;
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

/**
 * Analyze selected project tasks for dependency-unblocking opportunities.
 * @param cwd - Explicit owning project root, when supplied.
 * @param accessor - Optional canonical accessor already bound to that project.
 * @returns Existing potential-impact rankings and unresolved single/common blockers.
 * @throws Error when selected tasks or required dependency records cannot be read.
 * @remarks Done and archived dependencies satisfy the shared spawn policy;
 * cancelled and missing dependencies remain blockers. Lookup-only archive rows
 * never expand selected tasks. High-impact counts are transitive potential, not
 * proof that every dependent is immediately runnable or admitted.
 * @example
 * ```ts
 * const opportunities = await getUnblockOpportunities(projectRoot, accessor);
 * ```
 */
export async function getUnblockOpportunities(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<UnblockResult> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const { tasks } = await acc.queryTasks({});
  const taskMap = await loadReadinessDependencyLookup(tasks, acc);
  const blockersByTask = new Map(
    tasks.map((task) => [task.id, getReadinessDependencyBlockers(task.depends, taskMap)]),
  );
  const nonDoneTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
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
    const incompleteDeps = blockersByTask.get(task.id)!;
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
    for (const depId of blockersByTask.get(task.id)!) {
      const existing = blockerCounts.get(depId) || [];
      existing.push(task.id);
      blockerCounts.set(depId, existing);
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
