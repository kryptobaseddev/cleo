/**
 * Task analysis and prioritization core module.
 * @task T4538
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { getTodoPath, getBackupDir } from '../paths.js';
import type { TodoFile } from '../../types/task.js';

interface AnalysisResult {
  recommended: { id: string; title: string; leverage: number; reason: string } | null;
  bottlenecks: Array<{ id: string; title: string; blocksCount: number }>;
  tiers: {
    critical: Array<{ id: string; title: string; leverage: number }>;
    high: Array<{ id: string; title: string; leverage: number }>;
    normal: Array<{ id: string; title: string; leverage: number }>;
  };
  metrics: {
    totalTasks: number;
    actionable: number;
    blocked: number;
    avgLeverage: number;
  };
  autoFocused?: boolean;
}

/** Analyze task priority with leverage scoring. */
export async function analyzeTaskPriority(opts: {
  autoFocus?: boolean;
  cwd?: string;
}): Promise<AnalysisResult> {
  const todoPath = getTodoPath(opts.cwd);
  const data = await readJsonRequired<TodoFile>(todoPath);
  const tasks = data.tasks;

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
  const actionable = tasks.filter(t =>
    t.status === 'pending' || t.status === 'active',
  );

  const blocked = tasks.filter(t => t.status === 'blocked');

  // Bottlenecks (tasks that block the most others)
  const bottlenecks = tasks
    .filter(t => (blocksMap[t.id]?.length ?? 0) > 0 && t.status !== 'done')
    .map(t => ({ id: t.id, title: t.title, blocksCount: blocksMap[t.id]!.length }))
    .sort((a, b) => b.blocksCount - a.blocksCount)
    .slice(0, 5);

  // Tier tasks
  const scored = actionable.map(t => ({
    id: t.id,
    title: t.title,
    leverage: leverageMap[t.id] ?? 0,
    priority: t.priority,
  }));

  scored.sort((a, b) => {
    const priorityWeight: Record<string, number> = { critical: 100, high: 50, medium: 20, low: 5 };
    const aScore = (priorityWeight[a.priority ?? 'medium'] ?? 20) + a.leverage * 10;
    const bScore = (priorityWeight[b.priority ?? 'medium'] ?? 20) + b.leverage * 10;
    return bScore - aScore;
  });

  const critical = scored.filter(t => t.priority === 'critical');
  const high = scored.filter(t => t.priority === 'high');
  const normal = scored.filter(t => t.priority !== 'critical' && t.priority !== 'high');

  const recommended = scored.length > 0
    ? { id: scored[0]!.id, title: scored[0]!.title, leverage: scored[0]!.leverage, reason: 'Highest combined priority and leverage score' }
    : null;

  const totalLeverage = Object.values(leverageMap).reduce((s, v) => s + v, 0);
  const avgLeverage = tasks.length > 0
    ? Math.round((totalLeverage / tasks.length) * 100) / 100
    : 0;

  let autoFocused = false;
  if (opts.autoFocus && recommended) {
    data.focus = { ...data.focus, currentTask: recommended.id };
    data.lastUpdated = new Date().toISOString();
    data._meta.checksum = computeChecksum(data.tasks);
    await saveJson(todoPath, data, { backupDir: getBackupDir(opts.cwd) });
    autoFocused = true;
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
    ...(autoFocused && { autoFocused }),
  };
}
