/**
 * Task relationship management core module.
 * @task T4538
 * @epic T4454
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { ExitCode } from '@cleocode/contracts';
import type { TaskRef } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Suggest related tasks based on shared attributes. */
export async function suggestRelated(
  taskId: string,
  opts: { threshold?: number; cwd?: string },
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getAccessor(opts.cwd));
  const { tasks: allTasks } = await acc.queryTasks({});
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
  }

  const suggestions: Array<Pick<TaskRef, 'id' | 'title'> & { score: number; reason: string }> = [];

  for (const other of allTasks) {
    if (other.id === taskId) continue;
    let score = 0;
    const reasons: string[] = [];

    // Shared labels
    const sharedLabels = (task.labels ?? []).filter((l) => (other.labels ?? []).includes(l));
    if (sharedLabels.length > 0) {
      score += sharedLabels.length * 20;
      reasons.push(`Shared labels: ${sharedLabels.join(', ')}`);
    }

    // Same phase
    if (task.phase && task.phase === other.phase) {
      score += 15;
      reasons.push(`Same phase: ${task.phase}`);
    }

    // Same parent
    if (task.parentId && task.parentId === other.parentId) {
      score += 25;
      reasons.push('Same parent');
    }

    const threshold = opts.threshold ?? 50;
    if (score >= threshold) {
      suggestions.push({
        id: other.id,
        title: other.title,
        score: Math.min(score, 100),
        reason: reasons.join('; '),
      });
    }
  }

  return {
    taskId,
    suggestions: suggestions.sort((a, b) => b.score - a.score).slice(0, 10),
    count: suggestions.length,
  };
}

/** Add a relation between tasks. */
export async function addRelation(
  from: string,
  to: string,
  type: string,
  reason: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getAccessor(cwd));

  const fromExists = await acc.taskExists(from);
  if (!fromExists) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${from} not found`);
  }

  const toExists = await acc.taskExists(to);
  if (!toExists) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${to} not found`);
  }

  // Persist to task_relations table via accessor (T5168 fix)
  await acc.addRelation(from, to, type, reason);

  return { from, to, type, reason, added: true };
}

/** Discover related tasks using various methods. */
export async function discoverRelated(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  return suggestRelated(taskId, { threshold: 30, cwd }, accessor);
}

/** List existing relations for a task. */
export async function listRelations(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getAccessor(cwd));
  const task = await acc.loadSingleTask(taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
  }

  // task.relates is populated from task_relations table by loadSingleTask
  const relates = task.relates ?? [];
  return {
    taskId,
    relations: relates,
    count: relates.length,
  };
}
