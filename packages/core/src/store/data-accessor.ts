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

// SSoT-EXEMPT:engine-migration-T1571
/**
 * Convenience: get a DataAccessor with auto-detected engine.
 *
 * @deprecated Use openCleoDb('tasks', cwd) for direct DB access or
 * UmbrellaDataAccessor for multi-DB composition. This function is
 * retained for backward compatibility and will be removed in a future
 * release.
 */
// SSoT-EXEMPT: deprecated backward-compat shim — auto-detect signature predates ADR-057 uniform pattern; openCleoDb is the canonical replacement
export async function getAccessor(
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  return createDataAccessor(undefined, cwd);
}

// ---------------------------------------------------------------------------
// T9050 — openCleoDb alias for backward compat
// ---------------------------------------------------------------------------

/**
 * Alias: get a DBHandle for the tasks database.
 *
 * This is the canonical replacement for getAccessor() when callers
 * need the native DB handle rather than the full DataAccessor interface.
 * Delegates to openCleoDb('tasks', cwd).
 *
 * @param cwd - Optional working directory.
 * @returns DBHandle for tasks.db.
 */
export async function getAccessorDb(cwd?: string): Promise<import('./open-cleo-db.js').DBHandle> {
  const { openCleoDb } = await import('./open-cleo-db.js');
  return openCleoDb('tasks', cwd);
}
