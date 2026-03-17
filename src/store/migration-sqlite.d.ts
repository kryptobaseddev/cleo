/**
 * Data migration: JSON to SQLite.
 *
 * One-time migration of todo.json + todo-archive.json + sessions.json → tasks.db.
 * Validates row counts match after migration.
 * Keeps JSON files as read-only backup (does not delete).
 *
 * @epic T4454
 * @task W1-T5
 * @task T4721 - Added atomic migration support with custom db path
 */
import type { Session } from '../types/session.js';
import type { Task } from '../types/task.js';
/** Migration result. */
export interface MigrationResult {
    success: boolean;
    tasksImported: number;
    archivedImported: number;
    sessionsImported: number;
    errors: string[];
    warnings: string[];
    existingCounts?: {
        tasks: number;
        archived: number;
        sessions: number;
    };
    jsonCounts?: {
        tasks: number;
        archived: number;
        sessions: number;
    };
}
/** Options for migration. */
export interface MigrationOptions {
    force?: boolean;
    dryRun?: boolean;
}
/** Count records in JSON source files. */
export declare function countJsonRecords(cleoDir: string): {
    tasks: number;
    archived: number;
    sessions: number;
};
/**
 * Migrate JSON data to SQLite.
 * Reads todo.json, todo-archive.json, and sessions.json,
 * writes to tasks.db via drizzle-orm.
 */
/**
 * Migrate JSON data to SQLite with atomic rename pattern.
 * Writes to a temporary database file first, then atomically renames.
 *
 * @param cwd - Optional working directory
 * @param tempDbPath - Optional temporary database path for atomic migration
 * @param logger - Optional migration logger for audit trail (@task T4727)
 * @returns Migration result
 */
export declare function migrateJsonToSqliteAtomic(cwd?: string, tempDbPath?: string, logger?: import('../core/migration/logger.js').MigrationLogger): Promise<MigrationResult>;
export declare function migrateJsonToSqlite(cwd?: string, options?: MigrationOptions): Promise<MigrationResult>;
/**
 * Export SQLite data back to JSON format (for inspection or emergency recovery).
 */
export declare function exportToJson(cwd?: string): Promise<{
    tasks: Task[];
    archived: Task[];
    sessions: Session[];
}>;
//# sourceMappingURL=migration-sqlite.d.ts.map