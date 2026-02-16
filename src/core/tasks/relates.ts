/**
 * Task relationship management core module.
 * @task T4538
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { getTodoPath, getBackupDir } from '../paths.js';
import type { TodoFile } from '../../types/task.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

interface Relation {
  targetId: string;
  type: string;
  reason: string;
  addedAt: string;
}

/** Suggest related tasks based on shared attributes. */
export async function suggestRelated(
  taskId: string,
  opts: { threshold?: number; cwd?: string },
): Promise<Record<string, unknown>> {
  const data = await readJsonRequired<TodoFile>(getTodoPath(opts.cwd));
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
): Promise<Record<string, unknown>> {
  const todoPath = getTodoPath(cwd);
  const data = await readJsonRequired<TodoFile>(todoPath);

  const fromTask = data.tasks.find(t => t.id === from);
  if (!fromTask) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${from} not found`);
  }

  const toTask = data.tasks.find(t => t.id === to);
  if (!toTask) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${to} not found`);
  }

  // The 'relates' field is an extension not in the base Task type
  const taskAny = fromTask as unknown as Record<string, unknown>;
  if (!taskAny.relates) {
    taskAny.relates = [];
  }

  const relates = taskAny.relates as Relation[];
  relates.push({
    targetId: to,
    type,
    reason,
    addedAt: new Date().toISOString(),
  });

  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);
  await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });

  return { from, to, type, reason, added: true };
}

/** Discover related tasks using various methods. */
export async function discoverRelated(
  taskId: string,
  cwd?: string,
): Promise<Record<string, unknown>> {
  return suggestRelated(taskId, { threshold: 30, cwd });
}

/** List existing relations for a task. */
export async function listRelations(
  taskId: string,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const data = await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
  }

  const taskAny = task as unknown as Record<string, unknown>;
  const relates = (taskAny.relates as Relation[]) ?? [];
  return {
    taskId,
    relations: relates,
    count: relates.length,
  };
}
