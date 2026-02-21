/**
 * Labels aggregation core module.
 * @task T4783
 */

import { readJson } from '../../store/json.js';
import { getTodoPath } from '../paths.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TodoFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

export interface LabelsResult {
  labels: Array<{ label: string; count: number; tasks: string[] }>;
  totalLabels: number;
  totalTagged: number;
  totalUntagged: number;
}

/** Get all labels with counts and task IDs per label. */
export async function getLabels(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<LabelsResult> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJson<TodoFile>(getTodoPath(cwd));
  if (!data) {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'No todo.json found');
  }

  const tasks = data.tasks ?? [];
  const labelMap: Record<string, string[]> = {};
  let taggedCount = 0;

  for (const t of tasks) {
    const taskLabels = t.labels ?? [];
    if (taskLabels.length > 0) taggedCount++;
    for (const label of taskLabels) {
      if (!labelMap[label]) labelMap[label] = [];
      labelMap[label]!.push(t.id);
    }
  }

  const labels = Object.entries(labelMap)
    .map(([label, taskIds]) => ({ label, count: taskIds.length, tasks: taskIds }))
    .sort((a, b) => b.count - a.count);

  return {
    labels,
    totalLabels: labels.length,
    totalTagged: taggedCount,
    totalUntagged: tasks.length - taggedCount,
  };
}
