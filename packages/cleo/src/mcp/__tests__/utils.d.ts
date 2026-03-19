/**
 * Test Utilities for Domain Handler Tests
 *
 * Provides mock factories, response builders, and test fixtures.
 *
 * Types previously imported from the deleted src/mcp/lib/executor.ts and
 * src/mcp/types/index.ts are now defined inline.
 *
 * @task T2921
 */
import type { Mocked } from 'vitest';
/** Minimal CLIExecutor interface for mocking. */
interface CLIExecutor {
    execute<T = unknown>(options: any): Promise<ExecutorResult<T>>;
    isAvailable(): boolean;
    setAvailable(v: boolean): void;
    getVersion(): Promise<string>;
    testConnection(): Promise<boolean>;
}
/** Executor result shape. */
interface ExecutorResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        exitCode?: number;
        message: string;
        details?: unknown;
        fix?: string;
        alternatives?: Array<{
            action: string;
            command: string;
        }>;
    };
    exitCode: number;
    stdout: string;
    stderr: string;
    duration: number;
}
/** Minimal Task type for test fixtures. */
interface Task {
    id: string;
    title: string;
    description?: string;
    status: string;
    created?: string;
    updated?: string;
    [key: string]: unknown;
}
/** Minimal task shape for search results. */
interface MinimalTask {
    id: string;
    title: string;
    status: string;
    [key: string]: unknown;
}
export type { CLIExecutor, ExecutorResult, Task, MinimalTask };
/**
 * Creates a mock CLIExecutor for testing
 */
export declare function createMockExecutor(): Mocked<CLIExecutor>;
/**
 * Creates a successful executor result
 */
export declare function createSuccessResult<T = any>(data: T, overrides?: Partial<ExecutorResult<T>>): ExecutorResult<T>;
/**
 * Creates an error executor result
 */
export declare function createErrorResult(code: string, message: string, exitCode?: number, overrides?: Partial<ExecutorResult<never>>): ExecutorResult<never>;
/**
 * Test Fixtures
 */
export declare const fixtures: {
    /**
     * Creates a mock Task object
     */
    task: (overrides?: Partial<Task>) => Task;
    /**
     * Creates a mock MinimalTask object
     */
    minimalTask: (overrides?: Partial<MinimalTask>) => MinimalTask;
    /**
     * Creates a mock session object
     */
    session: (overrides?: any) => any;
    /**
     * Creates a mock epic object
     */
    epic: (overrides?: Partial<Task>) => Task;
};
/**
 * Assertion helpers
 */
export declare const assertions: {
    /**
     * Assert response has proper metadata structure
     */
    assertResponseMetadata(response: any, domain: string, operation: string): void;
    /**
     * Assert error response structure
     */
    assertErrorResponse(response: any, expectedCode: string): void;
    /**
     * Assert success response structure
     */
    assertSuccessResponse(response: any): void;
};
/**
 * Mock builders for common test scenarios
 */
export declare const mocks: {
    /**
     * Mock successful task creation
     */
    taskCreation: (taskId?: string) => ExecutorResult<Task>;
    /**
     * Mock task not found error
     */
    taskNotFound: (taskId: string) => ExecutorResult<never>;
    /**
     * Mock validation error
     */
    validationError: (field: string) => ExecutorResult<never>;
    /**
     * Mock session start
     */
    sessionStart: (sessionId?: string) => ExecutorResult<any>;
    /**
     * Mock empty list
     */
    emptyList: () => ExecutorResult<never[]>;
    /**
     * Mock internal error
     */
    internalError: () => ExecutorResult<never>;
};
//# sourceMappingURL=utils.d.ts.map