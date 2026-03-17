/**
 * Shared database helper functions for SQLite store modules.
 *
 * Consolidates upsert and dependency patterns used across
 * sqlite-data-accessor.ts, task-store.ts, and session-store.ts.
 *
 * @epic T4454
 */
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { Task } from '../types/task.js';
import type { NewTaskRow } from './tasks-schema.js';
import * as schema from './tasks-schema.js';
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
export declare function upsertTask(db: DrizzleDb, row: NewTaskRow, archiveFields?: ArchiveFields): Promise<void>;
/**
 * Upsert a single session row into the sessions table.
 */
export declare function upsertSession(db: DrizzleDb, session: Session): Promise<void>;
/**
 * Update dependencies for a task: delete existing, then re-insert.
 * Optionally filters by a set of valid IDs.
 */
export declare function updateDependencies(db: DrizzleDb, taskId: string, depends: string[], validIds?: Set<string>): Promise<void>;
/**
 * Batch-update dependencies for multiple tasks in two bulk SQL operations.
 * Replaces per-task updateDependencies() loops with:
 * 1. Single DELETE for all task IDs
 * 2. Single INSERT for all dependency rows
 *
 * Callers are responsible for wrapping this in a transaction if needed.
 */
export declare function batchUpdateDependencies(db: DrizzleDb, tasks: Array<{
    taskId: string;
    deps: string[];
}>, validIds?: Set<string>): Promise<void>;
/**
 * Batch-load dependencies for a list of tasks and apply them in-place.
 * Uses inArray for efficient querying. Optionally filters by a set of valid IDs.
 */
export declare function loadDependenciesForTasks(db: DrizzleDb, tasks: Task[], validationIds?: Set<string>): Promise<void>;
/**
 * Batch-load relations for a list of tasks and apply them in-place.
 * Mirrors loadDependenciesForTasks pattern for task_relations table (T5168).
 */
export declare function loadRelationsForTasks(db: DrizzleDb, tasks: Task[]): Promise<void>;
export {};
//# sourceMappingURL=db-helpers.d.ts.map