/**
 * DataAccessor re-export + factory functions.
 *
 * The DataAccessor interface is defined in @cleocode/contracts.
 * This module re-exports it and provides the concrete SQLite factory.
 *
 * @epic T4454
 */

// Re-export the interface and all related types from contracts
export type {
  ArchiveFields,
  ArchiveFile,
  DataAccessor,
  QueryTasksResult,
  TaskFieldUpdates,
  TaskQueryFilters,
  TransactionAccessor,
} from '@cleocode/contracts';

/**
 * Create a DataAccessor for the given working directory.
 * Always creates a SQLite accessor (ADR-006 canonical storage).
 *
 * ALL accessors returned are safety-enabled by default via SafetyDataAccessor wrapper.
 * Use CLEO_DISABLE_SAFETY=true to bypass (emergency only).
 */
export async function createDataAccessor(
  _engine?: 'sqlite',
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  const { createSqliteDataAccessor } = await import('./sqlite-data-accessor.js');
  const inner = await createSqliteDataAccessor(cwd);

  const { wrapWithSafety } = await import('./safety-data-accessor.js');
  return wrapWithSafety(inner, cwd);
}

/** Convenience: get a DataAccessor with auto-detected engine. */
export async function getAccessor(
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  return createDataAccessor(undefined, cwd);
}
