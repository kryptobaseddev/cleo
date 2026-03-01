/**
 * Task relationship management core module.
 * @task T4538
 * @epic T4454
 */

import { readJsonRequired } from '../../store/json.js';
import { getTaskPath } from '../paths.js';
import type { TaskFile } from '../../types/task.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Suggest related tasks based on shared attributes. */
export async function suggestRelated(
  taskId: string,
  opts: { threshold?: number; cwd?: string },
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(opts.cwd));
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
  }

  const suggestions: Array<{ id: string; title: string; score: number; reason: string }> = [];

  for (const other of data.tasks) {
    if (other.id === taskId) continue;
    let score = 0;
    const reasons: string[] = [];

    // Shared labels
    const sharedLabels = (task.labels ?? []).filter(l => (other.labels ?? []).includes(l));
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
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));

  const fromTask = data.tasks.find(t => t.id === from);
  if (!fromTask) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${from} not found`);
  }

  const toTask = data.tasks.find(t => t.id === to);
  if (!toTask) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${to} not found`);
  }

  // Persist to task_relations table via accessor (T5168 fix)
  if (accessor?.addRelation) {
    await accessor.addRelation(from, to, type, reason);
  } else {
    // Fallback: use task-store direct write for non-accessor path
    const { addRelation: storeAddRelation } = await import('../../store/task-store.js');
    await storeAddRelation(from, to, type as 'related', cwd, reason);
  }

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
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
  }

  // task.relates is populated from task_relations table by loadRelationsForTasks
  const relates = task.relates ?? [];
  return {
    taskId,
    relations: relates,
    count: relates.length,
  };
}
