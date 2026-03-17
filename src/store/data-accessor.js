/**
 * DataAccessor: File-level storage abstraction for core modules.
 *
 * Core modules operate on whole-file data structures (TaskFile, ArchiveFile, SessionsFile).
 * The DataAccessor abstracts WHERE that data is stored (SQLite via Drizzle ORM)
 * while preserving the read-modify-write pattern that core business logic relies on.
 *
 * This is the DRY/SOLID injection point: core modules accept a DataAccessor parameter
 * instead of calling readJson/saveJson directly.
 *
 * Implementation: SqliteDataAccessor (materializes/dematerializes from SQLite tables)
 *
 * @epic T4454
 */
/**
 * Create a DataAccessor for the given working directory.
 * Always creates a SQLite accessor (ADR-006 canonical storage).
 *
 * ALL accessors returned are safety-enabled by default via SafetyDataAccessor wrapper.
 * Use CLEO_DISABLE_SAFETY=true to bypass (emergency only).
 *
 * @param _engine - Ignored. Kept for API compatibility during migration period.
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function createDataAccessor(_engine, cwd) {
    const { createSqliteDataAccessor } = await import('./sqlite-data-accessor.js');
    const inner = await createSqliteDataAccessor(cwd);
    // Always wrap with safety - cannot be bypassed at factory level
    const { wrapWithSafety } = await import('./safety-data-accessor.js');
    return wrapWithSafety(inner, cwd);
}
/** Convenience: get a DataAccessor with auto-detected engine. */
export async function getAccessor(cwd) {
    return createDataAccessor(undefined, cwd);
}
//# sourceMappingURL=data-accessor.js.map