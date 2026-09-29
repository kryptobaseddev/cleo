/**
 * Task analysis and prioritization core module.
 * @task T4538
 * @epic T4454
 */

import type { TaskAnalysisResult, TaskWorkState } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { computeLeverage, rankTasks } from '../task-tools/score-task-priority.js';

export interface AnalysisResult extends TaskAnalysisResult {
  autoStarted?: boolean;
}

/** Analyze task priority with leverage scoring. */
export async function analyzeTaskPriority(
  opts: {
    autoStart?: boolean;
    cwd?: string;
  },
  accessor?: DataAccessor,
): Promise<AnalysisResult> {
  const acc = accessor ?? (await getTaskAccessor(opts.cwd));
  const { tasks } = await acc.queryTasks({});

  // Build dependency graph
  const blocksMap: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.depends) {
      for (const dep of task.depends) {
        if (!blocksMap[dep]) blocksMap[dep] = [];
        blocksMap[dep]!.push(task.id);
      }
    }
  }

  // Calculate leverage for each task
  const leverageMap: Record<string, number> = {};
  for (const task of tasks) {
    leverageMap[task.id] = (blocksMap[task.id] ?? []).length;
  }

  // Find actionable tasks (pending/active, not blocked)
  const actionable = tasks.filter((t) => t.status === 'pending' || t.status === 'active');

  const blocked = tasks.filter((t) => t.status === 'blocked');

  // Bottlenecks (tasks that block the most others)
  const bottlenecks = tasks
    .filter((t) => (blocksMap[t.id]?.length ?? 0) > 0 && t.status !== 'done')
    .map((t) => ({ id: t.id, title: t.title, blocksCount: blocksMap[t.id]!.length }))
    .sort((a, b) => b.blocksCount - a.blocksCount)
    .slice(0, 5);

  // Tier tasks — ranked by the shared scorer (T12661), the same weights as
  // `cleo next` and the briefing (severity, bug kind, bounded leverage and age).
  const leverage = computeLeverage(tasks);
  const scored = rankTasks(actionable, {
    taskStatuses: new Map(tasks.map((t) => [t.id, t.status] as const)),
    leverage,
  }).map(({ task, score }) => ({
    id: task.id,
    title: task.title,
    leverage: leverageMap[task.id] ?? 0,
    priority: task.priority,
    score,
  }));

  const critical = scored.filter((t) => t.priority === 'critical');
  const high = scored.filter((t) => t.priority === 'high');
  const normal = scored.filter((t) => t.priority !== 'critical' && t.priority !== 'high');

  const recommended =
    scored.length > 0
      ? {
          id: scored[0]!.id,
          title: scored[0]!.title,
          leverage: scored[0]!.leverage,
          reason:
            'Highest score from the shared task ranking (priority, severity, leverage, readiness, age)',
        }
      : null;

  const totalLeverage = Object.values(leverageMap).reduce((s, v) => s + v, 0);
  const avgLeverage = tasks.length > 0 ? Math.round((totalLeverage / tasks.length) * 100) / 100 : 0;

  let autoStarted = false;
  if (opts.autoStart && recommended) {
    const currentFocus = await acc.getMetaValue<TaskWorkState>('focus_state');
    await acc.setMetaValue('focus_state', { ...(currentFocus ?? {}), currentTask: recommended.id });
    autoStarted = true;
  }

  return {
    recommended,
    bottlenecks,
    tiers: {
      critical: critical.map(({ id, title, leverage }) => ({ id, title, leverage })),
      high: high.map(({ id, title, leverage }) => ({ id, title, leverage })),
      normal: normal.slice(0, 10).map(({ id, title, leverage }) => ({ id, title, leverage })),
    },
    metrics: {
      totalTasks: tasks.length,
      actionable: actionable.length,
      blocked: blocked.length,
      avgLeverage,
    },
    ...(autoStarted && { autoStarted }),
  };
}
