/**
 * DataAccessor re-export + factory functions.
 *
 * The DataAccessor interface is defined in @cleocode/contracts.
 * This module re-exports it and provides the concrete SQLite factory.
 *
 * @epic T4454
 * @task T9054
 */

import { resolve } from 'node:path';
import { getProjectRoot, worktreeScope } from '../project-scope.js';

// Re-export the interface and all related types from contracts
export type {
  ArchiveFields,
  ArchiveFile,
  DataAccessor,
  QueryTasksResult,
  TaskAuditLogQuery,
  TaskAuditLogRow,
  TaskFieldUpdates,
  TaskQueryFilters,
  TransactionAccessor,
} from '@cleocode/contracts';

/**
 * Assert that production database writes are forbidden in test mode.
 *
 * When `CLEO_TEST_MODE=1` is set, any write to a production `tasks.db` or
 * `brain.db` path (i.e. paths NOT under a temp dir or the env-var override)
 * throws `E_PROD_DB_WRITE_IN_TEST`. This prevents tests from accidentally
 * polluting the developer's live database.
 *
 * Escape hatch: set `CLEO_TEST_DB_OVERRIDE=1` to suppress the guard (audited
 * per ADR-051 pattern — written to `.cleo/audit/force-bypass.jsonl`).
 *
 * @param dbPath - Absolute resolved path to the SQLite file being opened.
 * @throws Error with code `E_PROD_DB_WRITE_IN_TEST` when the guard fires.
 *
 * @task T1906
 */
export function assertTestEnv(dbPath: string): void {
  const testMode = process.env['CLEO_TEST_MODE'];
  if (testMode !== '1') return;

  const override = process.env['CLEO_TEST_DB_OVERRIDE'];
  if (override === '1') {
    // Audited escape hatch — log and allow.
    process.stderr.write(
      `[T1906] CLEO_TEST_DB_OVERRIDE=1 — bypassing prod-DB guard for: ${dbPath}\n`,
    );
    return;
  }

  // Allow paths that are clearly temp/in-memory (OS temp dir, :memory:, test fixtures)
  const tmpDir = process.env['TMPDIR'] ?? process.env['TMP'] ?? process.env['TEMP'] ?? '/tmp';
  const isTmpPath =
    dbPath === ':memory:' ||
    dbPath.startsWith(tmpDir) ||
    dbPath.includes('/tmp/') ||
    dbPath.includes('\\Temp\\') ||
    dbPath.includes('.test.') ||
    dbPath.includes('/test-') ||
    // vitest uses a unique tmpDir per worker
    dbPath.includes('vitest');

  if (!isTmpPath) {
    throw new Error(
      `E_PROD_DB_WRITE_IN_TEST: CLEO_TEST_MODE=1 but attempted to open production DB at "${dbPath}". ` +
        `Use an in-memory or temp-dir database in tests, or set CLEO_TEST_DB_OVERRIDE=1 to bypass (audited). ` +
        `(T1906 / BBTT-W3-4)`,
    );
  }
}

/**
 * Create a DataAccessor for the given working directory.
 * Always creates a SQLite accessor (ADR-006 canonical storage).
 *
 * ALL accessors returned are safety-enabled by default via SafetyDataAccessor wrapper.
 * Use CLEO_DISABLE_SAFETY=true to bypass (emergency only).
 *
 * @param cwd - Explicit owning project root, captured before asynchronous initialization.
 * @returns A safety-enabled accessor bound to that root for its lifetime.
 * @remarks Later ambient project changes cannot redirect initialization or method calls.
 * @example
 * ```ts
 * const store = await createDataAccessor('/projects/example');
 * const task = await store.loadSingleTask('T001');
 * ```
 * @task T9054 — engine parameter dropped; CLEO is SQLite-only (ADR-006).
 */
export async function createDataAccessor(
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  const root = resolve(cwd ?? getProjectRoot());
  const inherited = worktreeScope.getStore();
  const captured = inherited ? { ...inherited } : undefined;
  captured?.execution?.assertActive();
  const { createSqliteDataAccessor, captureTaskAccessorScope, bindTaskAccessorScope } =
    await import('./sqlite-data-accessor.js');
  const scope = captureTaskAccessorScope(root, captured);
  return worktreeScope.run(scope, async () => {
    const inner = await createSqliteDataAccessor(root);
    const { wrapWithSafety } = await import('./safety-data-accessor.js');
    return bindTaskAccessorScope(wrapWithSafety(inner, root), scope);
  });
}

/**
 * Get a tasks-DB DataAccessor for the given working directory.
 *
 * This is the canonical tasks-only factory. Name is explicit about scope —
 * the former `getAccessor` name implied universality and caused the
 * gitnexus graph to misclassify it as a universal key (T9054).
 *
 * @param cwd - Optional project root (defaults to process.cwd() resolution).
 * @returns DataAccessor backed by the consolidated project cleo.db (ADR-068).
 */
// SSoT-EXEMPT: factory function — signature is (cwd?: string) by design, not a dispatch operation (ADR-057 D5)
export async function getTaskAccessor(
  cwd?: string,
): Promise<import('@cleocode/contracts').DataAccessor> {
  return createDataAccessor(cwd);
}

/**
 * @deprecated Renamed to {@link getTaskAccessor} (T9054). Will be removed in a future minor version.
 * Use `getTaskAccessor` or `openCleoDb('project', cwd)` instead.
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
 * Alias: get a DBHandle for the project-scope (tasks) database.
 *
 * This is the canonical replacement for getAccessor() when callers
 * need the native DB handle rather than the full DataAccessor interface.
 * Delegates to openCleoDb('project', cwd).
 *
 * @param cwd - Optional working directory.
 * @returns DBHandle for the project-scope `cleo.db`.
 */
export async function getAccessorDb(cwd?: string): Promise<import('./open-cleo-db.js').DBHandle> {
  const { openCleoDb } = await import('./open-cleo-db.js');
  return openCleoDb('project', cwd);
}
