/**
 * Tests for migration system.
 * @task T4468
 * @epic T4454
 *
 * Note: After tasks.json→tasks.db migration, the getMigrationStatus
 * and runMigration functions for 'todo' type read from getTaskPath()
 * which now returns tasks.db. Since readJson cannot parse SQLite files,
 * todoJson status will be null when no legacy tasks.json exists.
 * The pure-function tests (detectVersion, compareSemver) remain unchanged.
 */
export {};
//# sourceMappingURL=migration.test.d.ts.map