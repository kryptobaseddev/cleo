/**
 * Integration Test Setup and Fixtures
 *
 * Provides real CLI execution helpers, test fixtures, and cleanup utilities
 * for integration tests that verify full request/response flow through:
 * Gateway -> Domain Router -> Domain Handler -> CLI Executor -> Response Formatter
 *
 * Uses an isolated test CLEO environment (via test-environment.ts) to avoid
 * corrupting production data.
 *
 * The CLIExecutor class (previously in src/mcp/lib/executor.ts, deleted in
 * Phase 5 migration) is now defined inline here. It spawns the CLEO CLI as
 * a subprocess and parses JSON output.
 *
 * @task T2922
 */
import { type TestEnvironment } from './test-environment.js';
interface ExecutorResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: {
        code?: string;
        message: string;
        details?: any;
    };
    stdout: string;
    stderr: string;
    exitCode: number;
    /** Execution duration in milliseconds */
    duration?: number;
}
/**
 * Executes CLEO CLI commands as subprocesses and parses JSON output.
 *
 * This is a minimal reimplementation of the CLIExecutor that was previously
 * in src/mcp/lib/executor.ts. It provides the same interface used by the
 * integration and E2E test suites.
 */
declare class CLIExecutor {
    private cliPath;
    private timeout;
    private maxRetries;
    constructor(cliPath: string, timeout?: number, maxRetries?: number);
    /**
     * Escape a shell argument using single quotes.
     */
    private escapeArg;
    /**
     * Map domain+operation to the actual CLI command structure.
     * Replicates the mapping from the deleted command-builder.ts.
     */
    private mapToCliCommand;
    /**
     * Execute a CLEO CLI command.
     *
     * Translates the test-friendly { domain, operation, args, flags } format
     * into the proper CLI invocation using the domain-to-command mapping.
     */
    execute<T = unknown>(options: {
        domain: string;
        operation: string;
        args?: string[];
        flags?: Record<string, unknown>;
        cwd?: string;
        maxRetries?: number;
        sessionId?: string;
    }): Promise<ExecutorResult<T>>;
    /**
     * Extract a JSON object from mixed output (warnings + JSON).
     * CLI may prepend warning text (e.g., storage migration notices) before JSON.
     * Scans for each '{' in the output and tries to parse valid JSON from it.
     */
    private extractJson;
    /**
     * Parse CLI stdout into an ExecutorResult.
     * Matches the behavior of the deleted src/mcp/lib/executor.ts parseOutput method.
     */
    private parseOutput;
    /**
     * Unwrap primary payload fields.
     * E.g. {tasks: [...]} -> [...], but {task: {id,...}, duplicate: true} stays as-is.
     */
    private unwrapPrimaryField;
    /**
     * Get CLEO version.
     */
    getVersion(): Promise<string>;
    /**
     * Test CLI connectivity.
     */
    testConnection(): Promise<boolean>;
}
/**
 * Extract the actual payload from an executor result's data field.
 *
 * The LAFS envelope format uses `result` instead of `data` for the payload.
 * When the executor encounters `{success:true, result:{...}}`, it may place
 * the full envelope into `ExecutorResult.data` because it doesn't recognize
 * `result` as the payload wrapper. This helper unwraps that case.
 */
export declare function unwrapPayload<T = unknown>(data: any): T;
/**
 * Wrapped executor that automatically uses project root as cwd
 * and unwraps LAFS envelope payloads.
 */
declare class WrappedExecutor {
    private executor;
    private defaultCwd;
    constructor(executor: CLIExecutor, defaultCwd: string);
    execute<T = unknown>(options: any): Promise<any>;
    getVersion(): Promise<string>;
    testConnection(): Promise<boolean>;
}
/**
 * Test context for integration tests
 */
export interface IntegrationTestContext {
    /** CLI executor instance (wrapped to use project root) */
    executor: WrappedExecutor;
    /** Test session ID */
    sessionId: string;
    /** Test epic ID for scoped operations */
    epicId?: string;
    /** Created task IDs for cleanup */
    createdTaskIds: string[];
    /** Project root (isolated temp directory) */
    originalCwd: string;
    /** Test data directory */
    testDataDir: string;
    /** Isolated test environment handle */
    testEnv: TestEnvironment;
}
/**
 * Setup integration test context with isolated CLEO environment
 */
export declare function setupIntegrationTest(): Promise<IntegrationTestContext>;
/**
 * Cleanup integration test resources
 */
export declare function cleanupIntegrationTest(context: IntegrationTestContext | undefined | null): Promise<void>;
/**
 * Create a test task and track for cleanup
 */
export declare function createTestTask(context: IntegrationTestContext, title: string, description: string, options?: {
    parent?: string;
    status?: string;
    priority?: string;
    labels?: string[];
}): Promise<string>;
/**
 * Create a test epic (task without parent)
 */
export declare function createTestEpic(context: IntegrationTestContext, title: string, description: string): Promise<string>;
/**
 * Start a test session
 */
export declare function startTestSession(context: IntegrationTestContext, epicId: string): Promise<void>;
/**
 * Get current CLEO version
 */
export declare function getCleoVersion(executor: WrappedExecutor): Promise<string>;
/**
 * Check if a task exists
 */
export declare function taskExists(executor: WrappedExecutor, taskId: string, cwd?: string): Promise<boolean>;
/**
 * Wait for a condition to be true (polling helper)
 */
export declare function waitForCondition(condition: () => Promise<boolean>, options?: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
}): Promise<void>;
/**
 * Capture audit log entries from the isolated test environment.
 * Reads from SQLite audit_log table (T5338, ADR-024).
 */
export declare function getAuditLogEntries(projectRootOrTestDataDir: string, filter?: {
    domain?: string;
    operation?: string;
    sessionId?: string;
    action?: string;
}): Promise<any[]>;
/**
 * Create a manifest entry fixture
 */
export declare function createManifestEntry(taskId: string, overrides?: any): any;
/**
 * Verify response format matches specification.
 *
 * Note: The response here is an ExecutorResult, not the raw MCP gateway
 * envelope. The executor parses CLI output and populates its own fields.
 * Gateway-level _meta is only present in the raw stdout, not the executor result.
 */
export declare function verifyResponseFormat(response: any, _expectedGateway: 'query' | 'mutate', _expectedDomain: string, _expectedOperation: string): void;
export {};
//# sourceMappingURL=integration-setup.d.ts.map