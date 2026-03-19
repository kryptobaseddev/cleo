/**
 * Shared test helper for initializing a tasks.db SQLite database.
 *
 * Replaces the legacy pattern of writing tasks.json fixtures.
 * Uses createSqliteDataAccessor to create a real SQLite database
 * with proper schema, then seeds test data via the accessor.
 *
 * @task T5244
 */
import type { Task, TaskFile } from '@cleocode/contracts';
import type { DataAccessor } from '../data-accessor.js';
/** Result of creating a test database environment. */
export interface TestDbEnv {
    /** Temporary directory (the project root). */
    tempDir: string;
    /** Path to .cleo directory. */
    cleoDir: string;
    /** SQLite-backed DataAccessor. */
    accessor: DataAccessor;
    /** Clean up temp dir and close DB. */
    cleanup: () => Promise<void>;
}
/**
 * Create a temporary directory with an initialized tasks.db.
 *
 * Usage:
 * ```ts
 * let env: TestDbEnv;
 * beforeEach(async () => { env = await createTestDb(); });
 * afterEach(async () => { await env.cleanup(); });
 * ```
 */
export declare function createTestDb(): Promise<TestDbEnv>;
/**
 * Build a TaskFile structure from a list of task partials.
 * Useful for seeding test data via accessor.saveTaskFile().
 */
export declare function makeTaskFile(tasks: Array<Partial<Task> & {
    id: string;
}>): TaskFile;
/**
 * Seed tasks into the test database via the accessor.
 *
 * Uses a two-pass approach to avoid foreign key violations:
 * 1. First pass: upsert all tasks without dependencies so FK targets exist
 * 2. Second pass: upsert tasks again with dependencies (all FK targets now exist)
 * 3. Initialize metadata for the test environment
 */
export declare function seedTasks(accessor: DataAccessor, tasks: Array<Partial<Task> & {
    id: string;
}>): Promise<void>;
//# sourceMappingURL=test-db-helper.d.ts.map