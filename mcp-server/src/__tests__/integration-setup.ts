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
 * @task T2922
 */

import { CLIExecutor, createExecutor } from '../lib/executor.js';
import path from 'path';
import fs from 'fs/promises';
import {
  createTestEnvironment,
  destroyTestEnvironment,
  type TestEnvironment,
} from './test-environment.js';

/**
 * Wrapped executor that automatically uses project root as cwd
 */
class WrappedExecutor {
  constructor(
    private executor: CLIExecutor,
    private defaultCwd: string
  ) {}

  async execute<T = unknown>(options: any): Promise<any> {
    // Always use project root as cwd unless explicitly overridden
    return this.executor.execute<T>({
      ...options,
      cwd: options.cwd || this.defaultCwd,
    });
  }

  async getVersion(): Promise<string> {
    return this.executor.getVersion();
  }

  async testConnection(): Promise<boolean> {
    return this.executor.testConnection();
  }
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
export async function setupIntegrationTest(): Promise<IntegrationTestContext> {
  // Create isolated test environment
  const testEnv = await createTestEnvironment();

  const cliPath = testEnv.cliPath;
  const projectRoot = testEnv.projectRoot;

  const executor = createExecutor(cliPath, 60000, 1); // 60s timeout, no retries

  // Verify CLI is accessible
  const canConnect = await executor.testConnection();
  if (!canConnect) {
    throw new Error(
      `Cannot connect to CLEO CLI at ${cliPath}. ` +
        `Ensure CLEO is installed and the path is correct. ` +
        `You can set CLEO_CLI_PATH environment variable to specify the CLI location.`
    );
  }

  // Wrap executor to automatically use the isolated project root as cwd
  const wrappedExecutor = new WrappedExecutor(executor, projectRoot);

  const testDataDir = path.join(projectRoot, '__test_data__');
  await fs.mkdir(testDataDir, { recursive: true });

  const sessionId = `test_session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  return {
    executor: wrappedExecutor,
    sessionId,
    epicId: testEnv.epicId,
    createdTaskIds: [...testEnv.taskIds],
    originalCwd: projectRoot,
    testDataDir,
    testEnv,
  };
}

/**
 * Cleanup integration test resources
 */
export async function cleanupIntegrationTest(context: IntegrationTestContext): Promise<void> {
  // End any active session
  try {
    await context.executor.execute({
      domain: 'session',
      operation: 'end',
      flags: { note: 'Test cleanup', json: true },
      maxRetries: 1,
      cwd: context.originalCwd,
    });
  } catch {
    // Ignore if session not active
  }

  // Destroy isolated test environment
  await destroyTestEnvironment(context.testEnv);
}

/**
 * Create a test task and track for cleanup
 */
export async function createTestTask(
  context: IntegrationTestContext,
  title: string,
  description: string,
  options?: {
    parent?: string;
    status?: string;
    priority?: string;
    labels?: string[];
  }
): Promise<string> {
  const result = await context.executor.execute<any>({
    domain: 'tasks',
    operation: 'add',
    args: [title],
    flags: {
      description,
      parent: options?.parent,
      status: options?.status || 'pending',
      priority: options?.priority,
      labels: options?.labels?.join(','),
      json: true,
    },
    sessionId: context.sessionId,
    cwd: context.originalCwd,
  });

  // CLEO CLI returns {success: true, task: {id: "T..."}} as payload.
  // The executor strips envelope fields and may unwrap single payload keys.
  // Handle both unwrapped (data = {id, ...}) and non-unwrapped (data = {task: {id, ...}}) cases.
  const taskId = result.data?.task?.id || result.data?.taskId || result.data?.id;

  if (!result.success || !taskId) {
    throw new Error(
      `Failed to create test task: ${result.error?.message || 'No task ID in response'}` +
      (result.stdout ? ` (stdout: ${result.stdout.substring(0, 200)})` : '')
    );
  }

  context.createdTaskIds.push(taskId);
  return taskId;
}

/**
 * Create a test epic (task without parent)
 */
export async function createTestEpic(
  context: IntegrationTestContext,
  title: string,
  description: string
): Promise<string> {
  const epicId = await createTestTask(context, title, description, {
    labels: ['epic'],
  });
  context.epicId = epicId;
  return epicId;
}

/**
 * Start a test session
 */
export async function startTestSession(
  context: IntegrationTestContext,
  epicId: string
): Promise<void> {
  const result = await context.executor.execute({
    domain: 'session',
    operation: 'start',
    flags: {
      scope: `epic:${epicId}`,
      'auto-focus': true,
      name: `Integration Test ${context.sessionId}`,
      json: true,
    },
    cwd: context.originalCwd,
  });

  if (!result.success) {
    // Session start may fail if enforcement is disabled - that's ok for tests
    if (result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed.sessionId || parsed.session?.sessionId) {
          context.sessionId = parsed.sessionId || parsed.session?.sessionId;
          return;
        }
      } catch {
        // Ignore parse errors
      }
    }
    // Don't throw - tests can work without sessions when enforcement is disabled
    return;
  }

  // Update context with the real session ID from CLEO
  if ((result.data as any)?.sessionId) {
    context.sessionId = (result.data as any).sessionId;
  } else if (result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      if (parsed.sessionId) {
        context.sessionId = parsed.sessionId;
      } else if (parsed.session?.sessionId) {
        context.sessionId = parsed.session.sessionId;
      }
    } catch {
      // Ignore parse errors - keep existing sessionId
    }
  }
}

/**
 * Get current CLEO version
 */
export async function getCleoVersion(executor: CLIExecutor | WrappedExecutor): Promise<string> {
  return executor.getVersion();
}

/**
 * Check if a task exists
 */
export async function taskExists(
  executor: CLIExecutor | WrappedExecutor,
  taskId: string,
  cwd?: string
): Promise<boolean> {
  const result = await executor.execute<{ exists: boolean }>({
    domain: 'tasks',
    operation: 'exists',
    args: [taskId],
    flags: { json: true },
    maxRetries: 1,
    cwd,
  });

  return result.success && result.data?.exists === true;
}

/**
 * Wait for a condition to be true (polling helper)
 */
export async function waitForCondition(
  condition: () => Promise<boolean>,
  options?: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
  }
): Promise<void> {
  const timeout = options?.timeout || 10000;
  const interval = options?.interval || 500;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    options?.errorMessage || `Condition not met within ${timeout}ms`
  );
}

/**
 * Capture audit log entries from the isolated test environment.
 * CLEO stores audit logs in .cleo/todo-log.jsonl as a JSON object with an "entries" array.
 */
export async function getAuditLogEntries(
  projectRootOrTestDataDir: string,
  filter?: {
    domain?: string;
    operation?: string;
    sessionId?: string;
    action?: string;
  }
): Promise<any[]> {
  // Try the given path directly, then try parent (in case testDataDir was passed)
  const candidates = [
    path.join(projectRootOrTestDataDir, '.cleo', 'todo-log.jsonl'),
    path.join(projectRootOrTestDataDir, '..', '.cleo', 'todo-log.jsonl'),
  ];

  for (const logPath of candidates) {
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const parsed = JSON.parse(content);
      let entries: any[] = parsed.entries || [];

      if (!filter) {
        return entries;
      }

      return entries.filter((entry: any) => {
        if (filter.action && entry.action !== filter.action) return false;
        // CLEO logs actions like "task_created", "task_updated" etc.
        // Match domain by checking if action contains the domain
        if (filter.domain && !entry.action?.includes(filter.domain)) return false;
        if (filter.operation && !entry.action?.includes(filter.operation)) return false;
        if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
        return true;
      });
    } catch {
      continue;
    }
  }

  return [];
}

/**
 * Create a manifest entry fixture
 */
export function createManifestEntry(taskId: string, overrides?: any): any {
  return {
    id: `${taskId}-integration-test`,
    file: `test-output/${taskId}.md`,
    title: `Integration Test Output for ${taskId}`,
    date: new Date().toISOString().split('T')[0],
    status: 'complete',
    agent_type: 'testing',
    topics: ['integration', 'testing', 'mcp'],
    key_findings: [
      'Gateway validation passed',
      'Domain routing successful',
      'CLI execution completed',
    ],
    actionable: true,
    needs_followup: [],
    linked_tasks: [taskId],
    ...overrides,
  };
}

/**
 * Verify response format matches specification
 */
export function verifyResponseFormat(
  response: any,
  expectedGateway: 'cleo_query' | 'cleo_mutate',
  expectedDomain: string,
  expectedOperation: string
): void {
  // Verify _meta structure
  expect(response._meta).toBeDefined();
  expect(response._meta.gateway).toBe(expectedGateway);
  expect(response._meta.domain).toBe(expectedDomain);
  expect(response._meta.operation).toBe(expectedOperation);
  expect(response._meta.version).toBeDefined();
  expect(response._meta.timestamp).toBeDefined();

  // Verify success field
  expect(typeof response.success).toBe('boolean');

  // If successful, should have data
  if (response.success) {
    expect(response.data).toBeDefined();
  } else {
    // If failed, should have error
    expect(response.error).toBeDefined();
    expect(response.error.code).toBeDefined();
    expect(response.error.message).toBeDefined();
  }
}

/**
 * Mock expect for TypeScript (when running without Jest in this context)
 */
function expect(value: any) {
  return {
    toBeDefined: () => {
      if (value === undefined || value === null) {
        throw new Error(`Expected value to be defined, got ${value}`);
      }
    },
    toBe: (expected: any) => {
      if (value !== expected) {
        throw new Error(`Expected ${value} to be ${expected}`);
      }
    },
  };
}
