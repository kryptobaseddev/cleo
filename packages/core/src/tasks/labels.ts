/**
 * Label management core module.
 * @task T4538
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

interface LabelInfo {
  label: string;
  count: number;
  statuses: Record<string, number>;
}

/** List all labels with task counts. */
export async function listLabels(cwd?: string, accessor?: DataAccessor): Promise<LabelInfo[]> {
  const acc = accessor ?? (await getAccessor(cwd));
  const { tasks } = await acc.queryTasks({});
  const labelMap: Record<string, LabelInfo> = {};

  for (const task of tasks) {
    for (const label of task.labels ?? []) {
      if (!labelMap[label]) {
        labelMap[label] = { label, count: 0, statuses: {} };
      }
      const info = labelMap[label]!;
      info.count++;
      info.statuses[task.status] = (info.statuses[task.status] ?? 0) + 1;
    }
  }

  return Object.values(labelMap).sort((a, b) => b.count - a.count);
}

/** Show tasks with a specific label. */
export async function showLabelTasks(
  label: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getAccessor(cwd));
  const { tasks } = await acc.queryTasks({ label });

  if (tasks.length === 0) {
    throw new CleoError(ExitCode.NOT_FOUND, `No tasks found with label '${label}'`);
  }

  return {
    label,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })),
    count: tasks.length,
  };
}

/** Get detailed label statistics. */
export async function getLabelStats(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const labels = await listLabels(cwd, accessor);
  const totalLabels = labels.length;
  const totalUsages = labels.reduce((sum, l) => sum + l.count, 0);
  const avgPerLabel = totalLabels > 0 ? Math.round((totalUsages / totalLabels) * 100) / 100 : 0;

  return {
    labels,
    totalLabels,
    totalUsages,
    avgPerLabel,
  };
}
