/**
 * Numbered backup system for CLEO data files.
 * Maintains a rotating window of recent backups for rollback protection.
 * @epic T4454
 * @task T4457
 */

import { copyFile, readdir, unlink, stat, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { CleoError } from '../core/errors.js';
import { ExitCode } from '../types/exit-codes.js';

const DEFAULT_MAX_BACKUPS = 5;

/**
 * Create a numbered backup of a file.
 * Rotates existing backups (file.1 -> file.2, etc.) and removes excess.
 */
export async function createBackup(
  filePath: string,
  backupDir: string,
  maxBackups: number = DEFAULT_MAX_BACKUPS,
): Promise<string> {
  try {
    await mkdir(backupDir, { recursive: true });

    const fileName = basename(filePath);

    // Check if source file exists
    try {
      await stat(filePath);
    } catch {
      throw new CleoError(
        ExitCode.FILE_ERROR,
        `Cannot backup: source file not found: ${filePath}`,
      );
    }

    // Rotate existing backups (shift numbers up)
    for (let i = maxBackups; i >= 1; i--) {
      const current = join(backupDir, `${fileName}.${i}`);
      if (i === maxBackups) {
        // Remove oldest backup
        try {
          await unlink(current);
        } catch {
          // File may not exist
        }
      } else {
        const next = join(backupDir, `${fileName}.${i + 1}`);
        try {
          await stat(current);
          const { copyFile: cp } = await import('node:fs/promises');
          await cp(current, next);
        } catch {
          // File may not exist
        }
      }
    }

    // Create new backup as .1
    const backupPath = join(backupDir, `${fileName}.1`);
    await copyFile(filePath, backupPath);
    return backupPath;
  } catch (err) {
    if (err instanceof CleoError) throw err;
    throw new CleoError(
      ExitCode.FILE_ERROR,
      `Backup failed for: ${filePath}`,
      { cause: err },
    );
  }
}

/**
 * List existing backups for a file, sorted by number (newest first).
 */
export async function listBackups(
  fileName: string,
  backupDir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(backupDir);
    const prefix = `${fileName}.`;
    return entries
      .filter((e) => e.startsWith(prefix) && /^\d+$/.test(e.slice(prefix.length)))
      .sort((a, b) => {
        const numA = parseInt(a.slice(prefix.length), 10);
        const numB = parseInt(b.slice(prefix.length), 10);
        return numA - numB;
      })
      .map((e) => join(backupDir, e));
  } catch {
    return [];
  }
}

/**
 * Restore a file from its most recent backup.
 * Returns the path of the backup that was restored.
 */
export async function restoreFromBackup(
  fileName: string,
  backupDir: string,
  targetPath: string,
): Promise<string> {
  const backups = await listBackups(fileName, backupDir);
  if (backups.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No backups found for: ${fileName}`,
    );
  }
  const newest = backups[0]!;
  await copyFile(newest, targetPath);
  return newest;
}
