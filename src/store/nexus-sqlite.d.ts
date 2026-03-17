/**
 * SQLite store for nexus.db via drizzle-orm/sqlite-proxy + node:sqlite (DatabaseSync).
 *
 * Separate database from tasks.db and brain.db for cross-project registry
 * and audit infrastructure. Follows the same singleton + WAL + migration
 * pattern as brain-sqlite.ts.
 *
 * nexus.db lives in ~/.cleo/ (global home) rather than per-project .cleo/,
 * since it stores cross-project data.
 *
 * @task T5365
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as nexusSchema from './nexus-schema.js';
/** Schema version for newly created nexus databases. Single source of truth. */
export declare const NEXUS_SCHEMA_VERSION = "1.0.0";
/**
 * Get the path to the nexus.db SQLite database file.
 * nexus.db lives in the global ~/.cleo/ directory.
 */
export declare function getNexusDbPath(): string;
/**
 * Resolve the path to the drizzle-nexus migrations folder.
 * Works from both src/ (dev via tsx) and dist/ (compiled).
 */
export declare function resolveNexusMigrationsFolder(): string;
/**
 * Initialize the nexus.db SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (async via sqlite-proxy).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export declare function getNexusDb(): Promise<SqliteRemoteDatabase<typeof nexusSchema>>;
/**
 * Close the nexus.db database connection and release resources.
 */
export declare function closeNexusDb(): void;
/**
 * Reset nexus.db singleton state without saving.
 * Used during tests or when database file is recreated.
 * Safe to call multiple times.
 */
export declare function resetNexusDbState(): void;
/**
 * Get the underlying node:sqlite DatabaseSync instance for nexus.db.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export declare function getNexusNativeDb(): DatabaseSync | null;
/**
 * Re-export nexus schema for external use.
 */
export { nexusSchema };
export type { SqliteRemoteDatabase };
//# sourceMappingURL=nexus-sqlite.d.ts.map