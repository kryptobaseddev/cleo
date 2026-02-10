/**
 * E2E Test Setup and Teardown
 *
 * Provides setup/teardown utilities for end-to-end workflow tests
 * that simulate real-world MCP server usage scenarios.
 *
 * @task T2937
 */

import { setupIntegrationTest, cleanupIntegrationTest, IntegrationTestContext } from '../integration-setup.js';

/**
 * Global test context shared across E2E tests
 */
let globalContext: IntegrationTestContext | null = null;

/**
 * Setup E2E test environment
 *
 * Creates a fresh integration test context with:
 * - CLI executor configured
 * - Test session initialized
 * - Cleanup tracking enabled
 */
export async function setupE2ETest(): Promise<IntegrationTestContext> {
  if (globalContext) {
    throw new Error('E2E test context already initialized. Call cleanupE2ETest() first.');
  }

  globalContext = await setupIntegrationTest();
  return globalContext;
}

/**
 * Cleanup E2E test environment
 *
 * Archives all created tasks, ends session, removes test data
 */
export async function cleanupE2ETest(): Promise<void> {
  if (!globalContext) {
    return;
  }

  await cleanupIntegrationTest(globalContext);
  globalContext = null;
}

/**
 * Get current E2E test context
 */
export function getE2EContext(): IntegrationTestContext {
  if (!globalContext) {
    throw new Error('E2E test context not initialized. Call setupE2ETest() first.');
  }
  return globalContext;
}

/**
 * Extract task ID from operation result
 */
export function extractTaskId(result: any): string {
  if (!result.success) {
    throw new Error(`Operation failed: ${result.error?.message || 'Unknown error'}`);
  }

  // Handle multiple response shapes from CLEO CLI:
  // - Single field unwrapped: data = {id, title, ...}
  // - Multiple fields: data = {task: {id,...}, duplicate: true, ...}
  // - Direct taskId: data = {taskId: "T123"}
  const taskId =
    result.data?.taskId ||
    result.data?.id ||
    result.data?.task?.id;
  if (!taskId) {
    throw new Error(`No task ID found in result`);
  }

  return taskId;
}

/**
 * Extract session ID from operation result
 */
export function extractSessionId(result: any): string {
  if (!result.success) {
    throw new Error(`Operation failed: ${result.error?.message || 'Unknown error'}`);
  }

  // Handle multiple response shapes from CLEO CLI:
  // - session start: data = {sessionId, scope, ...}
  // - session status: data = {session: {sessionId,...}}
  const sessionId =
    result.data?.sessionId ||
    result.data?.id ||
    result.data?.session?.sessionId ||
    result.data?.session?.id;
  if (!sessionId) {
    throw new Error('No session ID found in result');
  }

  return sessionId;
}

/**
 * Verify response format matches specification
 *
 * E2E tests run through the CLI executor which returns ExecutorResult,
 * not the full MCP gateway response. The gateway/domain/operation params
 * are accepted for API compatibility but not validated against the
 * executor result (which lacks MCP envelope metadata).
 */
export function verifyResponseFormat(
  response: any,
  _expectedGateway: 'cleo_query' | 'cleo_mutate',
  _expectedDomain: string,
  _expectedOperation: string
): void {
  // Verify success field exists
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
 * Wait for condition to be true with timeout
 */
export async function waitFor(
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

  throw new Error(options?.errorMessage || `Condition not met within ${timeout}ms`);
}

/**
 * Sleep helper for timing-dependent tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
