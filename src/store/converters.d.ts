/**
 * Shared row <-> domain conversion functions for SQLite store modules.
 *
 * Eliminates duplication across sqlite-data-accessor.ts, task-store.ts,
 * and session-store.ts.
 */
import type { Task } from '../types/task.js';
import type { NewTaskRow, SessionRow, TaskRow } from './tasks-schema.js';
import type { Session } from './validation-schemas.js';
/** Convert a database TaskRow to a domain Task object. */
export declare function rowToTask(row: TaskRow): Task;
/** Convert a domain Task to a database row for insert/upsert. */
export declare function taskToRow(task: Partial<Task> & {
    id: string;
}): NewTaskRow;
/** Convert a domain Task to a row suitable for archived tasks. */
export declare function archivedTaskToRow(task: Task): NewTaskRow;
/** Convert a SessionRow to a domain Session. */
export declare function rowToSession(row: SessionRow): Session;
//# sourceMappingURL=converters.d.ts.map