/**
 * Test Utilities for Domain Handler Tests
 *
 * Provides mock factories, response builders, and test fixtures.
 *
 * @task T2921
 */

import type { CLIExecutor } from '../lib/executor.js';
import type { ExecutorResult } from '../lib/executor.js';
import type { Task, MinimalTask } from '../types/index.js';

/**
 * Creates a mock CLIExecutor for testing
 */
export function createMockExecutor(): jest.Mocked<CLIExecutor> {
  return {
    execute: jest.fn(),
    isAvailable: jest.fn().mockReturnValue(true),
    setAvailable: jest.fn(),
    getVersion: jest.fn(),
    testConnection: jest.fn(),
  } as any;
}

/**
 * Creates a successful executor result
 */
export function createSuccessResult<T = any>(
  data: T,
  overrides?: Partial<ExecutorResult<T>>
): ExecutorResult<T> {
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
export function createErrorResult(
  code: string,
  message: string,
  exitCode: number = 1,
  overrides?: Partial<ExecutorResult<never>>
): ExecutorResult<never> {
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
  task: (overrides?: Partial<Task>): Task => ({
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
  minimalTask: (overrides?: Partial<MinimalTask>): MinimalTask => ({
    id: 'T2921',
    title: 'Test task',
    status: 'active',
    ...overrides,
  }),

  /**
   * Creates a mock session object
   */
  session: (overrides?: any) => ({
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
  epic: (overrides?: Partial<Task>): Task => ({
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
  assertResponseMetadata(response: any, domain: string, operation: string) {
    expect(response._meta).toBeDefined();
    expect(response._meta.domain).toBe(domain);
    expect(response._meta.operation).toBe(operation);
    expect(response._meta.version).toBe('1.0.0');
    expect(response._meta.timestamp).toBeDefined();
    expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
  },

  /**
   * Assert error response structure
   */
  assertErrorResponse(response: any, expectedCode: string) {
    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(expectedCode);
    expect(response.error.message).toBeDefined();
  },

  /**
   * Assert success response structure
   */
  assertSuccessResponse(response: any) {
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
  taskCreation: (taskId: string = 'T2921') =>
    createSuccessResult(fixtures.task({ id: taskId })),

  /**
   * Mock task not found error
   */
  taskNotFound: (taskId: string) =>
    createErrorResult('E_NOT_FOUND', `Task ${taskId} not found`, 4),

  /**
   * Mock validation error
   */
  validationError: (field: string) =>
    createErrorResult(
      'E_INVALID_INPUT',
      `${field} is required`,
      6
    ),

  /**
   * Mock session start
   */
  sessionStart: (sessionId: string = 'session_123') =>
    createSuccessResult(fixtures.session({ id: sessionId })),

  /**
   * Mock empty list
   */
  emptyList: () => createSuccessResult([]),

  /**
   * Mock internal error
   */
  internalError: () =>
    createErrorResult('E_INTERNAL_ERROR', 'Internal server error', 1),
};
