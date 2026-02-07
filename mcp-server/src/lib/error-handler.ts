/**
 * Error handler for CLEO CLI operations
 *
 * @task T2913
 * @epic T2908
 *
 * Processes CLI errors, generates contextual fix commands,
 * and formats error responses with recovery suggestions.
 */

import {
  ExitCode,
  ErrorSeverity,
  ErrorCategory,
  getErrorMapping,
  isError,
  isRetryable,
  isNonRecoverable,
  isSuccess,
  generateFixCommand,
  generateSuggestions,
  type ErrorAlternative,
} from './exit-codes.js';

/**
 * CLI error context
 */
export interface CLIErrorContext {
  command: string;
  args: string[];
  stderr?: string;
  stdout?: string;
  details?: Record<string, string>;
}

/**
 * Formatted error response
 */
export interface FormattedError {
  code: string;
  name: string;
  exitCode: number;
  message: string;
  description: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  retryable: boolean;
  fix?: string;
  alternatives?: ErrorAlternative[];
  context?: Record<string, string>;
  documentation?: string;
}

/**
 * Handle CLI error and format response
 */
export function handleCLIError(
  exitCode: number,
  context: CLIErrorContext
): FormattedError {
  const mapping = getErrorMapping(exitCode);

  // Extract context from stderr/stdout
  const errorContext = extractErrorContext(exitCode, context);

  // Generate fix command
  const fix = generateFixCommand(exitCode, errorContext);

  // Generate alternatives
  const alternatives = generateSuggestions(exitCode, errorContext);

  return {
    code: mapping.code,
    name: mapping.name,
    exitCode,
    message: formatErrorMessage(exitCode, context, errorContext),
    description: mapping.description,
    category: mapping.category,
    severity: mapping.severity,
    retryable: mapping.retryable,
    fix,
    alternatives,
    context: errorContext,
    documentation: mapping.documentation,
  };
}

/**
 * Extract error context from CLI output
 */
function extractErrorContext(
  exitCode: number,
  context: CLIErrorContext
): Record<string, string> {
  const extracted: Record<string, string> = {
    command: context.command,
    ...context.details,
  };

  // Parse stderr for context clues
  if (context.stderr) {
    const stderr = context.stderr;

    // Extract task IDs
    const taskIdMatch = stderr.match(/T(\d+)/);
    if (taskIdMatch) {
      extracted.taskId = taskIdMatch[0];
    }

    // Extract parent IDs
    const parentMatch = stderr.match(/parent[:\s]+T(\d+)/i);
    if (parentMatch) {
      extracted.parentId = parentMatch[0].match(/T\d+/)?.[0] || '';
    }

    // Extract epic IDs
    const epicMatch = stderr.match(/epic[:\s]+T(\d+)/i);
    if (epicMatch) {
      extracted.epicId = epicMatch[0].match(/T\d+/)?.[0] || '';
    }

    // Extract session IDs
    const sessionMatch = stderr.match(/session[:\s]+([a-z0-9_]+)/i);
    if (sessionMatch) {
      extracted.sessionId = sessionMatch[1];
    }

    // Extract gate names
    const gateMatch = stderr.match(/gate[:\s]+(\w+)/i);
    if (gateMatch) {
      extracted.gateName = gateMatch[1];
    }

    // Extract agent names
    const agentMatch = stderr.match(/agent[:\s]+(\w+)/i);
    if (agentMatch) {
      extracted.agentName = agentMatch[1];
    }

    // Extract resource names
    const resourceMatch = stderr.match(/resource[:\s]+([^\s]+)/i);
    if (resourceMatch) {
      extracted.resource = resourceMatch[1];
    }

    // Extract query strings
    const queryMatch = stderr.match(/query[:\s]+"([^"]+)"/i);
    if (queryMatch) {
      extracted.query = queryMatch[1];
    }

    // Extract percentages
    const percentageMatch = stderr.match(/(\d+)%/);
    if (percentageMatch) {
      extracted.percentage = percentageMatch[1];
    }

    // Extract violations
    const violationsMatch = stderr.match(/violations?[:\s]+(.+)/i);
    if (violationsMatch) {
      extracted.violations = violationsMatch[1];
    }

    // Extract stages
    const stageMatch = stderr.match(/stage[:\s]+(\w+)/i);
    if (stageMatch) {
      extracted.stage = stageMatch[1];
    }

    // Extract missing stages
    const missingStagesMatch = stderr.match(/missing[:\s]+(.+)/i);
    if (missingStagesMatch) {
      extracted.missingStages = missingStagesMatch[1];
    }
  }

  return extracted;
}

/**
 * Format error message with context
 */
function formatErrorMessage(
  exitCode: number,
  context: CLIErrorContext,
  extracted: Record<string, string>
): string {
  const mapping = getErrorMapping(exitCode);

  // Start with base description
  let message = mapping.description;

  // Add context-specific details
  if (context.stderr) {
    // Try to extract first line of error message
    const firstLine = context.stderr.split('\n')[0].trim();
    if (firstLine && firstLine.length < 200) {
      message = firstLine;
    }
  }

  return message;
}

/**
 * Check if error is recoverable (can be fixed by user action)
 */
export function isRecoverable(exitCode: number): boolean {
  const mapping = getErrorMapping(exitCode);

  // Context errors require agent action, not user action
  if (mapping.category === ErrorCategory.CONTEXT) {
    return false;
  }

  // Verification locked errors cannot be recovered automatically
  if (exitCode === ExitCode.E_VERIFICATION_LOCKED) {
    return false;
  }

  // Cascade failures need manual intervention
  if (exitCode === ExitCode.E_CASCADE_FAILED) {
    return false;
  }

  // Session close blocked needs tasks to be completed first
  if (exitCode === ExitCode.E_SESSION_CLOSE_BLOCKED) {
    return false;
  }

  // Circular validation needs different agent
  if (exitCode === ExitCode.E_CIRCULAR_VALIDATION) {
    return false;
  }

  // Invalid lifecycle transitions cannot be recovered
  if (exitCode === ExitCode.E_LIFECYCLE_TRANSITION_INVALID) {
    return false;
  }

  // File errors and dependency errors are not recoverable
  if (
    exitCode === ExitCode.E_FILE_ERROR ||
    exitCode === ExitCode.E_DEPENDENCY_ERROR
  ) {
    return false;
  }

  // Circular references are not recoverable
  if (exitCode === ExitCode.E_CIRCULAR_REFERENCE) {
    return false;
  }

  // Most other errors are recoverable by user action
  return isError(exitCode);
}

/**
 * Format error for MCP response
 */
export function formatErrorForMCP(error: FormattedError): {
  success: false;
  error: {
    code: string;
    exitCode: number;
    message: string;
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: ErrorAlternative[];
  };
} {
  return {
    success: false,
    error: {
      code: error.code,
      exitCode: error.exitCode,
      message: error.message,
      details: {
        description: error.description,
        category: error.category,
        severity: error.severity,
        retryable: error.retryable,
        recoverable: isRecoverable(error.exitCode),
        context: error.context,
      },
      fix: error.fix,
      alternatives: error.alternatives,
    },
  };
}

/**
 * Add error context from operation details
 */
export function addErrorContext(
  context: CLIErrorContext,
  additionalDetails: Record<string, string>
): CLIErrorContext {
  return {
    ...context,
    details: {
      ...context.details,
      ...additionalDetails,
    },
  };
}

/**
 * Create error context from operation
 */
export function createErrorContext(
  command: string,
  args: string[],
  stderr?: string,
  stdout?: string,
  details?: Record<string, string>
): CLIErrorContext {
  return {
    command,
    args,
    stderr,
    stdout,
    details,
  };
}

/**
 * Error with exit code information for retry logic
 *
 * @task T3142
 */
export interface CLIError extends Error {
  exitCode: number;
}

/**
 * Result of a retried operation, including retry metadata
 *
 * @task T3142
 */
export interface RetryResult<T> {
  result: T;
  attempts: number;
  retriedExitCodes: number[];
}

/**
 * Default maximum retry attempts
 *
 * @task T3142
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Retry an operation with exponential backoff for retryable errors.
 *
 * Per MCP-SERVER-SPECIFICATION Section 9.1:
 * - Exit codes 7, 20-22, 60-63 support retry with exponential backoff
 * - Max 3 attempts by default
 * - Backoff: 2^attempt seconds
 * - Tracks retry count in response metadata
 *
 * Non-recoverable errors (Section 9.2) are never retried and
 * immediately rethrown.
 *
 * @task T3142
 */
export async function retryOperation<T>(
  fn: () => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS
): Promise<RetryResult<T>> {
  const retriedExitCodes: number[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return {
        result,
        attempts: attempt,
        retriedExitCodes,
      };
    } catch (error: unknown) {
      const exitCode = (error as CLIError)?.exitCode;

      // Non-recoverable errors must never be retried (Section 9.2)
      if (exitCode !== undefined && isNonRecoverable(exitCode)) {
        throw error;
      }

      // Non-retryable errors or last attempt: throw immediately
      if (
        exitCode === undefined ||
        !isRetryable(exitCode) ||
        attempt === maxAttempts
      ) {
        throw error;
      }

      // Track the retried exit code
      retriedExitCodes.push(exitCode);

      // Exponential backoff: 2^attempt seconds
      const delayMs = Math.pow(2, attempt) * 1000;
      await sleep(delayMs);
    }
  }

  // Should never reach here, but TypeScript requires it
  throw new Error('retryOperation: exhausted all attempts');
}

/**
 * Sleep for a given number of milliseconds
 *
 * @task T3142
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
