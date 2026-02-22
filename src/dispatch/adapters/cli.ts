/**
 * CLI Adapter for the CQRS Dispatch Layer.
 *
 * Provides dispatchFromCli() — the single entry point for all CLI commands
 * that route through the dispatch pipeline. Also exports getCliDispatcher()
 * for commands needing custom output handling.
 *
 * @epic T4820
 * @task T4818
 */

import { randomUUID } from 'node:crypto';
import type { Gateway, DispatchResponse } from '../types.js';
import { Dispatcher } from '../dispatcher.js';
import { createDomainHandlers } from '../domains/index.js';
import { createSanitizer } from '../middleware/sanitizer.js';
import { getProjectRoot } from '../../core/paths.js';
import { cliOutput, cliError, type CliOutputOptions } from '../../cli/renderers/index.js';

// Reverse mapping from string error codes to numeric exit codes.
// Used when dispatch handlers return string error codes without exitCode.
const ERROR_CODE_TO_EXIT: Record<string, number> = {
  E_NOT_FOUND: 4,
  E_INVALID_INPUT: 2,
  E_FILE_ERROR: 3,
  E_DEPENDENCY: 5,
  E_VALIDATION: 6,
  E_RETRYABLE: 7,
  E_CONFIG_ERROR: 8,
  E_PARENT_NOT_FOUND: 10,
  E_DEPTH_EXCEEDED: 11,
  E_SIBLING_LIMIT: 12,
  E_CIRCULAR_DEP: 13,
  E_INVALID_PARENT_TYPE: 13,
  E_ORPHAN_DETECTED: 15,
  E_HAS_CHILDREN: 16,
  E_TASK_COMPLETED: 17,
  E_HAS_DEPENDENTS: 19,
  E_CHECKSUM_MISMATCH: 20,
  E_SESSION_EXISTS: 30,
  E_SESSION_NOT_FOUND: 31,
  E_SCOPE_CONFLICT: 32,
  E_FOCUS_REQUIRED: 38,
  E_INVALID_OPERATION: 2,
  E_MISSING_PARAMS: 2,
  E_NO_HANDLER: 1,
  E_INTERNAL: 1,
};

// ---------------------------------------------------------------------------
// Lazy singleton dispatcher
// ---------------------------------------------------------------------------

let _dispatcher: Dispatcher | null = null;

/**
 * Get or create the singleton CLI dispatcher.
 *
 * Creates a Dispatcher with all 9 domain handlers and sanitizer middleware.
 * No rate limiter — CLI is a single-user tool.
 */
export function getCliDispatcher(): Dispatcher {
  if (!_dispatcher) {
    _dispatcher = createCliDispatcher();
  }
  return _dispatcher;
}

/**
 * Factory: creates a Dispatcher with all domain handlers + sanitizer middleware.
 */
export function createCliDispatcher(): Dispatcher {
  const handlers = createDomainHandlers();
  return new Dispatcher({
    handlers,
    middlewares: [createSanitizer(() => getProjectRoot())],
  });
}

/**
 * Reset the singleton dispatcher (for testing).
 */
export function resetCliDispatcher(): void {
  _dispatcher = null;
}

// ---------------------------------------------------------------------------
// Main adapter function
// ---------------------------------------------------------------------------

/**
 * Build a DispatchRequest, dispatch it, and handle output/errors.
 *
 * This is the primary entry point for migrated CLI commands:
 *   await dispatchFromCli('query', 'tasks', 'show', { taskId }, { command: 'show' });
 *
 * On success: calls cliOutput(response.data, outputOpts)
 * On error: calls cliError(message, exitCode) + process.exit(exitCode)
 */
export async function dispatchFromCli(
  gateway: Gateway,
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
  outputOpts?: CliOutputOptions,
): Promise<void> {
  const dispatcher = getCliDispatcher();
  const response = await dispatcher.dispatch({
    gateway,
    domain,
    operation,
    params,
    source: 'cli',
    requestId: randomUUID(),
  });

  if (response.success) {
    const opts: CliOutputOptions = {
      command: outputOpts?.command ?? operation,
      operation: outputOpts?.operation ?? `${domain}.${operation}`,
      ...outputOpts,
    };
    cliOutput(response.data, opts);
  } else {
    // Derive exit code from the string error code when exitCode is not set
    const errorCode = response.error?.code ?? 'E_GENERAL';
    const exitCode = response.error?.exitCode
      ?? ERROR_CODE_TO_EXIT[errorCode]
      ?? 1;
    cliError(
      response.error?.message ?? 'Unknown error',
      exitCode,
      {
        name: errorCode,
        details: response.error?.details,
        fix: response.error?.fix,
      },
    );
    process.exit(exitCode);
  }
}

/**
 * Dispatch and return the raw response without handling output.
 *
 * For commands that need custom output logic (pagination, conditional
 * messages, etc.), call this instead of dispatchFromCli().
 */
export async function dispatchRaw(
  gateway: Gateway,
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
): Promise<DispatchResponse> {
  const dispatcher = getCliDispatcher();
  return dispatcher.dispatch({
    gateway,
    domain,
    operation,
    params,
    source: 'cli',
    requestId: randomUUID(),
  });
}
