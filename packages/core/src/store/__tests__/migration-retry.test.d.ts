/**
 * Tests for migration runner retry+backoff on SQLITE_BUSY errors.
 *
 * Verifies that runMigrations retries BEGIN IMMEDIATE when another process
 * holds a RESERVED lock, using exponential backoff with jitter (T5185).
 *
 * @task T5185
 */
export {};
//# sourceMappingURL=migration-retry.test.d.ts.map