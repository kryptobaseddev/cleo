/**
 * SQLite store via drizzle-orm/sqlite-proxy + node:sqlite (DatabaseSync).
 *
 * Zero native npm dependencies, 100% cross-platform (Windows/Linux/macOS).
 * File-backed SQLite with WAL mode for multi-process concurrent access.
 * Database stored at .cleo/tasks.db.
 *
 * Architecture: node:sqlite provides the synchronous file-backed SQLite engine,
 * wrapped via sqlite-proxy to give drizzle-orm an async interface. All writes
 * go directly to disk through SQLite's native WAL mechanism -- no saveToFile()
 * pattern needed.
 *
 * @epic T4454
 * @task T4817 - node:sqlite engine migration (ADR-006, ADR-010)
 * @task T4810 - Data loss prevention guards
 */
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
type DatabaseSync = _DatabaseSyncType;
declare const DatabaseSync: new (path: import("fs").PathLike, options?: import("node:sqlite").DatabaseSyncOptions | undefined) => DatabaseSync;
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './tasks-schema.js';
/** Schema version for newly created databases. Single source of truth. */
export declare const SQLITE_SCHEMA_VERSION = "2.0.0";
/**
 * Get the path to the SQLite database file.
 */
export declare function getDbPath(cwd?: string): string;
/**
 * Initialize the SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (async via sqlite-proxy).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export declare function getDb(cwd?: string): Promise<SqliteRemoteDatabase<typeof schema>>;
/**
 * Resolve the path to the drizzle migrations folder.
 * Works from both src/ (dev via tsx) and dist/ (compiled).
 */
export declare function resolveMigrationsFolder(): string;
/**
 * Check if an error is a SQLite BUSY error (database locked by another process).
 * node:sqlite throws native Error with message containing the SQLite error code.
 * @task T5185
 */
export declare function isSqliteBusy(err: unknown): boolean;
/**
 * Close the database connection and release resources.
 */
export declare function closeDb(): void;
/**
 * Reset database singleton state without saving.
 * Used during migrations when database file is deleted and recreated.
 * Safe to call multiple times.
 */
export declare function resetDbState(): void;
/**
 * Get the schema version from the database.
 */
export declare function getSchemaVersion(cwd?: string): Promise<string | null>;
/**
 * Check if the database file exists.
 */
export declare function dbExists(cwd?: string): boolean;
/**
 * Get the underlying node:sqlite DatabaseSync instance.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export declare function getNativeDb(): DatabaseSync | null;
/**
 * Get the underlying node:sqlite DatabaseSync instance for tasks.db.
 * Alias for getNativeDb() — mirrors getBrainNativeDb() naming convention.
 */
export declare function getNativeTasksDb(): DatabaseSync | null;
/**
 * Re-export schema for external use.
 */
export { schema };
export type { SqliteRemoteDatabase };
/**
 * Close ALL database singletons (tasks.db, brain.db, nexus.db).
 *
 * Must be called before deleting temp directories on Windows, where
 * SQLite holds exclusive file handles on .db, .db-wal, and .db-shm files.
 * Safe to call even if some databases were never opened.
 *
 * @task T5508
 */
export declare function closeAllDatabases(): Promise<void>;
//# sourceMappingURL=sqlite.d.ts.map