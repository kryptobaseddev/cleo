/**
 * Task import, export, history, lint, and batch-validate operations.
 * @task T10064
 * @epic T9834
 */

import type { Task } from '@cleocode/contracts';
import { TASK_STATUSES } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';

/** Task record shape expected from the data layer. */
type TaskRecord = Task;

async function loadAllTasks(projectRoot: string): Promise<TaskRecord[]> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  return tasks;
}

// Re-export from task-data.ts so the task-ops barrel can proxy through here
export {
  coreTaskDepends,
  coreTaskDeps,
  coreTaskDepsCycles,
  coreTaskDepsOverview,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskRelatesAddBatch,
  coreTaskRelatesRemove,
  coreTaskStats,
} from './task-data.js';

/**
 * Export tasks as JSON or CSV.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Optional export configuration
 * @param params.format - Output format: "json" (default) or "csv"
 * @param params.status - Filter to only tasks with this status
 * @param params.parent - Filter to tasks under this parent ID (recursive)
 * @returns Export payload with format, content/tasks, and task count
 *
 * @remarks
 * CSV output includes columns: id, title, status, priority, type, parentId, createdAt.
 * JSON output returns the full task objects. Both formats support status and parent filtering.
 *
 * @example
 * ```typescript
 * const result = await coreTaskExport('/project', { format: 'csv', status: 'done' });
 * console.log(result.content); // CSV string
 * ```
 *
 * @task T4790
 */
export async function coreTaskExport(
  projectRoot: string,
  params?: { format?: 'json' | 'csv'; status?: string; parent?: string },
): Promise<unknown> {
  const allTasks = await loadAllTasks(projectRoot);

  let tasks = allTasks;

  if (params?.status) {
    tasks = tasks.filter((t) => t.status === params.status);
  }

  if (params?.parent) {
    const parentIds = new Set<string>();
    parentIds.add(params.parent);
    const collectChildren = (parentId: string) => {
      for (const t of allTasks) {
        if (t.parentId === parentId && !parentIds.has(t.id)) {
          parentIds.add(t.id);
          collectChildren(t.id);
        }
      }
    };
    collectChildren(params.parent);
    tasks = tasks.filter((t) => parentIds.has(t.id));
  }

  if (params?.format === 'csv') {
    const headers = ['id', 'title', 'status', 'priority', 'type', 'parentId', 'createdAt'];
    const rows = tasks.map((t) =>
      [
        t.id,
        `"${(t.title || '').replace(/"/g, '""')}"`,
        t.status,
        t.priority,
        t.type ?? 'task',
        t.parentId ?? '',
        t.createdAt,
      ].join(','),
    );
    const csv = [headers.join(','), ...rows].join('\n');
    return { format: 'csv', content: csv, taskCount: tasks.length };
  }

  return { format: 'json', tasks, taskCount: tasks.length };
}

/**
 * Get task history from the audit log.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to retrieve history for
 * @param limit - Maximum number of history entries to return (default: 100)
 * @returns Array of audit log entries ordered by timestamp descending
 *
 * @remarks
 * Queries the SQLite audit_log table for all operations on the given task.
 * Returns an empty array if the database is unavailable or no entries exist.
 *
 * @example
 * ```typescript
 * const history = await coreTaskHistory('/project', 'T042', 10);
 * for (const entry of history) console.log(entry.timestamp, entry.operation);
 * ```
 *
 * @task T4790
 */
export async function coreTaskHistory(
  projectRoot: string,
  taskId: string,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  try {
    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const { sql } = await import('drizzle-orm');

    const db = await getDb(projectRoot);
    const maxRows = limit && limit > 0 ? limit : 100;

    const rows = await db.all<{
      id: string;
      timestamp: string;
      action: string;
      task_id: string;
      actor: string;
      details_json: string | null;
      before_json: string | null;
      after_json: string | null;
      domain: string | null;
      operation: string | null;
      session_id: string | null;
      request_id: string | null;
      duration_ms: number | null;
      success: number | null;
      source: string | null;
      gateway: string | null;
      error_message: string | null;
    }>(
      sql`SELECT * FROM ${auditLog}
          WHERE ${auditLog.taskId} = ${taskId}
          ORDER BY ${auditLog.timestamp} DESC
          LIMIT ${maxRows}`,
    );

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      operation: row.operation ?? row.action,
      action: row.action,
      taskId: row.task_id,
      actor: row.actor,
      details: row.details_json ? JSON.parse(row.details_json) : {},
      before: row.before_json ? JSON.parse(row.before_json) : undefined,
      after: row.after_json ? JSON.parse(row.after_json) : undefined,
      domain: row.domain,
      sessionId: row.session_id,
      requestId: row.request_id,
      durationMs: row.duration_ms,
      success: row.success === null ? undefined : row.success === 1,
      source: row.source,
      gateway: row.gateway,
      error: row.error_message,
    }));
  } catch {
    return [];
  }
}

/**
 * Lint tasks for common issues.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - Optional task ID to lint; omit to lint all tasks
 * @returns Array of lint issues with severity, rule name, and descriptive message
 *
 * @remarks
 * Checks for: duplicate IDs, missing titles, missing descriptions, identical
 * title/description, duplicate descriptions, invalid statuses, future timestamps,
 * invalid parent references, and invalid dependency references.
 *
 * @example
 * ```typescript
 * const issues = await coreTaskLint('/project');
 * const errors = issues.filter(i => i.severity === 'error');
 * console.log(`${errors.length} errors found`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskLint(
  projectRoot: string,
  taskId?: string,
): Promise<
  Array<{
    taskId: string;
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }>
> {
  const allTasks = await loadAllTasks(projectRoot);

  const tasks = taskId ? allTasks.filter((t) => t.id === taskId) : allTasks;

  if (taskId && tasks.length === 0) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const issues: Array<{
    taskId: string;
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }> = [];

  const allDescriptions = new Set<string>();
  const allIds = new Set<string>();

  for (const task of allTasks) {
    if (allIds.has(task.id)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'unique-id',
        message: `Duplicate task ID: ${task.id}`,
      });
    }
    allIds.add(task.id);

    if (taskId && task.id !== taskId) {
      if (task.description) allDescriptions.add(task.description.toLowerCase());
      continue;
    }

    if (!task.title || task.title.trim().length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'title-required',
        message: 'Task is missing a title',
      });
    }

    if (!task.description || task.description.trim().length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'description-required',
        message: 'Task is missing a description',
      });
    }

    if (task.title && task.description && task.title.trim() === task.description.trim()) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'title-description-different',
        message: 'Title and description should not be identical',
      });
    }

    if (task.description) {
      const descLower = task.description.toLowerCase();
      if (allDescriptions.has(descLower)) {
        issues.push({
          taskId: task.id,
          severity: 'warning',
          rule: 'unique-description',
          message: 'Duplicate task description found',
        });
      }
      allDescriptions.add(descLower);
    }

    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'valid-status',
        message: `Invalid status: ${task.status}`,
      });
    }

    const now = new Date();
    if (task.createdAt && new Date(task.createdAt) > now) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'no-future-timestamps',
        message: 'createdAt is in the future',
      });
    }

    if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'valid-parent',
        message: `Parent task '${task.parentId}' does not exist`,
      });
    }

    for (const depId of task.depends ?? []) {
      if (!allTasks.some((t) => t.id === depId)) {
        issues.push({
          taskId: task.id,
          severity: 'warning',
          rule: 'valid-dependency',
          message: `Dependency '${depId}' does not exist`,
        });
      }
    }
  }

  return issues;
}

/**
 * Validate multiple tasks at once.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskIds - Array of task IDs to validate
 * @param checkMode - Validation depth: "full" runs all checks, "quick" checks only title/description/status
 * @returns Per-task validation results and an aggregate summary with error/warning counts
 *
 * @remarks
 * In "full" mode, additional checks include title-description equality, parent existence,
 * dependency existence, and future timestamp detection. Tasks that are not found are
 * reported as errors.
 *
 * @example
 * ```typescript
 * const { summary } = await coreTaskBatchValidate('/project', ['T001', 'T002'], 'full');
 * console.log(`${summary.validTasks}/${summary.totalTasks} valid`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskBatchValidate(
  projectRoot: string,
  taskIds: string[],
  checkMode: 'full' | 'quick' = 'full',
): Promise<{
  results: Record<string, Array<{ severity: 'error' | 'warning'; rule: string; message: string }>>;
  summary: {
    totalTasks: number;
    validTasks: number;
    invalidTasks: number;
    totalIssues: number;
    errors: number;
    warnings: number;
  };
}> {
  const allTasks = await loadAllTasks(projectRoot);

  const results: Record<
    string,
    Array<{ severity: 'error' | 'warning'; rule: string; message: string }>
  > = {};

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const id of taskIds) {
    const task = allTasks.find((t) => t.id === id);
    if (!task) {
      results[id] = [{ severity: 'error', rule: 'exists', message: `Task '${id}' not found` }];
      totalErrors++;
      continue;
    }

    const taskIssues: Array<{ severity: 'error' | 'warning'; rule: string; message: string }> = [];

    if (!task.title || task.title.trim().length === 0) {
      taskIssues.push({ severity: 'error', rule: 'title-required', message: 'Missing title' });
    }
    if (!task.description || task.description.trim().length === 0) {
      taskIssues.push({
        severity: 'warning',
        rule: 'description-required',
        message: 'Missing description',
      });
    }

    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) {
      taskIssues.push({
        severity: 'error',
        rule: 'valid-status',
        message: `Invalid status: ${task.status}`,
      });
    }

    if (checkMode === 'full') {
      if (task.title && task.description && task.title.trim() === task.description.trim()) {
        taskIssues.push({
          severity: 'warning',
          rule: 'title-description-different',
          message: 'Title equals description',
        });
      }

      if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
        taskIssues.push({
          severity: 'error',
          rule: 'valid-parent',
          message: `Parent '${task.parentId}' not found`,
        });
      }

      for (const depId of task.depends ?? []) {
        if (!allTasks.some((t) => t.id === depId)) {
          taskIssues.push({
            severity: 'warning',
            rule: 'valid-dependency',
            message: `Dependency '${depId}' not found`,
          });
        }
      }

      const now = new Date();
      if (task.createdAt && new Date(task.createdAt) > now) {
        taskIssues.push({
          severity: 'warning',
          rule: 'no-future-timestamps',
          message: 'createdAt in future',
        });
      }
    }

    results[id] = taskIssues;
    totalErrors += taskIssues.filter((i) => i.severity === 'error').length;
    totalWarnings += taskIssues.filter((i) => i.severity === 'warning').length;
  }

  const invalidTasks = Object.values(results).filter((issues) =>
    issues.some((i) => i.severity === 'error'),
  ).length;

  return {
    results,
    summary: {
      totalTasks: taskIds.length,
      validTasks: taskIds.length - invalidTasks,
      invalidTasks,
      totalIssues: totalErrors + totalWarnings,
      errors: totalErrors,
      warnings: totalWarnings,
    },
  };
}

/**
 * Import tasks from a JSON source string.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param source - JSON string containing an array of tasks or an object with a `tasks` array
 * @param overwrite - When true, overwrites existing tasks with matching IDs; otherwise skips them
 * @returns Import summary with counts of imported, skipped, errors, and optional ID remap table
 *
 * @remarks
 * When a task ID collides with an existing one and overwrite is false, a new sequential
 * ID is assigned and recorded in the remapTable. Tasks missing required id or title
 * fields are skipped with an error message.
 *
 * @example
 * ```typescript
 * const json = JSON.stringify([{ id: 'T500', title: 'New task', status: 'pending', priority: 'medium' }]);
 * const result = await coreTaskImport('/project', json, false);
 * console.log(`Imported ${result.imported}, skipped ${result.skipped}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskImport(
  projectRoot: string,
  source: string,
  overwrite?: boolean,
): Promise<{
  imported: number;
  skipped: number;
  errors: string[];
  remapTable?: Record<string, string>;
}> {
  const accessor = await getTaskAccessor(projectRoot);

  // Load all existing task IDs using queryTasks (bulk operation needs full ID set)
  const { tasks: existingTasks } = await accessor.queryTasks({});

  let importData: unknown;
  try {
    importData = JSON.parse(source);
  } catch {
    throw new Error('Invalid JSON in import source');
  }

  let importTasks: TaskRecord[] = [];
  if (Array.isArray(importData)) {
    importTasks = importData;
  } else if (typeof importData === 'object' && importData !== null) {
    const data = importData as Record<string, unknown>;
    if (Array.isArray(data.tasks)) {
      importTasks = data.tasks;
    }
  }

  if (importTasks.length === 0) {
    return { imported: 0, skipped: 0, errors: ['No tasks found in import source'] };
  }

  const existingIds = new Set(existingTasks.map((t) => t.id));
  const allIds = new Set(existingTasks.map((t) => t.id));
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;
  const remapTable: Record<string, string> = {};

  let nextIdNum = 0;
  for (const t of existingTasks) {
    const num = parseInt(t.id.replace('T', ''), 10);
    if (!Number.isNaN(num) && num > nextIdNum) nextIdNum = num;
  }

  for (const importTask of importTasks) {
    if (!importTask.id || !importTask.title) {
      errors.push(`Skipped task with missing id or title`);
      skipped++;
      continue;
    }

    if (existingIds.has(importTask.id) && !overwrite) {
      skipped++;
      continue;
    }

    let newId = importTask.id;
    if (allIds.has(importTask.id) && !overwrite) {
      nextIdNum++;
      newId = `T${String(nextIdNum).padStart(3, '0')}`;
      remapTable[importTask.id] = newId;
    }

    const now = new Date().toISOString();
    const newTask: TaskRecord = {
      ...importTask,
      id: newId,
      createdAt: importTask.createdAt || now,
      updatedAt: now,
    };

    // Use targeted upsert per task instead of bulk saveTaskFile
    await accessor.upsertSingleTask(newTask);

    allIds.add(newId);
    imported++;
  }

  return {
    imported,
    skipped,
    errors,
    ...(Object.keys(remapTable).length > 0 ? { remapTable } : {}),
  };
}
