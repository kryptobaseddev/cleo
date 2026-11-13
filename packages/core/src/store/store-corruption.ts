/** Lightweight classification shared by store opens and CLI error handling. */
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';

/** A corruption error always names the single supported recovery command. */
export function storeCorruptError(target: string, cause: Error): CleoError {
  // @sync-invariant none:local-only refused local file recovery; no replicated row was written
  return new CleoError(ExitCode.FILE_ERROR, `E_DB_CORRUPT: ${target}: ${cause.message}`, {
    codeName: 'E_DB_CORRUPT',
    fix: 'cleo doctor repair-store',
    cause,
  });
}

/** Recognize native corruption and corruption wrapped by a domain opener. */
export function isStoreCorruption(error: Error): boolean {
  return (
    /SQLITE_CORRUPT|malformed|database disk image|not a database/i.test(error.message) ||
    ('errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 11) ||
    (error.cause instanceof Error && isStoreCorruption(error.cause))
  );
}
