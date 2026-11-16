/**
 * Blocker computation — coreTaskBlockers.
 * @task T10064
 * @epic T9834
 */

import type { BottleneckTask } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  getReadinessDependencyBlockers,
  getTransitiveBlockers,
  loadReadinessDependencyLookup,
} from './dependency-check.js';

/**
 * Show blocked tasks and analyze blocking chains.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Optional analysis configuration
 * @param params.analyze - When true, compute transitive blocking chains
 * @param params.limit - Maximum number of blocked tasks to return (default: 20)
 * @returns Blocked tasks with optional blocking chains, critical bottleneck tasks, and a summary
 *
 * @remarks
 * Collects both explicitly blocked tasks and dependency-blocked pending tasks.
 * Critical blockers are the top 5 tasks that appear most frequently in blocking chains.
 *
 * @example
 * ```typescript
 * const result = await coreTaskBlockers('/project', { analyze: true, limit: 10 });
 * console.log(result.summary, result.criticalBlockers);
 * ```
 *
 * @task T4790
 */
export async function coreTaskBlockers(
  projectRoot: string,
  params?: { analyze?: boolean; limit?: number },
): Promise<{
  blockedTasks: Array<{
    id: string;
    title: string;
    status: string;
    depends?: string[];
    blockingChain: string[];
  }>;
  criticalBlockers: BottleneckTask[];
  summary: string;
  total: number;
  limit: number;
}> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks: allTasks } = await accessor.queryTasks({});
  const taskMap = await loadReadinessDependencyLookup(allTasks, accessor);
  const analyze = params?.analyze ?? false;
  const effectiveLimit = params?.limit ?? 20;

  const blockedTasks = allTasks.filter((t) => t.status === 'blocked');

  const depBlockedTasks = allTasks.filter(
    (task) =>
      task.status === 'pending' && getReadinessDependencyBlockers(task.depends, taskMap).length > 0,
  );

  const tasksAsTask = [...taskMap.values()];
  const blockerInfos = [
    ...blockedTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends: t.depends,
      blockingChain: analyze ? getTransitiveBlockers(t.id, tasksAsTask) : [],
    })),
    ...depBlockedTasks
      .filter((t) => !blockedTasks.some((bt) => bt.id === t.id))
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        depends: t.depends,
        blockingChain: analyze ? getTransitiveBlockers(t.id, tasksAsTask) : [],
      })),
  ];

  const total = blockerInfos.length;
  const pagedBlockerInfos = blockerInfos.slice(0, effectiveLimit);

  const blockerCounts = new Map<string, number>();
  for (const info of pagedBlockerInfos) {
    for (const depId of info.blockingChain) {
      blockerCounts.set(depId, (blockerCounts.get(depId) ?? 0) + 1);
    }
  }

  const criticalBlockers = [...blockerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => {
      const task = taskMap.get(id);
      return { id, title: task?.title ?? 'Unknown', blocksCount: count };
    });

  return {
    blockedTasks: pagedBlockerInfos,
    criticalBlockers,
    summary: total === 0 ? 'No blocked tasks found' : `${total} blocked task(s)`,
    total,
    limit: effectiveLimit,
  };
}
