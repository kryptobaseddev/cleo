/**
 * SQLite store for brain.db via drizzle-orm/sqlite-proxy + node:sqlite (DatabaseSync).
 *
 * Separate database from tasks.db for cognitive infrastructure (decisions,
 * patterns, learnings). Follows the same singleton + WAL + migration pattern
 * as sqlite.ts.
 *
 * @epic T5149
 * @task T5128
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as brainSchema from './brain-schema.js';
/** Schema version for newly created brain databases. Single source of truth. */
export declare const BRAIN_SCHEMA_VERSION = "1.0.0";
/**
 * Get the path to the brain.db SQLite database file.
 */
export declare function getBrainDbPath(cwd?: string): string;
/**
 * Resolve the path to the drizzle-brain migrations folder.
 * Works from both src/ (dev via tsx) and dist/ (compiled).
 */
export declare function resolveBrainMigrationsFolder(): string;
/**
 * Check whether the sqlite-vec extension is loaded for the current brain.db.
 */
export declare function isBrainVecLoaded(): boolean;
/**
 * Initialize the brain.db SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (async via sqlite-proxy).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export declare function getBrainDb(cwd?: string): Promise<SqliteRemoteDatabase<typeof brainSchema>>;
/**
 * Close the brain.db database connection and release resources.
 */
export declare function closeBrainDb(): void;
/**
 * Reset brain.db singleton state without saving.
 * Used during tests or when database file is recreated.
 * Safe to call multiple times.
 */
export declare function resetBrainDbState(): void;
/**
 * Get the underlying node:sqlite DatabaseSync instance for brain.db.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export declare function getBrainNativeDb(): DatabaseSync | null;
/**
 * Re-export brain schema for external use.
 */
export { brainSchema };
export type { SqliteRemoteDatabase };
//# sourceMappingURL=brain-sqlite.d.ts.map