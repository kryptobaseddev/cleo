/**
 * Tests for SQLite VACUUM INTO backup module.
 *
 * Verifies:
 * - Non-fatal when getNativeDb() returns null
 * - WAL checkpoint runs before VACUUM INTO
 * - Snapshot rotation enforces MAX_SNAPSHOTS limit
 * - Debounce prevents rapid successive backups
 *
 * @task T4874
 * @epic T4867
 */
export {};
//# sourceMappingURL=sqlite-backup.test.d.ts.map