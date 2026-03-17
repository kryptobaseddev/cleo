/**
 * SQLite-backed task store operations.
 *
 * CRUD operations for tasks, dependencies, and relations backed by tasks.db.
 * Implements the same interface as the JSON store for StoreProvider compatibility.
 *
 * @epic T4454
 * @task W1-T3
 */
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { safeCreateTask, safeDeleteTask, safeUpdateTask, } from './data-safety.js';
import { getDb, getNativeDb } from './sqlite.js';
import * as schema from './tasks-schema.js';
// === ROW <-> DOMAIN CONVERSION ===
/** Convert a database row to a domain Task object. */
function rowToTask(row) {
    return {
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        type: row.type,
        parentId: row.parentId,
        phase: row.phase ?? undefined,
        size: row.size,
        position: row.position,
        positionVersion: row.positionVersion ?? undefined,
        description: row.description ?? undefined,
        labels: parseJson(row.labelsJson),
        notes: parseJson(row.notesJson),
        acceptance: parseJson(row.acceptanceJson),
        files: parseJson(row.filesJson),
        depends: undefined, // Populated separately from task_dependencies
        origin: row.origin,
        blockedBy: row.blockedBy ?? undefined,
        epicLifecycle: row.epicLifecycle,
        noAutoComplete: row.noAutoComplete ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt ?? undefined,
        cancelledAt: row.cancelledAt ?? undefined,
        cancellationReason: row.cancellationReason ?? undefined,
        verification: row.verificationJson ? parseJson(row.verificationJson) : undefined,
        provenance: row.createdBy || row.modifiedBy || row.sessionId
            ? {
                createdBy: row.createdBy,
                modifiedBy: row.modifiedBy,
                sessionId: row.sessionId,
            }
            : undefined,
    };
}
/** Convert a domain Task to a database row for insert/update. */
function taskToRow(task) {
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
function parseJson(jsonStr) {
    if (!jsonStr)
        return undefined;
    try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed) && parsed.length === 0)
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
// === CRUD OPERATIONS ===
/** Create a new task. */
export async function createTask(task, cwd) {
    const db = await getDb(cwd);
    const row = taskToRow(task);
    db.insert(schema.tasks).values(row).run();
    // Insert dependencies
    if (task.depends && task.depends.length > 0) {
        for (const depId of task.depends) {
            db.insert(schema.taskDependencies).values({ taskId: task.id, dependsOn: depId }).run();
        }
    }
    return task;
}
/** Get a task by ID, including its dependencies. */
export async function getTask(taskId, cwd) {
    const db = await getDb(cwd);
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();
    if (rows.length === 0)
        return null;
    const task = rowToTask(rows[0]);
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
export async function updateTask(taskId, updates, cwd) {
    const db = await getDb(cwd);
    const existing = await getTask(taskId, cwd);
    if (!existing)
        return null;
    // Build update object (only changed fields)
    const updateRow = {
        updatedAt: new Date().toISOString(),
    };
    if (updates.title !== undefined)
        updateRow.title = updates.title;
    if (updates.description !== undefined)
        updateRow.description = updates.description;
    if (updates.status !== undefined)
        updateRow.status = updates.status;
    if (updates.priority !== undefined)
        updateRow.priority = updates.priority;
    if (updates.type !== undefined)
        updateRow.type = updates.type;
    if (updates.parentId !== undefined)
        updateRow.parentId = updates.parentId;
    if (updates.phase !== undefined)
        updateRow.phase = updates.phase;
    if (updates.size !== undefined)
        updateRow.size = updates.size;
    if (updates.position !== undefined)
        updateRow.position = updates.position;
    if (updates.labels !== undefined)
        updateRow.labelsJson = JSON.stringify(updates.labels);
    if (updates.notes !== undefined)
        updateRow.notesJson = JSON.stringify(updates.notes);
    if (updates.acceptance !== undefined)
        updateRow.acceptanceJson = JSON.stringify(updates.acceptance);
    if (updates.files !== undefined)
        updateRow.filesJson = JSON.stringify(updates.files);
    if (updates.origin !== undefined)
        updateRow.origin = updates.origin;
    if (updates.blockedBy !== undefined)
        updateRow.blockedBy = updates.blockedBy;
    if (updates.epicLifecycle !== undefined)
        updateRow.epicLifecycle = updates.epicLifecycle;
    if (updates.completedAt !== undefined)
        updateRow.completedAt = updates.completedAt;
    if (updates.cancelledAt !== undefined)
        updateRow.cancelledAt = updates.cancelledAt;
    if (updates.cancellationReason !== undefined)
        updateRow.cancellationReason = updates.cancellationReason;
    if (updates.verification !== undefined)
        updateRow.verificationJson = JSON.stringify(updates.verification);
    db.update(schema.tasks).set(updateRow).where(eq(schema.tasks.id, taskId)).run();
    // Update dependencies if provided
    if (updates.depends !== undefined) {
        db.delete(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, taskId)).run();
        for (const depId of updates.depends) {
            db.insert(schema.taskDependencies).values({ taskId, dependsOn: depId }).run();
        }
    }
    return getTask(taskId, cwd);
}
/** Delete a task by ID. */
export async function deleteTask(taskId, cwd) {
    const db = await getDb(cwd);
    const existing = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .all();
    if (existing.length === 0)
        return false;
    db.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();
    return true;
}
/** List tasks with optional filters. */
export async function listTasks(filters, cwd) {
    const db = await getDb(cwd);
    const conditions = [];
    // Exclude archived by default
    conditions.push(ne(schema.tasks.status, 'archived'));
    if (filters?.status)
        conditions.push(eq(schema.tasks.status, filters.status));
    if (filters?.parentId !== undefined) {
        if (filters.parentId === null) {
            conditions.push(isNull(schema.tasks.parentId));
        }
        else {
            conditions.push(eq(schema.tasks.parentId, filters.parentId));
        }
    }
    if (filters?.type)
        conditions.push(eq(schema.tasks.type, filters.type));
    if (filters?.phase)
        conditions.push(eq(schema.tasks.phase, filters.phase));
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
export async function findTasks(query, limit = 20, cwd) {
    const db = await getDb(cwd);
    const pattern = `%${query}%`;
    const rows = await db
        .select()
        .from(schema.tasks)
        .where(and(ne(schema.tasks.status, 'archived'), sql `(${schema.tasks.id} LIKE ${pattern} OR ${schema.tasks.title} LIKE ${pattern} OR ${schema.tasks.description} LIKE ${pattern})`))
        .limit(limit)
        .all();
    return rows.map(rowToTask);
}
/** Archive a task (sets status to 'archived' with metadata). */
export async function archiveTask(taskId, reason, cwd) {
    const db = await getDb(cwd);
    const task = await getTask(taskId, cwd);
    if (!task)
        return false;
    const now = new Date().toISOString();
    const cycleTime = task.createdAt
        ? Math.floor((Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60 * 24))
        : null;
    db.update(schema.tasks)
        .set({
        status: 'archived',
        archivedAt: now,
        archiveReason: reason ?? 'completed',
        cycleTimeDays: cycleTime,
        updatedAt: now,
    })
        .where(eq(schema.tasks.id, taskId))
        .run();
    return true;
}
// === DEPENDENCY & RELATION OPERATIONS ===
/** Load dependencies for a list of tasks. */
async function loadDependencies(tasks, cwd) {
    if (tasks.length === 0)
        return;
    const db = await getDb(cwd);
    const taskIds = tasks.map((t) => t.id);
    const deps = await db
        .select()
        .from(schema.taskDependencies)
        .where(inArray(schema.taskDependencies.taskId, taskIds))
        .all();
    const depMap = new Map();
    for (const dep of deps) {
        if (!depMap.has(dep.taskId))
            depMap.set(dep.taskId, []);
        depMap.get(dep.taskId).push(dep.dependsOn);
    }
    for (const task of tasks) {
        const taskDeps = depMap.get(task.id);
        if (taskDeps && taskDeps.length > 0) {
            task.depends = taskDeps;
        }
    }
}
/** Add a dependency between tasks. */
export async function addDependency(taskId, dependsOn, cwd) {
    const db = await getDb(cwd);
    db.insert(schema.taskDependencies).values({ taskId, dependsOn }).onConflictDoNothing().run();
}
/** Remove a dependency. */
export async function removeDependency(taskId, dependsOn, cwd) {
    const db = await getDb(cwd);
    db.delete(schema.taskDependencies)
        .where(and(eq(schema.taskDependencies.taskId, taskId), eq(schema.taskDependencies.dependsOn, dependsOn)))
        .run();
}
/** Add a relation between tasks. */
export async function addRelation(taskId, relatedTo, relationType = 'related', cwd, reason) {
    const db = await getDb(cwd);
    await db
        .insert(schema.taskRelations)
        .values({ taskId, relatedTo, relationType, reason: reason ?? null })
        .onConflictDoNothing()
        .run();
}
/** Get relations for a task. */
export async function getRelations(taskId, cwd) {
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
export async function getBlockerChain(taskId, cwd) {
    await getDb(cwd);
    const nativeDb = getNativeDb();
    if (!nativeDb)
        return [];
    const result = nativeDb
        .prepare(`
    WITH RECURSIVE blocker_chain(id) AS (
      SELECT depends_on FROM task_dependencies WHERE task_id = ?
      UNION
      SELECT td.depends_on FROM task_dependencies td
      JOIN blocker_chain bc ON td.task_id = bc.id
    )
    SELECT id FROM blocker_chain
  `)
        .all(taskId);
    return result.map((r) => r.id);
}
/** Get children of a task (hierarchy). */
export async function getChildren(parentId, cwd) {
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
export async function getSubtree(rootId, cwd) {
    await getDb(cwd);
    const nativeDb = getNativeDb();
    if (!nativeDb)
        return [];
    const rows = nativeDb
        .prepare(`
    WITH RECURSIVE subtree AS (
      SELECT * FROM tasks WHERE id = ?
      UNION ALL
      SELECT t.* FROM tasks t
      JOIN subtree s ON t.parent_id = s.id
    )
    SELECT * FROM subtree
  `)
        .all(rootId);
    return rows.map(rowToTask);
}
/** Count tasks by status. */
export async function countByStatus(cwd) {
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
    const result = {};
    for (const row of rows) {
        result[row.status] = row.count;
    }
    return result;
}
/** Get total task count (excluding archived). */
export async function countTasks(cwd) {
    const db = await getDb(cwd);
    const result = await db
        .select({ count: count() })
        .from(schema.tasks)
        .where(ne(schema.tasks.status, 'archived'))
        .get();
    return result?.count ?? 0;
}
/**
 * Create a task with full safety protections.
 * Includes: collision detection, write verification, sequence validation, auto-checkpoint.
 */
export async function createTaskSafe(task, cwd, config) {
    return safeCreateTask(() => createTask(task, cwd), task, cwd, config);
}
/**
 * Update a task with full safety protections.
 * Includes: write verification, auto-checkpoint.
 */
export async function updateTaskSafe(taskId, updates, cwd, config) {
    return safeUpdateTask(() => updateTask(taskId, updates, cwd), taskId, updates, cwd, config);
}
/**
 * Delete a task with full safety protections.
 * Includes: delete verification, auto-checkpoint.
 */
export async function deleteTaskSafe(taskId, cwd, config) {
    return safeDeleteTask(() => deleteTask(taskId, cwd), taskId, cwd, config);
}
//# sourceMappingURL=task-store.js.map