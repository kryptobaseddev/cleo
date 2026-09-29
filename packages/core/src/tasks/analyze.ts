/**
 * Task analysis and prioritization core module.
 * @task T4538
 * @epic T4454
 */

import type { Task, TaskAnalysisResult, TaskWorkState } from '@cleocode/contracts';
import { resolveOrCwd } from '../paths.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { computeLeverage } from '../task-tools/score-task-priority.js';
import { rankReadyTasks, resolveRankingPhase } from './task-next.js';

export interface AnalysisResult extends TaskAnalysisResult {
  autoStarted?: boolean;
}

/** One ranked task as the analyze tiers report it. */
export interface AnalysisRankedTask {
  id: string;
  title: string;
  /** Open tasks this task unblocks (the scorer's leverage input). */
  leverage: number;
  priority: Task['priority'];
  score: number;
}

/**
 * Rank tasks for `cleo analyze` exactly as `cleo next` and the briefing do —
 * {@link rankReadyTasks} with {@link resolveRankingPhase} and BRAIN patterns —
 * so all three recommend the same task in the same order (T12661).
 *
 * @param accessor - Task data accessor.
 * @param allTasks - The active task population.
 * @param opts - Project root (for BRAIN patterns) and an optional id scope.
 * @returns Ranked ready tasks with their open-dependent leverage.
 * @task T12661
 */
export async function rankForAnalysis(
  accessor: DataAccessor,
  allTasks: readonly Task[],
  opts: { projectRoot?: string; scopeTaskIds?: ReadonlySet<string> } = {},
): Promise<{ ranked: AnalysisRankedTask[] }> {
  const { ranked, leverage } = await rankReadyTasks(accessor, allTasks, {
    currentPhase: await resolveRankingPhase(accessor),
    ...opts,
  });
  return {
    ranked: ranked.map(({ task, score }) => ({
      id: task.id,
      title: task.title,
      leverage: leverage.get(task.id) ?? 0,
      priority: task.priority,
      score,
    })),
  };
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
  // Open tasks each task unblocks — the same leverage the shared scorer uses (T12661).
  const openDependents = computeLeverage(tasks);

  const blocked = tasks.filter((t) => t.status === 'blocked');

  // Bottlenecks (tasks that block the most others)
  const bottlenecks = tasks
    .filter((t) => (openDependents.get(t.id) ?? 0) > 0 && t.status !== 'done')
    .map((t) => ({ id: t.id, title: t.title, blocksCount: openDependents.get(t.id) ?? 0 }))
    .sort((a, b) => b.blocksCount - a.blocksCount || a.id.localeCompare(b.id))
    .slice(0, 5);

  // Tier tasks — the SAME ranking as `cleo next` and the briefing (T12661):
  // ready candidates, current phase, BRAIN patterns, shared scorer.
  const { ranked: scored } = await rankForAnalysis(acc, tasks, {
    projectRoot: resolveOrCwd(opts.cwd),
  });
  // The metric keeps its meaning (pending + active); the tiers above rank only
  // the READY subset, exactly as `cleo next` does.
  const actionable = tasks.filter((t) => t.status === 'pending' || t.status === 'active');

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

  const totalLeverage = [...openDependents.values()].reduce((s, v) => s + v, 0);
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
