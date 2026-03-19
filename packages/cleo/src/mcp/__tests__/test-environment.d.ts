/**
 * Isolated Test CLEO Environment
 *
 * Creates a temporary CLEO project directory with minimal data files
 * for integration and E2E tests. Ensures tests don't corrupt production data.
 *
 * Uses `cleo init` to create a valid project, then configures it for testing:
 * - Disables session enforcement
 * - Pre-populates with test tasks and an epic
 * - Provides cleanup on teardown
 *
 * @task T2922
 */
export interface TestEnvironment {
    /** Path to the temporary CLEO project root */
    projectRoot: string;
    /** Pre-created epic ID */
    epicId: string;
    /** Pre-created task IDs (children of the epic) */
    taskIds: string[];
    /** Path to the CLEO CLI */
    cliPath: string;
}
/**
 * Create an isolated test CLEO environment.
 *
 * This initializes a fresh CLEO project in a temporary directory,
 * disables session enforcement, and pre-populates test data.
 */
export declare function createTestEnvironment(): Promise<TestEnvironment>;
/**
 * Destroy the test environment and clean up all temporary files.
 */
export declare function destroyTestEnvironment(env: TestEnvironment): Promise<void>;
/**
 * Query audit log entries from the SQLite audit_log table in the test environment.
 * Replaces legacy todo-log.jsonl readers (T5338, ADR-024).
 */
export declare function readAuditEntries(projectRoot: string, filter?: {
    action?: string;
    taskId?: string;
    sessionId?: string;
}): Promise<any[]>;
//# sourceMappingURL=test-environment.d.ts.map