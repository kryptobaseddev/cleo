/**
 * JSON read/write with schema validation, locking, and backup.
 * This is the primary data access layer for CLEO data files.
 * @epic T4454
 * @task T4457
 */

import { createHash } from 'node:crypto';
import { atomicWrite, atomicWriteJson, safeReadFile } from './atomic.js';
import { createBackup } from './backup.js';
import { withLock } from './lock.js';
import { CleoError } from '../core/errors.js';
import { ExitCode } from '../types/exit-codes.js';

/**
 * Read and parse a JSON file.
 * Returns null if the file does not exist.
 */
export async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  const content = await safeReadFile(filePath);
  if (content === null) return null;

  try {
    return JSON.parse(content) as T;
  } catch (err) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid JSON in: ${filePath}`,
      { cause: err },
    );
  }
}

/**
 * Read a JSON file, throwing if it doesn't exist.
 */
export async function readJsonRequired<T = unknown>(filePath: string): Promise<T> {
  const data = await readJson<T>(filePath);
  if (data === null) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Required file not found: ${filePath}`,
    );
  }
  return data;
}

/**
 * Compute a truncated SHA-256 checksum of a value.
 * Used for integrity verification (matches Bash CLI's 16-char hex format).
 */
export function computeChecksum(data: unknown): string {
  const json = JSON.stringify(data);
  const hash = createHash('sha256').update(json).digest('hex');
  return hash.substring(0, 16);
}

/** Options for saveJson. */
export interface SaveJsonOptions {
  /** Directory for backups. If omitted, no backup is created. */
  backupDir?: string;
  /** Maximum number of backups to retain. Default: 5. */
  maxBackups?: number;
  /** JSON indentation. Default: 2. */
  indent?: number;
  /** Validation function. Called before write; throw to abort. */
  validate?: (data: unknown) => void | Promise<void>;
}

/**
 * Save JSON data with optional locking, backup, and validation.
 * Follows the CLEO atomic write pattern:
 *   1. Acquire lock
 *   2. Validate data
 *   3. Create backup of existing file
 *   4. Atomic write (temp file -> rename)
 *   5. Release lock
 */
export async function saveJson(
  filePath: string,
  data: unknown,
  options?: SaveJsonOptions,
): Promise<void> {
  await withLock(filePath, async () => {
    // Validate before write
    if (options?.validate) {
      try {
        await options.validate(data);
      } catch (err) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Validation failed before write: ${filePath}`,
          { cause: err },
        );
      }
    }

    // Create backup if configured
    if (options?.backupDir) {
      try {
        await createBackup(filePath, options.backupDir, options.maxBackups);
      } catch {
        // Backup failure is non-fatal for first write (file may not exist yet)
      }
    }

    // Atomic write
    await atomicWriteJson(filePath, data, { indent: options?.indent });
  });
}

/**
 * Append a line to a JSONL file atomically.
 * Used for manifest entries and audit logs.
 */
export async function appendJsonl(
  filePath: string,
  entry: unknown,
): Promise<void> {
  const existing = await safeReadFile(filePath);
  const line = JSON.stringify(entry);
  const content = existing ? existing.trimEnd() + '\n' + line + '\n' : line + '\n';
  await atomicWrite(filePath, content);
}
