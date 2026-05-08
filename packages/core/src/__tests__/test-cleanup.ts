import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const WINDOWS_CLEANUP_ERROR_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

function isWindowsCleanupLockError(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    WINDOWS_CLEANUP_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code))
  );
}

function warnCleanupSkipped(path: string, error: unknown): void {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : 'unknown';
  console.warn(`[test-cleanup] Windows temp cleanup skipped for ${path}: ${code}`);
}

export function removeTempDirSync(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (isWindowsCleanupLockError(error)) {
      warnCleanupSkipped(path, error);
      return;
    }
    throw error;
  }
}

export async function removeTempDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (isWindowsCleanupLockError(error)) {
      warnCleanupSkipped(path, error);
      return;
    }
    throw error;
  }
}
