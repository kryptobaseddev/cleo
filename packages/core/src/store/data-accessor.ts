/**
 * DataAccessor re-export + factory functions.
 *
 * The DataAccessor interface is defined in @cleocode/contracts.
 * This module re-exports it and provides the concrete SQLite factory.
 *
 * @epic T4454
 * @task T9054
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
 *
 * @task T9054 — engine parameter dropped; CLEO is SQLite-only (ADR-006).
 */
export async function createDataAccessor(
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  const { createSqliteDataAccessor } = await import('./sqlite-data-accessor.js');
  const inner = await createSqliteDataAccessor(cwd);

  const { wrapWithSafety } = await import('./safety-data-accessor.js');
  return wrapWithSafety(inner, cwd);
}

/**
 * Get a tasks-DB DataAccessor for the given working directory.
 *
 * This is the canonical tasks-only factory. Name is explicit about scope —
 * the former `getAccessor` name implied universality and caused the
 * gitnexus graph to misclassify it as a universal key (T9054).
 *
 * @param cwd - Optional project root (defaults to process.cwd() resolution).
 * @returns DataAccessor backed by tasks.db (ADR-006, ADR-068).
 */
// SSoT-EXEMPT: factory function — signature is (cwd?: string) by design, not a dispatch operation (ADR-057 D5)
export async function getTaskAccessor(
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  return createDataAccessor(cwd);
}

/**
 * @deprecated Renamed to {@link getTaskAccessor} (T9054). Will be removed in a future minor version.
 * Use `getTaskAccessor` or `openCleoDb('tasks', cwd)` instead.
 */
export async function getAccessor(
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  return createDataAccessor(cwd);
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
