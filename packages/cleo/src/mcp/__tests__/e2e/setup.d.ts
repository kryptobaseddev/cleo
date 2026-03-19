/**
 * E2E Test Setup and Teardown
 *
 * Provides setup/teardown utilities for end-to-end workflow tests
 * that simulate real-world MCP server usage scenarios.
 *
 * @task T2937
 */
import { type IntegrationTestContext } from '../integration-setup.js';
/**
 * Extract data payload from an ExecutorResult, handling LAFS envelope.
 *
 * When the executor can't unwrap the LAFS `result` field, ExecutorResult.data
 * may contain the full LAFS envelope. Detect and unwrap that case.
 */
export declare function getResponseData(result: any): any;
/**
 * Setup E2E test environment
 *
 * Creates a fresh integration test context with:
 * - CLI executor configured
 * - Test session initialized
 * - Cleanup tracking enabled
 */
export declare function setupE2ETest(): Promise<IntegrationTestContext>;
/**
 * Cleanup E2E test environment
 *
 * Archives all created tasks, ends session, removes test data
 */
export declare function cleanupE2ETest(): Promise<void>;
/**
 * Get current E2E test context
 */
export declare function getE2EContext(): IntegrationTestContext;
/**
 * Extract task ID from operation result
 */
export declare function extractTaskId(result: any): string;
/**
 * Extract session ID from operation result
 */
export declare function extractSessionId(result: any): string;
/**
 * Verify response format matches specification
 *
 * E2E tests run through the CLI executor which returns ExecutorResult,
 * not the full MCP gateway response. The gateway/domain/operation params
 * are accepted for API compatibility but not validated against the
 * executor result (which lacks MCP envelope metadata).
 */
export declare function verifyResponseFormat(
  response: any,
  _expectedGateway: 'query' | 'mutate',
  _expectedDomain: string,
  _expectedOperation: string,
): void;
/**
 * Wait for condition to be true with timeout
 */
export declare function waitFor(
  condition: () => Promise<boolean>,
  options?: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
  },
): Promise<void>;
/**
 * Sleep helper for timing-dependent tests
 */
export declare function sleep(ms: number): Promise<void>;
//# sourceMappingURL=setup.d.ts.map
