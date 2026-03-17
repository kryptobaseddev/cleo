/**
 * SQLite-based implementation of the DataAccessor interface.
 *
 * Materializes TaskFile/ArchiveFile/SessionsFile from SQLite tables,
 * allowing core modules to continue using whole-file data structures
 * while storage is backed by the relational database.
 *
 * Uses existing sqlite.ts engine (node:sqlite / drizzle-orm) and
 * task-store.ts / session-store.ts for row-level operations.
 *
 * @epic T4454
 */
import type { DataAccessor } from './data-accessor.js';
/** Write a JSON blob to the schema_meta table by key. */
export declare function setMetaValue(cwd: string | undefined, key: string, value: unknown): Promise<void>;
/**
 * Create a SQLite-backed DataAccessor.
 *
 * Opens (or creates) the SQLite database at `.cleo/tasks.db` and returns
 * a DataAccessor that materializes/dematerializes whole-file structures
 * from the relational tables.
 *
 * @param cwd - Working directory for path resolution (defaults to process.cwd())
 */
export declare function createSqliteDataAccessor(cwd?: string): Promise<DataAccessor>;
//# sourceMappingURL=sqlite-data-accessor.d.ts.map