/**
 * E2E Retry Scenario Tests (MCP Spec Section 9.1)
 *
 * Tests retry behavior for recoverable vs non-recoverable exit codes.
 *
 * @task T5200
 * @epic T3125
 */

import { describe, expect, it } from 'vitest';
import { ExitCode, isRecoverableCode } from '../../../src/types/exit-codes.js';

// CLIError interface for errors with exit codes
interface CLIError extends Error {
  exitCode?: number;
}

/**
 * Retry operation result tracking attempts and retried exit codes
 */
interface RetryResult<T> {
  attempts: number;
  retriedExitCodes: number[];
  result: T;
}

/**
 * Executes an operation with retry logic for recoverable errors.
 * Tracks attempts and which exit codes triggered retries.
 *
 * @param operation - Async operation to execute
 * @param maxAttempts - Maximum number of retry attempts (default: 3)
 * @returns RetryResult with attempts count, retried exit codes, and final result
 * @throws Error if max attempts exceeded or non-recoverable error encountered
 */
async function retryOperation<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
): Promise<RetryResult<T>> {
  const retriedExitCodes: number[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      return {
        attempts: attempt,
        retriedExitCodes,
        result,
      };
    } catch (error) {
      const cliError = error as CLIError;
      const exitCode = cliError.exitCode ?? ExitCode.GENERAL_ERROR;

      // Check if error is recoverable (retryable)
      const isRecoverable = isRecoverableCode(exitCode as ExitCode);

      // If not recoverable or last attempt, throw the error
      if (!isRecoverable || attempt === maxAttempts) {
        throw error;
      }

      // Track the exit code that triggered a retry
      retriedExitCodes.push(exitCode);

      // Simulate backoff delay (minimal for tests)
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error('Retry logic exhausted without result or error');
}

describe('9.1 Retry Scenario', () => {
  it('should retry on retryable exit code (lock timeout, exit 7)', async () => {
    let attempts = 0;

    const result = await retryOperation(async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error('Lock timeout') as CLIError;
        error.exitCode = ExitCode.LOCK_TIMEOUT; // 7 - retryable
        throw error;
      }
      return { success: true, data: { taskId: 'T2405' } };
    }, 3);

    expect(result.attempts).toBe(3);
    expect(result.retriedExitCodes).toEqual([7, 7]);
    expect(result.result).toEqual({ success: true, data: { taskId: 'T2405' } });
  });

  it('should retry on concurrent modification (exit 21)', async () => {
    let attempts = 0;

    const result = await retryOperation(async () => {
      attempts++;
      if (attempts === 1) {
        const error = new Error('Concurrent modification') as CLIError;
        error.exitCode = ExitCode.CONCURRENT_MODIFICATION; // 21 - retryable
        throw error;
      }
      return { success: true, data: { updated: true } };
    }, 3);

    expect(result.attempts).toBe(2);
    expect(result.retriedExitCodes).toEqual([21]);
  });

  it('should NOT retry non-recoverable errors (exit 80 - lifecycle gate)', async () => {
    await expect(
      retryOperation(async () => {
        const error = new Error('Lifecycle gate failed') as CLIError;
        error.exitCode = ExitCode.LIFECYCLE_GATE_FAILED; // 80 - non-recoverable
        throw error;
      }, 3),
    ).rejects.toThrow('Lifecycle gate failed');
  });

  it('should NOT retry non-retryable errors (exit 4 - not found)', async () => {
    await expect(
      retryOperation(async () => {
        const error = new Error('Task not found') as CLIError;
        error.exitCode = ExitCode.NOT_FOUND; // 4 - not retryable
        throw error;
      }, 3),
    ).rejects.toThrow('Task not found');
  });

  it('should exhaust max attempts on persistent retryable error', async () => {
    await expect(
      retryOperation(async () => {
        const error = new Error('Still locked') as CLIError;
        error.exitCode = ExitCode.LOCK_TIMEOUT; // 7 - retryable but persistent
        throw error;
      }, 3),
    ).rejects.toThrow('Still locked');
  });
});
