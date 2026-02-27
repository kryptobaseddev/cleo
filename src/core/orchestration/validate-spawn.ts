/**
 * Spawn readiness validation.
 * @task T4784
 */

import { readJson } from '../../store/json.js';
import { getTaskPath } from '../paths.js';
import type { TaskFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

export interface ValidationIssue {
  code: string;
  message: string;
  severity: string;
}

export interface SpawnValidationResult {
  taskId: string;
  title: string;
  ready: boolean;
  issues: ValidationIssue[];
}

/** Validate spawn readiness for a task. */
export async function validateSpawnReadiness(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<SpawnValidationResult> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJson<TaskFile>(getTaskPath(cwd));

  const tasks = data?.tasks ?? [];
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    return {
      taskId,
      title: '',
      ready: false,
      issues: [{ code: 'V_NOT_FOUND', message: `Task ${taskId} not found`, severity: 'error' }],
    };
  }

  const issues: ValidationIssue[] = [];

  if (task.status === 'done') {
    issues.push({ code: 'V_ALREADY_DONE', message: 'Task is already completed', severity: 'error' });
  }
  if (task.status === 'cancelled') {
    issues.push({ code: 'V_CANCELLED', message: 'Task is cancelled', severity: 'error' });
  }

  if (task.depends) {
    for (const dep of task.depends) {
      const depTask = tasks.find(t => t.id === dep);
      if (!depTask) {
        issues.push({ code: 'V_MISSING_DEP', message: `Dependency ${dep} not found`, severity: 'error' });
      } else if (depTask.status !== 'done') {
        issues.push({
          code: 'V_UNMET_DEP',
          message: `Dependency ${dep} (${depTask.title}) is not complete (status: ${depTask.status})`,
          severity: 'error',
        });
      }
    }
  }

  if (!task.title) {
    issues.push({ code: 'V_MISSING_TITLE', message: 'Task title is missing', severity: 'error' });
  }
  if (!task.description) {
    issues.push({ code: 'V_MISSING_DESC', message: 'Task description is missing', severity: 'error' });
  }

  return {
    taskId,
    title: task.title,
    ready: issues.filter(i => i.severity === 'error').length === 0,
    issues,
  };
}
