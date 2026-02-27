/**
 * Atomic file write operations using write-file-atomic.
 * Ensures writes are crash-safe: temp file -> validate -> rename.
 * @epic T4454
 * @task T4457
 * @task T4721 - Added atomic database operations
 */

import writeFileAtomic from 'write-file-atomic';
import { readFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { CleoError } from '../core/errors.js';
import { ExitCode } from '../types/exit-codes.js';

/**
 * Write data to a file atomically.
 * Creates parent directories if they don't exist.
 * Uses write-file-atomic for crash-safe writes (temp file -> rename).
 */
export async function atomicWrite(
  filePath: string,
  data: string,
  options?: { mode?: number; encoding?: BufferEncoding },
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, data, {
      encoding: options?.encoding ?? 'utf8',
      mode: options?.mode,
    });
  } catch (err) {
    throw new CleoError(
      ExitCode.FILE_ERROR,
      `Atomic write failed: ${filePath}`,
      { cause: err },
    );
  }
}

/**
 * Read a file and return its contents.
 * Returns null if the file does not exist.
 */
export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new CleoError(
      ExitCode.FILE_ERROR,
      `Failed to read: ${filePath}`,
      { cause: err },
    );
  }
}

/**
 * Write JSON data atomically with consistent formatting.
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  options?: { indent?: number },
): Promise<void> {
  const json = JSON.stringify(data, null, options?.indent ?? 2) + '\n';
  await atomicWrite(filePath, json);
}

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
export async function atomicDatabaseMigration(
  dbPath: string,
  tempPath: string,
  validateFn: (path: string) => Promise<boolean>,
): Promise<AtomicMigrationResult> {
  const backupPath = `${dbPath}.backup`;

  try {
    // Step 1: Validate temp database exists
    if (!existsSync(tempPath)) {
      throw new Error(`Temp database not found: ${tempPath}`);
    }

    // Step 2: Validate the temp database integrity
    const isValid = await validateFn(tempPath);
    if (!isValid) {
      throw new Error(`Temp database validation failed: ${tempPath}`);
    }

    // Step 3: If existing database exists, rename to backup
    if (existsSync(dbPath)) {
      await rename(dbPath, backupPath);
    }

    // Step 4: Atomically rename temp to final (atomic on POSIX systems)
    await rename(tempPath, dbPath);

    return {
      success: true,
      tempPath,
      backupPath: existsSync(backupPath) ? backupPath : undefined,
    };
  } catch (err) {
    return {
      success: false,
      tempPath,
      backupPath: existsSync(backupPath) ? backupPath : undefined,
      error: String(err),
    };
  }
}

/**
 * Restore database from backup after failed migration.
 *
 * @param dbPath - Path to the database file
 * @param backupPath - Path to the backup file
 * @returns true if restore succeeded
 */
export async function restoreDatabaseFromBackup(
  dbPath: string,
  backupPath: string,
): Promise<boolean> {
  try {
    if (!existsSync(backupPath)) {
      return false;
    }

    // If a partial database exists, remove it
    if (existsSync(dbPath)) {
      await unlink(dbPath);
    }

    // Restore from backup
    await rename(backupPath, dbPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up migration artifacts after successful migration.
 *
 * @param backupPath - Path to backup file to delete
 * @returns true if cleanup succeeded
 */
export async function cleanupMigrationArtifacts(backupPath: string): Promise<boolean> {
  try {
    if (existsSync(backupPath)) {
      await unlink(backupPath);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate SQLite database integrity by attempting to open it.
 *
 * @param dbPath - Path to database file
 * @returns true if database is valid
 */
export async function validateSqliteDatabase(dbPath: string): Promise<boolean> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
    const isOk = integrityRow?.integrity_check === 'ok';
    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const hasTasksTable = !!tableRow;
    db.close();
    return isOk && hasTasksTable;
  } catch {
    return false;
  }
}
