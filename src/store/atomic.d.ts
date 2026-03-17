/**
 * Atomic file write operations using write-file-atomic.
 * Ensures writes are crash-safe: temp file -> validate -> rename.
 * @epic T4454
 * @task T4457
 * @task T4721 - Added atomic database operations
 */
/**
 * Write data to a file atomically.
 * Creates parent directories if they don't exist.
 * Uses write-file-atomic for crash-safe writes (temp file -> rename).
 */
export declare function atomicWrite(filePath: string, data: string, options?: {
    mode?: number;
    encoding?: BufferEncoding;
}): Promise<void>;
/**
 * Read a file and return its contents.
 * Returns null if the file does not exist.
 */
export declare function safeReadFile(filePath: string): Promise<string | null>;
/**
 * Write JSON data atomically with consistent formatting.
 */
export declare function atomicWriteJson(filePath: string, data: unknown, options?: {
    indent?: number;
}): Promise<void>;
/**
 * Atomic database migration result.
 */
export interface AtomicMigrationResult {
    success: boolean;
    tempPath: string;
    backupPath?: string;
    error?: string;
}
/**
 * Perform atomic database migration using rename operations.
 *
 * Pattern:
 *   1. Write new database to temp file (tasks.db.new)
 *   2. Validate temp database integrity
 *   3. Rename existing tasks.db → tasks.db.backup
 *   4. Rename temp → tasks.db (atomic)
 *   5. Only delete backup on success
 *
 * @param dbPath - Path to the database file (e.g., tasks.db)
 * @param tempPath - Path to temporary database (e.g., tasks.db.new)
 * @param validateFn - Async function to validate the temp database
 * @returns Result with paths and success status
 */
export declare function atomicDatabaseMigration(dbPath: string, tempPath: string, validateFn: (path: string) => Promise<boolean>): Promise<AtomicMigrationResult>;
/**
 * Restore database from backup after failed migration.
 *
 * @param dbPath - Path to the database file
 * @param backupPath - Path to the backup file
 * @returns true if restore succeeded
 */
export declare function restoreDatabaseFromBackup(dbPath: string, backupPath: string): Promise<boolean>;
/**
 * Clean up migration artifacts after successful migration.
 *
 * @param backupPath - Path to backup file to delete
 * @returns true if cleanup succeeded
 */
export declare function cleanupMigrationArtifacts(backupPath: string): Promise<boolean>;
/**
 * Validate SQLite database integrity by attempting to open it.
 *
 * @param dbPath - Path to database file
 * @returns true if database is valid
 */
export declare function validateSqliteDatabase(dbPath: string): Promise<boolean>;
//# sourceMappingURL=atomic.d.ts.map