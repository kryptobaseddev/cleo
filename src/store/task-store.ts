/**
 * SQLite-backed task store operations.
 *
 * CRUD operations for tasks, dependencies, and relations backed by tasks.db.
 * Implements the same interface as the JSON store for StoreProvider compatibility.
 *
 * @epic T4454
 * @task W1-T3
 */

import { eq, and, sql, inArray, asc, isNull, ne } from 'drizzle-orm';
import { getDb, saveToFile } from './sqlite.js';
import * as schema from './schema.js';
import type { TaskRow, NewTaskRow } from './schema.js';
import type { Task, TaskStatus, TaskPriority, TaskType, TaskSize } from '../types/task.js';

// === ROW <-> DOMAIN CONVERSION ===

/** Convert a database row to a domain Task object. */
function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    type: row.type as TaskType | undefined,
    parentId: row.parentId,
    phase: row.phase ?? undefined,
    size: row.size as TaskSize | undefined,
    position: row.position,
    positionVersion: row.positionVersion ?? undefined,
    description: row.description ?? undefined,
    labels: parseJson<string[]>(row.labelsJson),
    notes: parseJson<string[]>(row.notesJson),
    acceptance: parseJson<string[]>(row.acceptanceJson),
    files: parseJson<string[]>(row.filesJson),
    depends: undefined, // Populated separately from task_dependencies
    origin: row.origin as Task['origin'],
    blockedBy: row.blockedBy ?? undefined,
    epicLifecycle: row.epicLifecycle as Task['epicLifecycle'],
    noAutoComplete: row.noAutoComplete ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
    cancelledAt: row.cancelledAt ?? undefined,
    cancellationReason: row.cancellationReason ?? undefined,
    verification: row.verificationJson ? parseJson(row.verificationJson) : undefined,
    provenance: (row.createdBy || row.modifiedBy || row.sessionId) ? {
      createdBy: row.createdBy,
      modifiedBy: row.modifiedBy,
      sessionId: row.sessionId,
    } : undefined,
  };
}

/** Convert a domain Task to a database row for insert/update. */
function taskToRow(task: Partial<Task> & { id: string }): NewTaskRow {
  return {
    id: task.id,
    title: task.title ?? '',
    description: task.description,
    status: task.status ?? 'pending',
    priority: task.priority ?? 'medium',
    type: task.type,
    parentId: task.parentId,
    phase: task.phase,
    size: task.size,
    position: task.position,
    labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
    notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
    acceptanceJson: task.acceptance ? JSON.stringify(task.acceptance) : '[]',
    filesJson: task.files ? JSON.stringify(task.files) : '[]',
    origin: task.origin,
    blockedBy: task.blockedBy,
    epicLifecycle: task.epicLifecycle,
    noAutoComplete: task.noAutoComplete,
    createdAt: task.createdAt ?? new Date().toISOString(),
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    cancellationReason: task.cancellationReason,
    verificationJson: task.verification ? JSON.stringify(task.verification) : undefined,
    createdBy: task.provenance?.createdBy,
    modifiedBy: task.provenance?.modifiedBy,
    sessionId: task.provenance?.sessionId,
  };
}

function parseJson<T>(jsonStr: string | null | undefined): T | undefined {
  if (!jsonStr) return undefined;
  try {
    const parsed = JSON.parse(jsonStr) as T;
    if (Array.isArray(parsed) && parsed.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// === CRUD OPERATIONS ===

/** Create a new task. */
export async function createTask(task: Task, cwd?: string): Promise<Task> {
  const db = await getDb(cwd);
  const row = taskToRow(task);
  db.insert(schema.tasks).values(row).run();

  // Insert dependencies
  if (task.depends && task.depends.length > 0) {
    for (const depId of task.depends) {
      db.insert(schema.taskDependencies)
        .values({ taskId: task.id, dependsOn: depId })
        .run();
    }
  }

  saveToFile();
  return task;
}

/** Get a task by ID, including its dependencies. */
export async function getTask(taskId: string, cwd?: string): Promise<Task | null> {
  const db = await getDb(cwd);
  const rows = db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();
  if (rows.length === 0) return null;

  const task = rowToTask(rows[0]!);

  // Load dependencies
  const deps = db.select().from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, taskId)).all();
  if (deps.length > 0) {
    task.depends = deps.map(d => d.dependsOn);
  }

  return task;
}

/** Update an existing task. */
export async function updateTask(
  taskId: string,
  updates: Partial<Task>,
  cwd?: string,
): Promise<Task | null> {
  const db = await getDb(cwd);
  const existing = await getTask(taskId, cwd);
  if (!existing) return null;

  // Build update object (only changed fields)
  const updateRow: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.title !== undefined) updateRow.title = updates.title;
  if (updates.description !== undefined) updateRow.description = updates.description;
  if (updates.status !== undefined) updateRow.status = updates.status;
  if (updates.priority !== undefined) updateRow.priority = updates.priority;
  if (updates.type !== undefined) updateRow.type = updates.type;
  if (updates.parentId !== undefined) updateRow.parentId = updates.parentId;
  if (updates.phase !== undefined) updateRow.phase = updates.phase;
  if (updates.size !== undefined) updateRow.size = updates.size;
  if (updates.position !== undefined) updateRow.position = updates.position;
  if (updates.labels !== undefined) updateRow.labelsJson = JSON.stringify(updates.labels);
  if (updates.notes !== undefined) updateRow.notesJson = JSON.stringify(updates.notes);
  if (updates.acceptance !== undefined) updateRow.acceptanceJson = JSON.stringify(updates.acceptance);
  if (updates.files !== undefined) updateRow.filesJson = JSON.stringify(updates.files);
  if (updates.origin !== undefined) updateRow.origin = updates.origin;
  if (updates.blockedBy !== undefined) updateRow.blockedBy = updates.blockedBy;
  if (updates.epicLifecycle !== undefined) updateRow.epicLifecycle = updates.epicLifecycle;
  if (updates.completedAt !== undefined) updateRow.completedAt = updates.completedAt;
  if (updates.cancelledAt !== undefined) updateRow.cancelledAt = updates.cancelledAt;
  if (updates.cancellationReason !== undefined) updateRow.cancellationReason = updates.cancellationReason;
  if (updates.verification !== undefined) updateRow.verificationJson = JSON.stringify(updates.verification);

  db.update(schema.tasks).set(updateRow).where(eq(schema.tasks.id, taskId)).run();

  // Update dependencies if provided
  if (updates.depends !== undefined) {
    db.delete(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, taskId)).run();
    for (const depId of updates.depends) {
      db.insert(schema.taskDependencies)
        .values({ taskId, dependsOn: depId })
        .run();
    }
  }

  saveToFile();
  return getTask(taskId, cwd);
}

/** Delete a task by ID. */
export async function deleteTask(taskId: string, cwd?: string): Promise<boolean> {
  const db = await getDb(cwd);
  const existing = db.select({ id: schema.tasks.id }).from(schema.tasks)
    .where(eq(schema.tasks.id, taskId)).all();
  if (existing.length === 0) return false;

  db.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();
  saveToFile();
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

  let query = db.select().from(schema.tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.createdAt));

  const rows = filters?.limit
    ? query.limit(filters.limit).all()
    : query.all();

  // Load dependencies for all tasks
  const tasks = rows.map(rowToTask);
  await loadDependencies(tasks, cwd);
  return tasks;
}

/** Find tasks by fuzzy text search. */
export async function findTasks(
  query: string,
  limit: number = 20,
  cwd?: string,
): Promise<Task[]> {
  const db = await getDb(cwd);
  const pattern = `%${query}%`;

  const rows = db.select().from(schema.tasks)
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

/** Archive a task (sets status to 'archived' with metadata). */
export async function archiveTask(
  taskId: string,
  reason?: string,
  cwd?: string,
): Promise<boolean> {
  const db = await getDb(cwd);
  const task = await getTask(taskId, cwd);
  if (!task) return false;

  const now = new Date().toISOString();
  const cycleTime = task.createdAt
    ? Math.floor((Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  db.update(schema.tasks).set({
    status: 'archived',
    archivedAt: now,
    archiveReason: reason ?? 'completed',
    cycleTimeDays: cycleTime,
    updatedAt: now,
  }).where(eq(schema.tasks.id, taskId)).run();

  saveToFile();
  return true;
}

// === DEPENDENCY & RELATION OPERATIONS ===

/** Load dependencies for a list of tasks. */
async function loadDependencies(tasks: Task[], cwd?: string): Promise<void> {
  if (tasks.length === 0) return;
  const db = await getDb(cwd);
  const taskIds = tasks.map(t => t.id);

  const deps = db.select().from(schema.taskDependencies)
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
export async function addDependency(taskId: string, dependsOn: string, cwd?: string): Promise<void> {
  const db = await getDb(cwd);
  db.insert(schema.taskDependencies)
    .values({ taskId, dependsOn })
    .onConflictDoNothing()
    .run();
  saveToFile();
}

/** Remove a dependency. */
export async function removeDependency(taskId: string, dependsOn: string, cwd?: string): Promise<void> {
  const db = await getDb(cwd);
  db.delete(schema.taskDependencies)
    .where(and(
      eq(schema.taskDependencies.taskId, taskId),
      eq(schema.taskDependencies.dependsOn, dependsOn),
    ))
    .run();
  saveToFile();
}

/** Add a relation between tasks. */
export async function addRelation(
  taskId: string,
  relatedTo: string,
  relationType: 'related' | 'blocks' | 'duplicates' = 'related',
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);
  db.insert(schema.taskRelations)
    .values({ taskId, relatedTo, relationType })
    .onConflictDoNothing()
    .run();
  saveToFile();
}

/** Get relations for a task. */
export async function getRelations(taskId: string, cwd?: string): Promise<Array<{ relatedTo: string; type: string }>> {
  const db = await getDb(cwd);
  const rows = db.select().from(schema.taskRelations)
    .where(eq(schema.taskRelations.taskId, taskId))
    .all();
  return rows.map(r => ({ relatedTo: r.relatedTo, type: r.relationType }));
}

// === GRAPH OPERATIONS ===

/** Get the dependency chain (blockers) for a task using recursive CTE. */
export async function getBlockerChain(taskId: string, cwd?: string): Promise<string[]> {
  const db = await getDb(cwd);
  const result = db.all<{ id: string }>(sql`
    WITH RECURSIVE blocker_chain(id) AS (
      SELECT depends_on FROM task_dependencies WHERE task_id = ${taskId}
      UNION
      SELECT td.depends_on FROM task_dependencies td
      JOIN blocker_chain bc ON td.task_id = bc.id
    )
    SELECT id FROM blocker_chain
  `);
  return result.map(r => r.id);
}

/** Get children of a task (hierarchy). */
export async function getChildren(parentId: string, cwd?: string): Promise<Task[]> {
  const db = await getDb(cwd);
  const rows = db.select().from(schema.tasks)
    .where(eq(schema.tasks.parentId, parentId))
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.createdAt))
    .all();
  return rows.map(rowToTask);
}

/** Build a tree from a root task using recursive CTE. */
export async function getSubtree(rootId: string, cwd?: string): Promise<Task[]> {
  const db = await getDb(cwd);
  const rows = db.all<TaskRow>(sql`
    WITH RECURSIVE subtree AS (
      SELECT * FROM tasks WHERE id = ${rootId}
      UNION ALL
      SELECT t.* FROM tasks t
      JOIN subtree s ON t.parent_id = s.id
    )
    SELECT * FROM subtree
  `);
  return rows.map(rowToTask);
}

/** Count tasks by status. */
export async function countByStatus(cwd?: string): Promise<Record<string, number>> {
  const db = await getDb(cwd);
  const rows = db.all<{ status: string; count: number }>(sql`
    SELECT status, COUNT(*) as count FROM tasks
    WHERE status != 'archived'
    GROUP BY status
  `);

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.status] = row.count;
  }
  return result;
}

/** Get total task count (excluding archived). */
export async function countTasks(cwd?: string): Promise<number> {
  const db = await getDb(cwd);
  const result = db.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM tasks WHERE status != 'archived'
  `);
  return result[0]?.count ?? 0;
}
