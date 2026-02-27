/**
 * Shared database helper functions for SQLite store modules.
 *
 * Consolidates upsert and dependency patterns used across
 * sqlite-data-accessor.ts, task-store.ts, and session-store.ts.
 *
 * @epic T4454
 */

import { eq, inArray } from 'drizzle-orm';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';
import type { NewTaskRow } from './schema.js';
import type { Task } from '../types/task.js';
import type { Session } from './validation-schemas.js';

/** Drizzle database instance type. */
type DrizzleDb = SqliteRemoteDatabase<typeof schema>;

/** Archive-specific fields for task upsert. */
export interface ArchiveFields {
  archivedAt?: string;
  archiveReason?: string;
  cycleTimeDays?: number | null;
}

/**
 * Upsert a single task row into the tasks table.
 * Handles both active task upsert and archived task upsert via optional archiveFields.
 *
 * Defensively nulls out parentId if it references a non-existent task,
 * preventing orphaned FK violations from blocking bulk operations (T5034).
 */
export async function upsertTask(
  db: DrizzleDb,
  row: NewTaskRow,
  archiveFields?: ArchiveFields,
): Promise<void> {
  // Defensive: null out parentId if it references a non-existent task (T5034)
  if (row.parentId) {
    const parent = await db.select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, row.parentId))
      .limit(1)
      .all();
    if (parent.length === 0) {
      row = { ...row, parentId: null };
    }
  }

  const values = archiveFields ? { ...row, ...archiveFields, status: 'archived' as const } : row;
  const set: Record<string, unknown> = {
    title: row.title,
    description: row.description,
    status: archiveFields ? 'archived' : row.status,
    priority: row.priority,
    type: row.type,
    parentId: row.parentId,
    phase: row.phase,
    size: row.size,
    position: row.position,
    positionVersion: row.positionVersion,
    labelsJson: row.labelsJson,
    notesJson: row.notesJson,
    acceptanceJson: row.acceptanceJson,
    filesJson: row.filesJson,
    origin: row.origin,
    blockedBy: row.blockedBy,
    epicLifecycle: row.epicLifecycle,
    noAutoComplete: row.noAutoComplete,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    verificationJson: row.verificationJson,
    createdBy: row.createdBy,
    modifiedBy: row.modifiedBy,
    sessionId: row.sessionId,
    // Always include archive metadata so unarchive clears stale values (T5034)
    archivedAt: archiveFields?.archivedAt ?? null,
    archiveReason: archiveFields?.archiveReason ?? null,
    cycleTimeDays: archiveFields?.cycleTimeDays ?? null,
  };
  await db.insert(schema.tasks)
    .values(values)
    .onConflictDoUpdate({ target: schema.tasks.id, set })
    .run();
}

/**
 * Upsert a single session row into the sessions table.
 */
export async function upsertSession(db: DrizzleDb, session: Session): Promise<void> {
  const sessionName = session.name || `session-${session.id}`;
  const values = {
    id: session.id,
    name: sessionName,
    status: session.status,
    scopeJson: JSON.stringify(session.scope ?? { type: 'global' }),
    currentTask: session.taskWork?.taskId ?? null,
    taskStartedAt: session.taskWork?.setAt ?? null,
    agent: session.agent ?? null,
    notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
    tasksCompletedJson: session.tasksCompleted ? JSON.stringify(session.tasksCompleted) : '[]',
    tasksCreatedJson: session.tasksCreated ? JSON.stringify(session.tasksCreated) : '[]',
    handoffJson: session.handoffJson ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    // Session chain fields (T4959)
    previousSessionId: session.previousSessionId ?? null,
    nextSessionId: session.nextSessionId ?? null,
    agentIdentifier: session.agentIdentifier ?? null,
    handoffConsumedAt: session.handoffConsumedAt ?? null,
    handoffConsumedBy: session.handoffConsumedBy ?? null,
    debriefJson: session.debriefJson ?? null,
    // Session stats fields
    statsJson: session.stats ? JSON.stringify(session.stats) : null,
    resumeCount: session.resumeCount ?? null,
    gradeMode: session.gradeMode ? 1 : null,
  };
  const { id: _id, ...setFields } = values;
  await db.insert(schema.sessions)
    .values(values)
    .onConflictDoUpdate({ target: schema.sessions.id, set: setFields })
    .run();
}

/**
 * Update dependencies for a task: delete existing, then re-insert.
 * Optionally filters by a set of valid IDs.
 */
export async function updateDependencies(
  db: DrizzleDb,
  taskId: string,
  depends: string[],
  validIds?: Set<string>,
): Promise<void> {
  await db.delete(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, taskId))
    .run();
  for (const depId of depends) {
    if (!validIds || validIds.has(depId)) {
      await db.insert(schema.taskDependencies)
        .values({ taskId, dependsOn: depId })
        .onConflictDoNothing()
        .run();
    }
  }
}

/**
 * Batch-load dependencies for a list of tasks and apply them in-place.
 * Uses inArray for efficient querying. Optionally filters by a set of valid IDs.
 */
export async function loadDependenciesForTasks(
  db: DrizzleDb,
  tasks: Task[],
  validationIds?: Set<string>,
): Promise<void> {
  if (tasks.length === 0) return;
  const taskIds = tasks.map(t => t.id);
  const taskIdSet = validationIds ?? new Set(taskIds);

  const allDeps = await db.select().from(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, taskIds))
    .all();

  const depMap = new Map<string, string[]>();
  for (const dep of allDeps) {
    if (taskIdSet.has(dep.dependsOn)) {
      let arr = depMap.get(dep.taskId);
      if (!arr) {
        arr = [];
        depMap.set(dep.taskId, arr);
      }
      arr.push(dep.dependsOn);
    }
  }

  for (const task of tasks) {
    const deps = depMap.get(task.id);
    if (deps && deps.length > 0) {
      task.depends = deps;
    }
  }
}
