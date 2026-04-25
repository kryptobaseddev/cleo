/**
 * Shared database helper functions for SQLite store modules.
 *
 * Consolidates upsert and dependency patterns used across
 * sqlite-data-accessor.ts, tasks-sqlite.ts, and session-store.ts.
 *
 * @epic T4454
 */

import type { Session, Task } from '@cleocode/contracts';
import { eq, inArray } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import type { NewTaskRow } from './tasks-schema.js';
import * as schema from './tasks-schema.js';

const log = getLogger('db-helpers');

/** Drizzle database instance type. */
type DrizzleDb = NodeSQLiteDatabase<typeof schema>;

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
 * When `allowOrphanParent` is true (bulk/migration mode, T5034): silently nulls out
 * parentId if the referenced parent does not exist, preventing FK violations.
 * When false (normal single-task writes, default): logs a warning but still proceeds
 * so that FK enforcement at the DB level provides the final safety net.
 *
 * Callers that perform bulk imports or archive restoration should pass
 * `allowOrphanParent: true` to enable the lenient behavior.
 */
export async function upsertTask(
  db: DrizzleDb,
  row: NewTaskRow,
  archiveFields?: ArchiveFields,
  allowOrphanParent = false,
): Promise<void> {
  // Validate parentId exists before writing (T5034, T585).
  // In bulk/archive mode (allowOrphanParent=true) we silently null it out to
  // avoid FK violations during migrations. In normal mode we log a warning so
  // the data integrity issue surfaces without breaking the write.
  if (row.parentId) {
    const parent = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, row.parentId))
      .limit(1)
      .all();
    if (parent.length === 0) {
      if (allowOrphanParent) {
        row = { ...row, parentId: null };
      } else {
        // Log a warning — the FK constraint will reject the write if enabled,
        // or the task will be stored without a parent if FKs are off (test mode).
        log.warn(
          { taskId: row.id, parentId: row.parentId },
          'upsertTask: parentId references a non-existent task — parent relationship may be lost',
        );
      }
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
    // T060: pipeline stage name (RCASD-IVTR+C)
    pipelineStage: row.pipelineStage ?? null,
    assignee: row.assignee ?? null,
    // Always include archive metadata so unarchive clears stale values (T5034)
    archivedAt: archiveFields?.archivedAt ?? null,
    archiveReason: archiveFields?.archiveReason ?? null,
    cycleTimeDays: archiveFields?.cycleTimeDays ?? null,
  };
  await db
    .insert(schema.tasks)
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
  await db
    .insert(schema.sessions)
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
  await db.delete(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, taskId)).run();
  for (const depId of depends) {
    if (!validIds || validIds.has(depId)) {
      await db
        .insert(schema.taskDependencies)
        .values({ taskId, dependsOn: depId })
        .onConflictDoNothing()
        .run();
    }
  }
}

/**
 * Batch-update dependencies for multiple tasks in two bulk SQL operations.
 * Replaces per-task updateDependencies() loops with:
 * 1. Single DELETE for all task IDs
 * 2. Single INSERT for all dependency rows
 *
 * Callers are responsible for wrapping this in a transaction if needed.
 */
export async function batchUpdateDependencies(
  db: DrizzleDb,
  tasks: Array<{ taskId: string; deps: string[] }>,
  validIds?: Set<string>,
): Promise<void> {
  if (tasks.length === 0) return;

  const allTaskIds = tasks.map((t) => t.taskId);

  // Single DELETE: remove all existing dependencies for these tasks
  await db
    .delete(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, allTaskIds))
    .run();

  // Collect all valid dependency rows
  const allDepRows: Array<{ taskId: string; dependsOn: string }> = [];
  for (const { taskId, deps } of tasks) {
    for (const depId of deps) {
      if (!validIds || validIds.has(depId)) {
        allDepRows.push({ taskId, dependsOn: depId });
      }
    }
  }

  // Single INSERT for all dependency rows
  if (allDepRows.length > 0) {
    await db.insert(schema.taskDependencies).values(allDepRows).onConflictDoNothing().run();
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
  const taskIds = tasks.map((t) => t.id);
  const taskIdSet = validationIds ?? new Set(taskIds);

  const allDeps = await db
    .select()
    .from(schema.taskDependencies)
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

/**
 * Batch-load relations for a list of tasks and apply them in-place.
 * Mirrors loadDependenciesForTasks pattern for task_relations table (T5168).
 */
export async function loadRelationsForTasks(db: DrizzleDb, tasks: Task[]): Promise<void> {
  if (tasks.length === 0) return;
  const taskIds = tasks.map((t) => t.id);

  const allRels = await db
    .select()
    .from(schema.taskRelations)
    .where(inArray(schema.taskRelations.taskId, taskIds))
    .all();

  const relMap = new Map<string, Array<{ taskId: string; type: string; reason?: string }>>();
  for (const rel of allRels) {
    let arr = relMap.get(rel.taskId);
    if (!arr) {
      arr = [];
      relMap.set(rel.taskId, arr);
    }
    arr.push({
      taskId: rel.relatedTo,
      type: rel.relationType,
      reason: rel.reason ?? undefined,
    });
  }

  for (const task of tasks) {
    const relations = relMap.get(task.id);
    if (relations && relations.length > 0) {
      task.relates = relations;
    }
  }
}
