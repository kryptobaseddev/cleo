/**
 * SQLite-backed task store operations.
 *
 * CRUD operations for tasks, dependencies, and relations backed by tasks.db.
 * Implements the same interface as the JSON store for StoreProvider compatibility.
 *
 * @epic T4454
 * @task W1-T3
 */

import {
  ARCHIVE_REASON_TOMBSTONE,
  ArchiveReasonTombstoneError,
  type ArchiveReasonValue,
  ExitCode,
  isArchiveTombstoneAllowed,
  isStorableTaskId,
  type Task,
  type TaskStatus,
  type TaskType,
} from '@cleocode/contracts';
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { CleoError } from '../errors.js';
import { applyAcPlan, planAcUpdate } from '../tasks/ac-table.js';
import { rowToTask, taskToRow } from './converters.js';
import { cleanupBrainRefsOnTaskDelete } from './cross-db-cleanup.js';
import {
  type SafetyConfig,
  safeCreateTask,
  safeDeleteTask,
  safeUpdateTask,
} from './data-safety-central.js';
import { parseLabels, updateTaskLabels } from './db-helpers.js';
import { getDb, getNativeDb } from './sqlite.js';
import { createSqliteDataAccessor } from './sqlite-data-accessor.js';
import type { TaskRow } from './tasks-schema.js';
import * as schema from './tasks-schema.js';

// === CRUD OPERATIONS ===

/** Insert a task row directly. Internal use only — call createTask for the safe path. */
async function insertTaskRow(task: Task, cwd?: string): Promise<Task> {
  // T12128: the id shape is validated on every READ path and on none of the
  // write paths, which is how `id='/mnt/projects/cleocode'` reached
  // `tasks_tasks`. That row is immortal: `cleo list` returns it, while `show`,
  // `update` and `delete` all reject the id as malformed before they can reach
  // it — the read-side validators that should have prevented it are exactly
  // what makes it unfixable. Validate here, at the chokepoint every task
  // insert passes through, so a malformed id fails loudly at write time
  // instead of silently becoming unreachable data.
  if (!isStorableTaskId(task.id)) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Refusing to insert a task with a malformed id: ${JSON.stringify(task.id)}`,
      {
        fix: 'A task id must be a non-empty identifier under 64 characters, starting with a letter, containing no whitespace, path separators or control characters (e.g. "T1234"). This is a bug in the caller — the id should come from the id generator, not from user input or a path.',
        details: { field: 'id', value: String(task.id) },
      },
    );
  }

  const db = await getDb(cwd);
  const accessor = await createSqliteDataAccessor(cwd);
  return accessor.transaction(async (tx) => {
    const row = taskToRow(task);
    // Retain INSERT's collision rejection rather than converting creation to
    // an upsert that could overwrite a concurrently-created identity.
    db.insert(schema.tasks).values(row).run();
    for (const depId of task.depends ?? []) {
      db.insert(schema.taskDependencies).values({ taskId: task.id, dependsOn: depId }).run();
    }
    await updateTaskLabels(db, task.id, parseLabels(row.labelsJson));
    if (task.acceptance !== undefined) {
      await applyAcPlan(tx, task.id, planAcUpdate(task.id, [], task.acceptance));
    }
    for (const relation of task.relates ?? []) {
      await tx.addRelation(task.id, relation.taskId, relation.type, relation.reason);
    }
    return task;
  });
}

/** Get a task by ID, including its dependencies. */
export async function getTask(taskId: string, cwd?: string): Promise<Task | null> {
  const db = await getDb(cwd);
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();
  if (rows.length === 0) return null;

  const task = rowToTask(rows[0]!);

  // Load dependencies
  const deps = await db
    .select()
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, taskId))
    .all();
  if (deps.length > 0) {
    task.depends = deps.map((d) => d.dependsOn);
  }

  return task;
}

/** Update an existing task. */
export async function updateTask(
  taskId: string,
  updates: Partial<Task>,
  cwd?: string,
): Promise<Task | null> {
  if (updates.id !== undefined && updates.id !== taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'A task update cannot change its identity');
  }
  if (updates.gates !== undefined || updates.abortReason !== undefined) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'gates and abortReason are not persisted task fields',
    );
  }
  const accessor = await createSqliteDataAccessor(cwd);
  return accessor.transaction(async (tx) => {
    const existing = await getTask(taskId, cwd);
    if (!existing) return null;
    const provided = { ...updates };
    for (const [key, value] of Object.entries(provided)) {
      if (value === undefined) Reflect.deleteProperty(provided, key);
    }
    const updated: Task = {
      ...existing,
      ...provided,
      id: taskId,
      updatedAt: updates.updatedAt ?? new Date().toISOString(),
    };
    if (updates.status === 'pending' || updates.status === 'active') {
      if (updates.cancelledAt === undefined) updated.cancelledAt = undefined;
      if (updates.completedAt === undefined) updated.completedAt = undefined;
    }
    // The canonical Task converter is shared with add and rich update. Never
    // maintain another partial field list that silently drops accepted values.
    await tx.upsertSingleTask(updated);
    if (updates.acceptance !== undefined) {
      await applyAcPlan(
        tx,
        taskId,
        planAcUpdate(taskId, await tx.getAcRows(taskId), updates.acceptance),
      );
    }
    if (updates.relates !== undefined) {
      await tx.clearRelations(taskId);
      for (const relation of updates.relates) {
        await tx.addRelation(taskId, relation.taskId, relation.type, relation.reason);
      }
    }
    return getTask(taskId, cwd);
  });
}

/** Delete a task by ID. */
export async function deleteTask(taskId: string, cwd?: string): Promise<boolean> {
  const db = await getDb(cwd);
  const existing = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .all();
  if (existing.length === 0) return false;

  db.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();

  // T033 Part 4: Cross-DB cleanup — nullify brain.db soft FK refs to this task.
  // Runs after deletion to avoid blocking the task delete path on brain errors.
  void cleanupBrainRefsOnTaskDelete(taskId, cwd);

  return true;
}

/** List tasks with optional filters. */
export async function listTasks(
  filters?: {
    status?: TaskStatus;
    parentId?: string | null;
    type?: TaskType;
    phase?: string;
    limit?: number;
  },
  cwd?: string,
): Promise<Task[]> {
  const db = await getDb(cwd);

  const conditions = [];
  // Exclude archived by default
  conditions.push(ne(schema.tasks.status, 'archived'));

  if (filters?.status) conditions.push(eq(schema.tasks.status, filters.status));
  if (filters?.parentId !== undefined) {
    if (filters.parentId === null) {
      conditions.push(isNull(schema.tasks.parentId));
    } else {
      conditions.push(eq(schema.tasks.parentId, filters.parentId));
    }
  }
  if (filters?.type) conditions.push(eq(schema.tasks.type, filters.type));
  if (filters?.phase) conditions.push(eq(schema.tasks.phase, filters.phase));

  const query = db
    .select()
    .from(schema.tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.createdAt));

  const rows = filters?.limit ? await query.limit(filters.limit).all() : await query.all();

  // Load dependencies for all tasks
  const tasks = rows.map(rowToTask);
  await loadDependencies(tasks, cwd);
  return tasks;
}

/** Find tasks by fuzzy text search. */
export async function findTasks(query: string, limit: number = 20, cwd?: string): Promise<Task[]> {
  const db = await getDb(cwd);
  const pattern = `%${query}%`;

  const rows = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        ne(schema.tasks.status, 'archived'),
        sql`(${schema.tasks.id} LIKE ${pattern} OR ${schema.tasks.title} LIKE ${pattern} OR ${schema.tasks.description} LIKE ${pattern})`,
      ),
    )
    .limit(limit)
    .all();

  return rows.map(rowToTask);
}

/**
 * Archive a task (sets status to 'archived' with metadata).
 *
 * T1434 follow-up: T1408 introduced a CHECK constraint that limits
 * `archive_reason` to the 6-value enum (verified, reconciled, superseded,
 * shadowed, cancelled, completed-unverified). The default and any caller-
 * supplied reason MUST be one of those values; anything else is normalized
 * to `'completed-unverified'` to preserve forward compat.
 */
export async function archiveTask(taskId: string, reason?: string, cwd?: string): Promise<boolean> {
  const db = await getDb(cwd);
  const task = await getTask(taskId, cwd);
  if (!task) return false;

  const now = new Date().toISOString();
  const cycleTime = task.createdAt
    ? Math.floor((Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // Normalize any caller-supplied legacy reason ('completed', 'deleted',
  // arbitrary strings) into the T1408 enum. NULL stays NULL via undefined.
  //
  // T1409: enforce the tombstone guard. Direct callers MAY NOT write the
  // tombstone value `'completed-unverified'` unless the migration-backfill
  // env flag is set. The fallback when no reason is supplied still maps to
  // the tombstone (since DB CHECK requires one of the 6 enum values), but
  // explicit caller-supplied tombstones from non-migration code are rejected.
  // T11578 · AC1: the consolidated `tasks_tasks.archive_reason` column is
  // CHECK-backed by the T1408 enum, so the writer must produce a value typed as
  // `ArchiveReasonValue` (the prefixed schema narrows the column type). The
  // normalization already only ever yields canonical enum values; the explicit
  // return type makes that guarantee visible to the drizzle `.set()` overload.
  const normalizedReason: ArchiveReasonValue = (() => {
    if (!reason) return ARCHIVE_REASON_TOMBSTONE;
    const valid = new Set<ArchiveReasonValue>([
      'verified',
      'reconciled',
      'superseded',
      'shadowed',
      'cancelled',
      ARCHIVE_REASON_TOMBSTONE,
    ]);
    if (reason === ARCHIVE_REASON_TOMBSTONE && !isArchiveTombstoneAllowed()) {
      throw new ArchiveReasonTombstoneError(taskId);
    }
    if (valid.has(reason as ArchiveReasonValue)) return reason as ArchiveReasonValue;
    if (reason === 'deleted') return 'cancelled';
    return ARCHIVE_REASON_TOMBSTONE;
  })();

  db.update(schema.tasks)
    .set({
      status: 'archived',
      archivedAt: now,
      archiveReason: normalizedReason,
      cycleTimeDays: cycleTime,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, taskId))
    .run();

  return true;
}

// === DEPENDENCY & RELATION OPERATIONS ===

/** Load dependencies for a list of tasks. */
async function loadDependencies(tasks: Task[], cwd?: string): Promise<void> {
  if (tasks.length === 0) return;
  const db = await getDb(cwd);
  const taskIds = tasks.map((t) => t.id);

  const deps = await db
    .select()
    .from(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, taskIds))
    .all();

  const depMap = new Map<string, string[]>();
  for (const dep of deps) {
    if (!depMap.has(dep.taskId)) depMap.set(dep.taskId, []);
    depMap.get(dep.taskId)!.push(dep.dependsOn);
  }

  for (const task of tasks) {
    const taskDeps = depMap.get(task.id);
    if (taskDeps && taskDeps.length > 0) {
      task.depends = taskDeps;
    }
  }
}

/** Add a dependency between tasks. */
export async function addDependency(
  taskId: string,
  dependsOn: string,
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);
  db.insert(schema.taskDependencies).values({ taskId, dependsOn }).onConflictDoNothing().run();
}

/** Remove a dependency. */
export async function removeDependency(
  taskId: string,
  dependsOn: string,
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);
  db.delete(schema.taskDependencies)
    .where(
      and(
        eq(schema.taskDependencies.taskId, taskId),
        eq(schema.taskDependencies.dependsOn, dependsOn),
      ),
    )
    .run();
}

/** Add a relation between tasks. */
export async function addRelation(
  taskId: string,
  relatedTo: string,
  relationType:
    | 'related'
    | 'blocks'
    | 'duplicates'
    | 'absorbs'
    | 'fixes'
    | 'extends'
    | 'supersedes'
    | 'groups' = 'related',
  cwd?: string,
  reason?: string,
): Promise<void> {
  const db = await getDb(cwd);
  await db
    .insert(schema.taskRelations)
    .values({ taskId, relatedTo, relationType, reason: reason ?? null })
    .onConflictDoNothing()
    .run();
}

/** Remove a relation between tasks. */
export async function removeRelation(
  taskId: string,
  relatedTo: string,
  relationType?: string,
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);
  const conditions = [
    eq(schema.taskRelations.taskId, taskId),
    eq(schema.taskRelations.relatedTo, relatedTo),
  ];
  if (relationType !== undefined) {
    conditions.push(eq(schema.taskRelations.relationType, relationType as 'related'));
  }
  await db
    .delete(schema.taskRelations)
    .where(and(...conditions))
    .run();
}

/** Get relations for a task. */
export async function getRelations(
  taskId: string,
  cwd?: string,
): Promise<Array<{ relatedTo: string; type: string; reason?: string }>> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.taskRelations)
    .where(eq(schema.taskRelations.taskId, taskId))
    .all();
  return rows.map((r) => ({
    relatedTo: r.relatedTo,
    type: r.relationType,
    reason: r.reason ?? undefined,
  }));
}

// === GRAPH OPERATIONS ===

/** Get the dependency chain (blockers) for a task using recursive CTE. */
export async function getBlockerChain(taskId: string, cwd?: string): Promise<string[]> {
  await getDb(cwd);
  const nativeDb = getNativeDb(cwd);
  if (!nativeDb) return [];
  const result = nativeDb
    .prepare(`
    WITH RECURSIVE blocker_chain(id) AS (
      SELECT depends_on FROM tasks_task_dependencies WHERE task_id = ?
      UNION
      SELECT td.depends_on FROM tasks_task_dependencies td
      JOIN blocker_chain bc ON td.task_id = bc.id
    )
    SELECT id FROM blocker_chain
  `)
    .all(taskId) as { id: string }[];
  return result.map((r) => r.id);
}

/** Get children of a task (hierarchy). */
export async function getChildren(parentId: string, cwd?: string): Promise<Task[]> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.parentId, parentId))
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.createdAt))
    .all();
  return rows.map(rowToTask);
}

/** Build a tree from a root task using recursive CTE. */
export async function getSubtree(rootId: string, cwd?: string): Promise<Task[]> {
  await getDb(cwd);
  const nativeDb = getNativeDb(cwd);
  if (!nativeDb) return [];
  const rows = nativeDb
    .prepare(`
    WITH RECURSIVE subtree AS (
      SELECT * FROM tasks_tasks WHERE id = ?
      UNION ALL
      SELECT t.* FROM tasks_tasks t
      JOIN subtree s ON t.parent_id = s.id
    )
    SELECT * FROM subtree
  `)
    .all(rootId) as TaskRow[];
  return rows.map(rowToTask);
}

/** Count tasks by status. */
export async function countByStatus(cwd?: string): Promise<Record<string, number>> {
  const db = await getDb(cwd);
  const rows = await db
    .select({
      status: schema.tasks.status,
      count: count(),
    })
    .from(schema.tasks)
    .where(ne(schema.tasks.status, 'archived'))
    .groupBy(schema.tasks.status)
    .all();

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.status] = row.count;
  }
  return result;
}

/** Get total task count (excluding archived). */
export async function countTasks(cwd?: string): Promise<number> {
  const db = await getDb(cwd);
  const result = await db
    .select({ count: count() })
    .from(schema.tasks)
    .where(ne(schema.tasks.status, 'archived'))
    .get();
  return result?.count ?? 0;
}

// === SAFE WRAPPER FUNCTIONS (with collision detection, write verification, auto-checkpoint) ===

/** Configuration for safe operations. */
export type { SafetyConfig } from './data-safety-central.js';

/**
 * Create a task with full safety protections.
 * Includes: collision detection, write verification, sequence validation, auto-checkpoint.
 */
export async function createTask(
  task: Task,
  cwd?: string,
  config?: Partial<SafetyConfig>,
): Promise<Task> {
  return safeCreateTask(() => insertTaskRow(task, cwd), task, cwd, config);
}

/**
 * Update a task with full safety protections.
 * Includes: write verification, auto-checkpoint.
 */
export async function updateTaskSafe(
  taskId: string,
  updates: Partial<Task>,
  cwd?: string,
  config?: Partial<SafetyConfig>,
): Promise<Task | null> {
  return safeUpdateTask(() => updateTask(taskId, updates, cwd), taskId, updates, cwd, config);
}

/**
 * Delete a task with full safety protections.
 * Includes: delete verification, auto-checkpoint.
 */
export async function deleteTaskSafe(
  taskId: string,
  cwd?: string,
  config?: Partial<SafetyConfig>,
): Promise<boolean> {
  return safeDeleteTask(() => deleteTask(taskId, cwd), taskId, cwd, config);
}
