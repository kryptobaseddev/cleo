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
/**
 * Creates a mock CLIExecutor for testing
 */
export function createMockExecutor() {
    return {
        execute: vi.fn(),
        isAvailable: vi.fn().mockReturnValue(true),
        setAvailable: vi.fn(),
        getVersion: vi.fn(),
        testConnection: vi.fn(),
    };
}
/**
 * Creates a successful executor result
 */
export function createSuccessResult(data, overrides) {
    return {
        success: true,
        data,
        exitCode: 0,
        stdout: typeof data === 'string' ? data : JSON.stringify(data),
        stderr: '',
        duration: 50,
        ...overrides,
    };
}
/**
 * Creates an error executor result
 */
export function createErrorResult(code, message, exitCode = 1, overrides) {
    return {
        success: false,
        error: {
            code,
            exitCode,
            message,
        },
        exitCode,
        stdout: '',
        stderr: message,
        duration: 50,
        ...overrides,
    };
}
/**
 * Test Fixtures
 */
export const fixtures = {
    /**
     * Creates a mock Task object
     */
    task: (overrides) => ({
        id: 'T2921',
        title: 'Test task',
        description: 'Test description',
        status: 'active',
        created: '2026-02-03',
        updated: '2026-02-03',
        ...overrides,
    }),
    /**
     * Creates a mock MinimalTask object
     */
    minimalTask: (overrides) => ({
        id: 'T2921',
        title: 'Test task',
        status: 'active',
        ...overrides,
    }),
    /**
     * Creates a mock session object
     */
    session: (overrides) => ({
        id: 'session_123',
        name: 'Test Session',
        scope: 'epic:T2908',
        started: '2026-02-03T12:00:00Z',
        status: 'active',
        ...overrides,
    }),
    /**
     * Creates a mock epic object
     */
    epic: (overrides) => ({
        id: 'T2908',
        title: 'Test Epic',
        description: 'Epic description',
        status: 'active',
        created: '2026-02-03',
        updated: '2026-02-03',
        ...overrides,
    }),
};
/**
 * Assertion helpers
 */
export const assertions = {
    /**
     * Assert response has proper metadata structure
     */
    assertResponseMetadata(response, domain, operation) {
        expect(response._meta).toBeDefined();
        expect(response._meta.domain).toBe(domain);
        expect(response._meta.operation).toBe(operation);
        expect(response._meta.specVersion).toBe('1.2.3');
        expect(response._meta.timestamp).toBeDefined();
        expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
    },
    /**
     * Assert error response structure
     */
    assertErrorResponse(response, expectedCode) {
        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(expectedCode);
        expect(response.error.message).toBeDefined();
    },
    /**
     * Assert success response structure
     */
    assertSuccessResponse(response) {
        expect(response.success).toBe(true);
        expect(response.data).toBeDefined();
    },
};
/**
 * Mock builders for common test scenarios
 */
export const mocks = {
    /**
     * Mock successful task creation
     */
    taskCreation: (taskId = 'T2921') => createSuccessResult(fixtures.task({ id: taskId })),
    /**
     * Mock task not found error
     */
    taskNotFound: (taskId) => createErrorResult('E_NOT_FOUND', `Task ${taskId} not found`, 4),
    /**
     * Mock validation error
     */
    validationError: (field) => createErrorResult('E_INVALID_INPUT', `${field} is required`, 6),
    /**
     * Mock session start
     */
    sessionStart: (sessionId = 'session_123') => createSuccessResult(fixtures.session({ id: sessionId })),
    /**
     * Mock empty list
     */
    emptyList: () => createSuccessResult([]),
    /**
     * Mock internal error
     */
    internalError: () => createErrorResult('E_INTERNAL_ERROR', 'Internal server error', 1),
};
//# sourceMappingURL=utils.js.map