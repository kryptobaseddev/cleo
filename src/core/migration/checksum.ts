/**
 * Checksum utilities for backup verification.
 *
 * Provides SHA-256 checksum computation and backup verification
 * to ensure data integrity during migrations.
 *
 * @task T4728
 * @epic T4454
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';

/**
 * Result of a backup verification operation.
 */
export interface VerificationResult {
  /** Whether the backup is valid */
  valid: boolean;
  /** Error message if verification failed */
  error?: string;
  /** SHA-256 checksum of the source file */
  sourceChecksum: string;
  /** SHA-256 checksum of the backup file */
  backupChecksum: string;
}

/**
 * Compute SHA-256 checksum of a file.
 *
 * @param filePath - Path to the file
 * @returns Hex-encoded SHA-256 checksum
 * @task T4728
 */
export async function computeChecksum(filePath: string): Promise<string> {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Verify that a backup file matches the source file and is a valid SQLite database.
 *
 * Performs three checks:
 * 1. Computes SHA-256 checksum of both files
 * 2. Compares checksums to detect any content differences
 * 3. Verifies the backup can be opened as a valid SQLite database
 *
 * @param sourcePath - Path to the source database file
 * @param backupPath - Path to the backup file
 * @returns VerificationResult with checksums and validity status
 * @task T4728
 */
export async function verifyBackup(
  sourcePath: string,
  backupPath: string,
): Promise<VerificationResult> {
  // Compute checksums for both files
  const sourceChecksum = await computeChecksum(sourcePath);
  const backupChecksum = await computeChecksum(backupPath);

  // Compare checksums - any difference means corruption or tampering
  if (sourceChecksum !== backupChecksum) {
    return {
      valid: false,
      error: `Checksum mismatch: source=${sourceChecksum}, backup=${backupChecksum}`,
      sourceChecksum,
      backupChecksum,
    };
  }

  // Verify backup can be opened as a valid SQLite database
  // This catches cases where the file is intact but not a valid SQLite file
  try {
    const SQL = await initSqlJs();
    const buffer = readFileSync(backupPath);
    const db = new SQL.Database(buffer);

    // Run a simple query to verify the database is functional
    db.run('SELECT 1');

    // Clean up
    db.close();
  } catch (err) {
    return {
      valid: false,
      error: `Backup is not a valid SQLite database: ${String(err)}`,
      sourceChecksum,
      backupChecksum,
    };
  }

  // All checks passed
  return {
    valid: true,
    sourceChecksum,
    backupChecksum,
  };
}

/**
 * Quick checksum comparison without SQLite verification.
 * Use when you only need to compare file contents.
 *
 * @param filePath1 - First file path
 * @param filePath2 - Second file path
 * @returns true if checksums match, false otherwise
 * @task T4728
 */
export async function compareChecksums(
  filePath1: string,
  filePath2: string,
): Promise<boolean> {
  const checksum1 = await computeChecksum(filePath1);
  const checksum2 = await computeChecksum(filePath2);
  return checksum1 === checksum2;
}
