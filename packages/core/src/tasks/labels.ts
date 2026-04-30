/**
 * Label management core module.
 * @task T4538
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
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
    throw new CleoError(ExitCode.NOT_FOUND, `No tasks found with label '${label}'`, {
      fix: 'cleo labels list to see available labels',
      details: { field: 'label', actual: label },
    });
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

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1568 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * List all labels used in tasks, wrapped in EngineResult.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with labels array and count
 *
 * @task T1568
 * @epic T1566
 */
export async function taskLabelList(
  projectRoot: string,
): Promise<EngineResult<{ labels: unknown[]; count: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const labels = await listLabels(projectRoot, accessor);
    return engineSuccess({ labels, count: labels.length });
  } catch (err: unknown) {
    const e = err as { message?: string };
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: e?.message ?? 'Task database not initialized' },
    };
  }
}

/**
 * Show tasks associated with a label, wrapped in EngineResult.
 *
 * @param projectRoot - Absolute path to the project root
 * @param label - Label to look up
 * @returns EngineResult with tasks for this label
 *
 * @task T1568
 * @epic T1566
 */
export async function taskLabelShow(
  projectRoot: string,
  label: string,
): Promise<EngineResult<Record<string, unknown>>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await showLabelTasks(label, projectRoot, accessor);
    return engineSuccess(result);
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number };
    const code = e?.code === 4 ? 'E_NOT_FOUND' : 'E_INTERNAL';
    return { success: false, error: { code, message: e?.message ?? 'Failed to list labels' } };
  }
}
