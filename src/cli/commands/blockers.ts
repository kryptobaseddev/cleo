/**
 * CLI blockers command - show blocked tasks and analyze blocking chains.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { Task } from '../../types/task.js';

interface BlockerInfo {
  id: string;
  title: string;
  status: string;
  blockedBy?: string;
  depends?: string[];
  blockingChain: string[];
}

/**
 * Build the blocking chain for a task (recursive).
 */
function buildBlockingChain(task: Task, taskMap: Map<string, Task>, visited: Set<string> = new Set()): string[] {
  const chain: string[] = [];
  if (visited.has(task.id)) return chain;
  visited.add(task.id);

  if (task.depends) {
    for (const depId of task.depends) {
      const dep = taskMap.get(depId);
      if (dep && dep.status !== 'done' && dep.status !== 'cancelled') {
        chain.push(depId);
        chain.push(...buildBlockingChain(dep, taskMap, visited));
      }
    }
  }

  return chain;
}

export function registerBlockersCommand(program: Command): void {
  program
    .command('blockers')
    .description('Show blocked tasks and analyze blocking chains')
    .option('--analyze', 'Show full blocking chain analysis')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const data = await accessor.loadTodoFile();

        const taskMap = new Map(data.tasks.map((t) => [t.id, t]));

        // Find blocked tasks
        const blockedTasks = data.tasks.filter((t) => t.status === 'blocked');

        // Find tasks with unsatisfied dependencies
        const depBlockedTasks = data.tasks.filter((t) =>
          t.status === 'pending' &&
          t.depends &&
          t.depends.length > 0 &&
          t.depends.some((depId) => {
            const dep = taskMap.get(depId);
            return dep && dep.status !== 'done' && dep.status !== 'cancelled';
          }),
        );

        const analyze = !!opts['analyze'];

        const blockerInfos: BlockerInfo[] = [
          ...blockedTasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            blockedBy: t.blockedBy,
            depends: t.depends,
            blockingChain: analyze ? buildBlockingChain(t, taskMap) : [],
          })),
          ...depBlockedTasks
            .filter((t) => !blockedTasks.some((bt) => bt.id === t.id))
            .map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              depends: t.depends,
              blockingChain: analyze ? buildBlockingChain(t, taskMap) : [],
            })),
        ];

        // Find critical blockers (tasks that block the most others)
        const blockerCounts = new Map<string, number>();
        for (const info of blockerInfos) {
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

        if (blockerInfos.length === 0) {
          console.log(formatSuccess({
            blockedTasks: [],
            criticalBlockers: [],
            summary: 'No blocked tasks found',
          }));
          process.exit(ExitCode.NO_DATA);
          return;
        }

        console.log(formatSuccess({
          blockedTasks: blockerInfos,
          criticalBlockers,
          summary: `${blockerInfos.length} blocked task(s)`,
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
