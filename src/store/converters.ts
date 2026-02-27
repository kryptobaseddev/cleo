/**
 * Shared row <-> domain conversion functions for SQLite store modules.
 *
 * Eliminates duplication across sqlite-data-accessor.ts, task-store.ts,
 * and session-store.ts.
 */

import { safeParseJson, safeParseJsonArray } from './parsers.js';
import type { TaskRow, NewTaskRow, SessionRow } from './schema.js';
import type { Task, TaskStatus, TaskPriority, TaskType, TaskSize } from '../types/task.js';
import type { Session, SessionScope, SessionStats } from './validation-schemas.js';
import type { SessionStatus } from './status-registry.js';

/** Convert a database TaskRow to a domain Task object. */
export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    type: (row.type as TaskType) ?? undefined,
    parentId: row.parentId ?? undefined,
    phase: row.phase ?? undefined,
    size: (row.size as TaskSize) ?? undefined,
    position: row.position ?? undefined,
    positionVersion: row.positionVersion ?? undefined,
    description: row.description ?? undefined,
    labels: safeParseJsonArray(row.labelsJson),
    notes: safeParseJsonArray(row.notesJson),
    acceptance: safeParseJsonArray(row.acceptanceJson),
    files: safeParseJsonArray(row.filesJson),
    depends: undefined, // Populated separately from task_dependencies
    origin: (row.origin as Task['origin']) ?? undefined,
    blockedBy: row.blockedBy ?? undefined,
    epicLifecycle: (row.epicLifecycle as Task['epicLifecycle']) ?? undefined,
    noAutoComplete: row.noAutoComplete ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    cancelledAt: row.cancelledAt ?? undefined,
    cancellationReason: row.cancellationReason ?? undefined,
    verification: row.verificationJson ? safeParseJson(row.verificationJson) : undefined,
    provenance:
      row.createdBy || row.modifiedBy || row.sessionId
        ? {
            createdBy: row.createdBy ?? null,
            modifiedBy: row.modifiedBy ?? null,
            sessionId: row.sessionId ?? null,
          }
        : undefined,
  };
}

/** Convert a domain Task to a database row for insert/upsert. */
export function taskToRow(task: Partial<Task> & { id: string }): NewTaskRow {
  return {
    id: task.id,
    title: task.title ?? '',
    description: task.description ?? null,
    status: task.status ?? 'pending',
    priority: task.priority ?? 'medium',
    type: task.type ?? null,
    parentId: task.parentId ?? null,
    phase: task.phase ?? null,
    size: task.size ?? null,
    position: task.position ?? null,
    positionVersion: task.positionVersion ?? 0,
    labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
    notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
    acceptanceJson: task.acceptance ? JSON.stringify(task.acceptance) : '[]',
    filesJson: task.files ? JSON.stringify(task.files) : '[]',
    origin: task.origin ?? null,
    blockedBy: task.blockedBy ?? null,
    epicLifecycle: task.epicLifecycle ?? null,
    noAutoComplete: task.noAutoComplete ?? null,
    createdAt: task.createdAt ?? new Date().toISOString(),
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    cancelledAt: task.cancelledAt ?? null,
    cancellationReason: task.cancellationReason ?? null,
    verificationJson: task.verification ? JSON.stringify(task.verification) : null,
    createdBy: task.provenance?.createdBy ?? null,
    modifiedBy: task.provenance?.modifiedBy ?? null,
    sessionId: task.provenance?.sessionId ?? null,
  };
}

/** Convert a domain Task to a row suitable for archived tasks. */
export function archivedTaskToRow(task: Task): NewTaskRow {
  const row = taskToRow(task);
  row.status = 'archived';
  if (!(row as Record<string, unknown>)['archivedAt']) {
    (row as Record<string, unknown>)['archivedAt'] = task.completedAt ?? new Date().toISOString();
  }
  return row;
}

/** Convert a SessionRow to a domain Session. */
export function rowToSession(row: SessionRow): Session {
  const taskWork = {
    taskId: row.currentTask ?? null,
    setAt: row.taskStartedAt ?? null,
  };
  return {
    id: row.id,
    name: row.name,
    status: row.status as SessionStatus,
    scope: (safeParseJson<SessionScope>(row.scopeJson) ?? { type: 'global' }) as SessionScope,
    taskWork,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    agent: row.agent ?? undefined,
    notes: safeParseJsonArray(row.notesJson),
    tasksCompleted: safeParseJsonArray(row.tasksCompletedJson),
    tasksCreated: safeParseJsonArray(row.tasksCreatedJson),
    handoffJson: row.handoffJson ?? null,
    // Session chain fields (T4959)
    previousSessionId: row.previousSessionId ?? null,
    nextSessionId: row.nextSessionId ?? null,
    agentIdentifier: row.agentIdentifier ?? null,
    handoffConsumedAt: row.handoffConsumedAt ?? null,
    handoffConsumedBy: row.handoffConsumedBy ?? null,
    debriefJson: row.debriefJson ?? null,
    // Session stats fields
    stats: row.statsJson ? safeParseJson<SessionStats>(row.statsJson) : undefined,
    resumeCount: row.resumeCount ?? undefined,
    gradeMode: row.gradeMode ? Boolean(row.gradeMode) : undefined,
  };
}
