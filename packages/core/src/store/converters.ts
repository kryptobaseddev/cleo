/**
 * Shared row <-> domain conversion functions for SQLite store modules.
 *
 * Eliminates duplication across sqlite-data-accessor.ts, tasks-sqlite.ts,
 * and session-store.ts.
 */

import type {
  Session,
  SessionScope,
  SessionStats,
  Task,
  TaskPriority,
  TaskRole,
  TaskScope,
  TaskSeverity,
  TaskSize,
  TaskStatus,
  TaskType,
} from '@cleocode/contracts';
import { safeParseJson, safeParseJsonArray } from './parsers.js';
import type { SessionStatus } from './status-registry.js';
import type { NewTaskRow, SessionRow, TaskRow } from './tasks-schema.js';

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
    description: row.description ?? '',
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
    pipelineStage: row.pipelineStage ?? undefined,
    assignee: row.assignee ?? undefined,
    // T944: orthogonal axes — role (intent) and scope (granularity)
    role: (row.role as TaskRole) ?? undefined,
    scope: (row.scope as TaskScope) ?? undefined,
    severity: (row.severity as TaskSeverity) ?? undefined,
  };
}

/** Convert a domain Task to a database row for insert/upsert.
 *
 * T877 invariant: when a task has a terminal status but no explicit
 * pipelineStage, derive it so the INSERT satisfies the SQLite trigger
 * `trg_tasks_status_pipeline_insert` (status=done requires
 * pipeline_stage IN (contribution, cancelled); status=cancelled requires
 * pipeline_stage=cancelled). This mirrors the runtime behaviour in
 * complete/cancel-ops and means callers never have to think about the
 * invariant — the canonical converter enforces it.
 */
export function taskToRow(task: Partial<Task> & { id: string }): NewTaskRow {
  const status = task.status ?? 'pending';
  let pipelineStage: string | null = task.pipelineStage ?? null;
  if (pipelineStage === null || pipelineStage === undefined) {
    if (status === 'done') pipelineStage = 'contribution';
    else if (status === 'cancelled') pipelineStage = 'cancelled';
  }

  return {
    id: task.id,
    title: task.title ?? '',
    description: task.description ?? null,
    status,
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
    pipelineStage,
    assignee: task.assignee ?? null,
    // T944: orthogonal axes — use undefined so Drizzle applies the column default
    role: task.role ?? undefined,
    scope: task.scope ?? undefined,
    severity: task.severity ?? undefined,
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
