/**
 * Task analysis and complexity estimation.
 * @task T10064
 * @epic T9834
 */

import type { Task, TaskAnalysisResult } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';
import { computeLeverage } from '../task-tools/score-task-priority.js';
import { rankForAnalysis } from './analyze.js';

/** Task record shape expected from the data layer. */
type TaskRecord = Task;

/** Complexity factor contributing to a task's size estimate. */
export interface ComplexityFactor {
  /** Factor name (e.g. "descriptionLength", "dependencyDepth"). */
  name: string;
  /** Numeric score contribution from this factor. */
  value: number;
  /** Human-readable explanation of the score (e.g. "short (42 chars)"). */
  detail: string;
}

async function loadAllTasks(projectRoot: string): Promise<TaskRecord[]> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  return tasks;
}

/**
 * Walk dependency chain to measure maximum depth.
 *
 * @param taskId  - Starting task ID.
 * @param taskMap - Flat lookup map.
 * @param visited - Tracks visited nodes to avoid cycles.
 */
export function measureDependencyDepth(
  taskId: string,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set(),
): number {
  if (visited.has(taskId)) return 0;
  visited.add(taskId);

  const task = taskMap.get(taskId);
  if (!task?.depends || task.depends.length === 0) return 0;

  let maxDepth = 0;
  for (const depId of task.depends) {
    const depth = 1 + measureDependencyDepth(depId, taskMap, visited);
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

/**
 * Analyze tasks for priority and leverage.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - Optional task or epic ID to scope the analysis; omit for project-wide
 * @param params - Optional analysis configuration
 * @param params.tierLimit - Maximum tasks per priority tier in the response (default: 10)
 * @returns Analysis with recommended next task, bottlenecks, priority tiers, and aggregate metrics
 *
 * @remarks
 * Computes a leverage score per task (how many other tasks it unblocks) and combines
 * it with priority to produce a ranked recommendation. Bottlenecks are the top 5
 * incomplete tasks that block the most others.
 *
 * @example
 * ```typescript
 * const analysis = await coreTaskAnalyze('/project', undefined, { tierLimit: 5 });
 * if (analysis.recommended) console.log('Work on:', analysis.recommended.id);
 * ```
 *
 * @task T4790
 */
export async function coreTaskAnalyze(
  projectRoot: string,
  taskId?: string,
  params?: { tierLimit?: number },
): Promise<TaskAnalysisResult & { tierLimit: number }> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks: allTasks } = await accessor.queryTasks({});
  const effectiveTierLimit = params?.tierLimit ?? 10;

  const tasks = taskId
    ? allTasks.filter((t) => t.id === taskId || t.parentId === taskId)
    : allTasks;

  // Open tasks each task unblocks — the same leverage the shared scorer uses (T12661).
  const openDependents = computeLeverage(tasks);

  const blocked = tasks.filter((t) => t.status === 'blocked');

  const bottlenecks = tasks
    .filter((t) => (openDependents.get(t.id) ?? 0) > 0 && t.status !== 'done')
    .map((t) => ({ id: t.id, title: t.title, blocksCount: openDependents.get(t.id) ?? 0 }))
    .sort((a, b) => b.blocksCount - a.blocksCount || a.id.localeCompare(b.id))
    .slice(0, 5);

  // T12661: the same ranking as `cleo next` and the briefing (ready candidates,
  // current phase, BRAIN patterns, shared scorer), scoped to `taskId` when given.
  const { ranked: scored } = await rankForAnalysis(accessor, allTasks, {
    projectRoot,
    ...(taskId ? { scopeTaskIds: new Set(tasks.map((t) => t.id)) } : {}),
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
          reason: 'Top of the shared task ranking — the same order as `cleo next`',
        }
      : null;

  const totalLeverage = [...openDependents.values()].reduce((s, v) => s + v, 0);
  const avgLeverage = tasks.length > 0 ? Math.round((totalLeverage / tasks.length) * 100) / 100 : 0;

  return {
    recommended,
    bottlenecks,
    tiers: {
      critical: critical
        .slice(0, effectiveTierLimit)
        .map(({ id, title, leverage }) => ({ id, title, leverage })),
      high: high
        .slice(0, effectiveTierLimit)
        .map(({ id, title, leverage }) => ({ id, title, leverage })),
      normal: normal
        .slice(0, effectiveTierLimit)
        .map(({ id, title, leverage }) => ({ id, title, leverage })),
    },
    metrics: {
      totalTasks: tasks.length,
      actionable: actionable.length,
      blocked: blocked.length,
      avgLeverage,
    },
    tierLimit: effectiveTierLimit,
  };
}

/**
 * Deterministic complexity scoring from task metadata.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Parameters containing the task ID to estimate
 * @param params.taskId - The task ID to compute complexity for
 * @returns Complexity size ("small"/"medium"/"large"), numeric score, contributing factors, and metadata counts
 *
 * @remarks
 * Scores are computed from description length, acceptance criteria count, dependency depth,
 * subtask count, and file reference count. Each factor contributes 0-3 points.
 * Total score 0-3 = small, 4-7 = medium, 8+ = large.
 *
 * @example
 * ```typescript
 * const est = await coreTaskComplexityEstimate('/project', { taskId: 'T042' });
 * console.log(`${est.size} (score: ${est.score})`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskComplexityEstimate(
  projectRoot: string,
  params: { taskId: string },
): Promise<{
  size: 'small' | 'medium' | 'large';
  score: number;
  factors: ComplexityFactor[];
  dependencyDepth: number;
  subtaskCount: number;
  fileCount: number;
}> {
  const allTasks = await loadAllTasks(projectRoot);

  const task = allTasks.find((t) => t.id === params.taskId);
  if (!task) {
    throw new Error(`Task '${params.taskId}' not found`);
  }

  const factors: ComplexityFactor[] = [];
  let score = 0;

  const descLen = (task.description || '').length;
  let descScore: number;
  let descLabel: string;
  if (descLen < 100) {
    descScore = 1;
    descLabel = 'short';
  } else if (descLen < 500) {
    descScore = 2;
    descLabel = 'medium';
  } else {
    descScore = 3;
    descLabel = 'long';
  }
  score += descScore;
  factors.push({
    name: 'descriptionLength',
    value: descScore,
    detail: `${descLabel} (${descLen} chars)`,
  });

  const acceptanceCount = task.acceptance?.length ?? 0;
  const acceptanceScore = Math.min(acceptanceCount, 3);
  score += acceptanceScore;
  factors.push({
    name: 'acceptanceCriteria',
    value: acceptanceScore,
    detail: `${acceptanceCount} criteria`,
  });

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const dependencyDepth = measureDependencyDepth(params.taskId, taskMap);
  const depthScore = Math.min(dependencyDepth, 3);
  score += depthScore;
  factors.push({ name: 'dependencyDepth', value: depthScore, detail: `depth ${dependencyDepth}` });

  const subtaskCount = allTasks.filter((t) => t.parentId === params.taskId).length;
  const subtaskScore = Math.min(subtaskCount, 3);
  score += subtaskScore;
  factors.push({ name: 'subtaskCount', value: subtaskScore, detail: `${subtaskCount} subtasks` });

  const fileCount = task.files?.length ?? 0;
  const fileScore = Math.min(fileCount, 3);
  score += fileScore;
  factors.push({ name: 'fileReferences', value: fileScore, detail: `${fileCount} files` });

  let size: 'small' | 'medium' | 'large';
  if (score <= 3) size = 'small';
  else if (score <= 7) size = 'medium';
  else size = 'large';

  return { size, score, factors, dependencyDepth, subtaskCount, fileCount };
}
