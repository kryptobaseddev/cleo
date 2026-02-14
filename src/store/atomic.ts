/**
 * Atomic file write operations using write-file-atomic.
 * Ensures writes are crash-safe: temp file -> validate -> rename.
 * @epic T4454
 * @task T4457
 */

import writeFileAtomic from 'write-file-atomic';
import { readFile, mkdir } from 'node:fs/promises';
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
