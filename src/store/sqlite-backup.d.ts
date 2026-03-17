/**
 * SQLite backup via VACUUM INTO with snapshot rotation.
 *
 * Produces self-contained, WAL-free copies of tasks.db into
 * .cleo/backups/sqlite/ with a configurable rotation limit.
 * All errors are swallowed -- backup failure must never interrupt
 * normal operation.
 *
 * @task T4873
 * @epic T4867
 */
export interface VacuumOptions {
    cwd?: string;
    force?: boolean;
}
/**
 * Create a VACUUM INTO snapshot of the SQLite database.
 *
 * Debounced by default (30s). Pass `force: true` to bypass debounce.
 * WAL checkpoint is run before the snapshot for consistency.
 * Oldest snapshots are rotated out when MAX_SNAPSHOTS is reached.
 *
 * Non-fatal: all errors are swallowed.
 */
export declare function vacuumIntoBackup(opts?: VacuumOptions): Promise<void>;
/**
 * List existing SQLite backup snapshots, newest first.
 */
export declare function listSqliteBackups(cwd?: string): Array<{
    name: string;
    path: string;
    mtimeMs: number;
}>;
//# sourceMappingURL=sqlite-backup.d.ts.map